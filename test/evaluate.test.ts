import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import {
  aggregate,
  discoverMergedPrs,
  formatMarkdown,
  holdout,
  mergedPrNumber,
  parseFirstParentLog,
  scorePlan,
} from '../src/evaluate.js';
import type { EvaluationReport, PrResult } from '../src/evaluate.js';
import { DEFAULT_CONFIG, withDefaults } from '../src/inputs.js';
import { buildContext } from '../src/run.js';
import type { SuitePlan } from '../src/types.js';

function plan(partial: Partial<SuitePlan>): SuitePlan {
  return {
    suite: 'vitest',
    mode: 'selected',
    reason: 'jev',
    selected: [],
    selectedCount: 0,
    totalCount: 10,
    probabilities: {},
    reasons: {},
    command: '',
    fullCommand: '',
    model: 'm',
    cacheHit: false,
    dryRun: false,
    ...partial,
  };
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'testscope-eval-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@example.test');
  sh(dir, 'config', 'user.name', 't');
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(dir, 'src/a.test.ts'), 'test a v1\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'init');
  await writeFile(path.join(dir, 'src/a.ts'), 'export const a = 2;\n');
  await writeFile(path.join(dir, 'src/a.test.ts'), 'test a v2\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'Fix a (#12)');
  return dir;
}

describe('mergedPrNumber', () => {
  it('reads squash and merge subjects', () => {
    expect(mergedPrNumber('Fix thing (#12)', 1)).toBe('12');
    expect(mergedPrNumber('Merge pull request #12 from x/y', 2)).toBe('12');
  });

  it('rejects non-PR subjects and parent-count mismatches', () => {
    expect(mergedPrNumber('Fix thing', 1)).toBeNull();
    expect(mergedPrNumber('Fix thing (#12) again', 1)).toBeNull();
    expect(mergedPrNumber('Merge pull request #12 from x/y', 1)).toBeNull();
    expect(mergedPrNumber('Fix thing (#12)', 2)).toBeNull();
    expect(mergedPrNumber('Fix thing (#12)', 0)).toBeNull();
    expect(mergedPrNumber('Merge pull request #12 from x/y', 0)).toBeNull();
  });
});

describe('history discovery', () => {
  it('parses first-parent log records', () => {
    const records = parseFirstParentLog('c1\0p1 p2\0Merge pull request #3 from a/b\nc0\0\0root\n');
    expect(records).toEqual([
      { commit: 'c1', parents: ['p1', 'p2'], subject: 'Merge pull request #3 from a/b' },
      { commit: 'c0', parents: [], subject: 'root' },
    ]);
  });

  it('finds squash PRs with their changed files', async () => {
    const repo = await makeRepo();
    const history = await discoverMergedPrs(repo, 'main', 5);
    expect(history.prs.map((pr) => pr.number)).toEqual([12]);
    expect(history.prs[0]?.changedFiles.sort()).toEqual(['src/a.test.ts', 'src/a.ts']);
    expect(history.historyExhausted).toBe(true);
  });
});

describe('holdout', () => {
  it('removes truth files from changedFiles and the patch', async () => {
    const repo = await makeRepo();
    const ctx = await buildContext({
      suite: 'vitest',
      repoRoot: repo,
      baseRef: 'HEAD~1',
      headRef: 'HEAD',
      inputs: withDefaults({}),
    });
    expect(ctx.patch).toContain('a.test.ts');
    const held = await holdout(ctx, ['src/a.test.ts']);
    expect(held?.changedFiles).toEqual(['src/a.ts']);
    expect(held?.patch).toContain('src/a.ts');
    expect(held?.patch).not.toContain('a.test.ts');
    expect(await holdout(ctx, ctx.changedFiles)).toBeNull();
  });
});

describe('metrics', () => {
  const results: PrResult[] = [
    scorePlan(1, 'vitest', ['t1', 't2'], plan({ selected: ['t1'], selectedCount: 1, probabilities: { t1: 0.9, t2: 0.1 } })),
    scorePlan(2, 'vitest', ['t3'], plan({ mode: 'full', reason: 'jev-uncertain', totalCount: 10, probabilities: { t3: 0.5 } })),
    scorePlan(3, 'vitest', ['t4'], plan({ mode: 'none', reason: 'no-relevant-changes', totalCount: 10 })),
  ];

  it('scores hits per mode', () => {
    expect(results[0]?.hits).toEqual(['t1']);
    expect(results[0]?.misses).toEqual(['t2']);
    expect(results[0]?.missedP).toEqual([0.1]);
    expect(results[1]?.hits).toEqual(['t3']);
    expect(results[2]?.misses).toEqual(['t4']);
    expect(results.map((r) => r.reachedJev)).toEqual([true, true, false]);
  });

  it('computes recall, reduction and miss details', () => {
    const metrics = aggregate('vitest', results);
    expect(metrics.recall).toBeCloseTo(2 / 4);
    // selected 1 + full 10 + none 0 of 30 total
    expect(metrics.reduction).toBeCloseTo(1 - 11 / 30);
    expect(metrics.misses).toEqual([
      { pr: 1, test: 't2' },
      { pr: 3, test: 't4' },
    ]);
    expect(metrics.modes).toEqual({ selected: 1, full: 1, none: 1 });
    expect(metrics.jevReached).toBe(2);
    expect(metrics.meanP).toBeCloseTo(0.1);
  });

  it('renders the table, misses and limitations', () => {
    const report: EvaluationReport = {
      schemaVersion: 1,
      ref: 'origin/main',
      tip: 'a'.repeat(40),
      count: 3,
      historyExhausted: false,
      config: DEFAULT_CONFIG,
      suites: [aggregate('vitest', results)],
      results,
    };
    const markdown = formatMarkdown(report);
    expect(markdown).toContain('| Suite | PRs (Jev-reached) | Recall | Misses | Reduction | Modes |');
    expect(markdown).toContain('| vitest | 3 (2) | 50.0% (2/4) | 2 | 63.3% | full:1 none:1 selected:1 |');
    expect(markdown).toContain('- vitest: #1 `t2`');
    expect(markdown).toContain('Recall proxy: tests changed in the same PR, held out from the diff.');
  });
});

describe('cli', () => {
  it('evaluate without a key exits 2', async () => {
    const repo = await makeRepo();
    const errors: string[] = [];
    const code = await main(['evaluate', '--suites', 'vitest'], {}, { cwd: repo, stderr: (t) => errors.push(t) });
    expect(code).toBe(2);
    expect(errors.join('')).toContain('TYPESAFE_API_KEY');
  });

  it('never accepts the key as a flag', async () => {
    const repo = await makeRepo();
    const code = await main(['select', '--typesafe-api-key', 'x'], {}, { cwd: repo, stderr: () => undefined });
    expect(code).toBe(2);
  });
});
