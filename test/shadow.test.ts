import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { applyPolicyFlags } from '../src/commands/policy.ts';
import { toPlanFile } from '../src/plan-file.ts';
import { buildPlan } from '../src/plan.ts';
import {
  appendHistory,
  failedSpecs,
  formatShadow,
  readHistory,
  shadowResult,
  summarize,
} from '../src/shadow.ts';
import { config, manifest, mod } from './helpers.ts';

const plan = toPlanFile(
  buildPlan({ config: config(), manifest, changes: mod('web/src/users/a.ts') }),
  'b',
  'h'.repeat(40),
);

test('policy flags override and are validated', () => {
  const c = applyPolicyFlags(config(), { 'on-unmapped': 'fail', 'max-specs': '3' });
  assert.equal(c.policy.onUnmapped, 'fail');
  assert.equal(c.policy.maxSpecs, 3);
  assert.equal(c.policy.onJudgeError, 'smoke');
  assert.throws(() => applyPolicyFlags(config(), { 'on-unmapped': 'maybe' }), /onUnmapped/);
  assert.throws(() => applyPolicyFlags(config(), { 'max-specs': '0' }), /maxSpecs/);
});

test('failedSpecs reads Playwright JSON reports and generic lists', () => {
  const report = {
    config: { rootDir: '/r/web/e2e' },
    suites: [
      {
        specs: [
          { file: 'users/list.spec.ts', ok: false },
          { file: 'shell/home.spec.ts', ok: true, tests: [{ status: 'expected' }] },
        ],
        suites: [
          { specs: [{ file: 'billing/invoices.spec.ts', tests: [{ status: 'unexpected' }] }] },
        ],
      },
    ],
  };
  assert.deepEqual(failedSpecs(report, '/r/web'), [
    'e2e/billing/invoices.spec.ts',
    'e2e/users/list.spec.ts',
  ]);
  assert.deepEqual(failedSpecs({ failed: ['b', 'a', 'a'] }, '/r'), ['a', 'b']);
});

test('shadow results count misses and smoke-only failures', () => {
  const r = shadowResult(plan, ['e2e/billing/invoices.spec.ts', 'e2e/users/list.spec.ts']);
  assert.deepEqual(r.missed, ['e2e/billing/invoices.spec.ts']);
  assert.deepEqual(r.smokeOnlyFailures, []);
  const smoke = toPlanFile(
    buildPlan({ config: config(), manifest, changes: mod('web/src/misc.ts') }),
    'b',
    'h',
  );
  assert.deepEqual(shadowResult(smoke, ['e2e/shell/home.spec.ts']).smokeOnlyFailures, [
    'e2e/shell/home.spec.ts',
  ]);
});

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('history round-trips and summarizes to a miss rate', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'testscope-shadow-'));
  dirs.push(dir);
  const file = path.join(dir, 'h.jsonl');
  await appendHistory(
    file,
    shadowResult(plan, ['e2e/billing/invoices.spec.ts', 'e2e/users/list.spec.ts']),
  );
  await appendHistory(file, shadowResult(plan, []));
  const results = await readHistory(file);
  const s = summarize(results);
  assert.deepEqual(
    {
      runs: s.runs,
      withFailures: s.runsWithFailures,
      misses: s.runsWithMisses,
      rate: s.missRate,
      savings: s.savings,
    },
    { runs: 2, withFailures: 1, misses: 1, rate: 0.5, savings: 0.6 },
  );
  assert.match(formatShadow(s, results), /Miss rate: \*\*50\.0%\*\*/);
  assert.deepEqual(summarize([]).missRate, 0);
});
