import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ExecutionGroup } from '../plan.ts';
import type { Runner } from '../runner.ts';
import type { Manifest, RunnerConfig } from '../types.ts';

const exec = promisify(execFile);

/** Execution flags callers may pass through; selection flags (files, projects, grep) stay owned by testscope. */
export const PASSTHROUGH =
  /^--(?:workers|repeat-each|reporter|trace|headed|list|max-failures|timeout|retries)(?:=|$)/;

export interface Invocation {
  args: string[];
  env: Record<string, string>;
}

const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function validateExtraArgs(extra: string[]) {
  const bad = extra.find((a) => !PASSTHROUGH.test(a));
  if (bad)
    throw new Error(
      `Unsupported runner option ${bad}; use --flag=value for execution options only`,
    );
}

/** Pure: turn execution groups into Playwright CLI invocations (without the node/cli prefix). */
export function buildInvocations(
  groups: ExecutionGroup[],
  opts: {
    root: string;
    runner: RunnerConfig;
    manifest: Manifest;
    workers: number;
    extraArgs?: string[];
  },
): Invocation[] {
  const extra = opts.extraArgs ?? [];
  validateExtraArgs(extra);
  const out = opts.runner.outputDir ?? 'test-results/testscope';
  const workers = extra.some((a) => a.startsWith('--workers')) ? [] : [`--workers=${opts.workers}`];
  return groups.map((g, i) => {
    const env: Record<string, string> = {};
    if (opts.runner.projectsEnv) {
      const groupsUsed = [
        ...new Set(g.specs.map((s) => opts.manifest[s]?.group).filter(Boolean)),
      ].sort();
      env[opts.runner.projectsEnv] = groupsUsed.join(',');
    }
    return {
      env,
      args: [
        'test',
        ...g.specs.map((s) => `${escapeRegex(path.join(opts.root, s))}$`),
        ...(opts.runner.projects ?? []).map((p) => `--project=${p}`),
        `--output=${out}/run-${i}`,
        ...(g.smokeOnly && opts.runner.smokeGrep ? [`--grep=${opts.runner.smokeGrep}`] : []),
        ...workers,
        ...extra,
      ],
    };
  });
}

interface Suite {
  specs?: { file: string }[];
  suites?: Suite[];
}

/** Pure: spec files (root-relative) from a `--list --reporter=json` report. */
export function reportSpecs(
  report: { suites?: Suite[]; errors?: unknown[]; config?: { rootDir?: string } },
  root: string,
) {
  if (report.errors?.length) throw new Error('Playwright collection failed');
  const testDir = report.config?.rootDir ?? root;
  const files = new Set<string>();
  const visit = (s: Suite) => {
    for (const spec of s.specs ?? [])
      files.add(path.relative(root, path.resolve(testDir, spec.file)).split(path.sep).join('/'));
    for (const c of s.suites ?? []) visit(c);
  };
  for (const s of report.suites ?? []) visit(s);
  return [...files].sort();
}

export class PlaywrightRunner implements Runner {
  readonly name = 'playwright';
  private readonly opts: {
    root: string;
    runner: RunnerConfig;
    manifest: Manifest;
    workers: number;
  };
  constructor(opts: { root: string; runner: RunnerConfig; manifest: Manifest; workers: number }) {
    this.opts = opts;
  }

  cli(): string {
    const req = createRequire(path.join(this.opts.root, 'package.json'));
    for (const id of ['playwright/cli.js', '@playwright/test/cli.js']) {
      try {
        return req.resolve(id);
      } catch {}
    }
    throw new Error('Playwright is not installed in the test root');
  }

  async listChanged(base: string): Promise<string[]> {
    const { stdout } = await exec(
      process.execPath,
      [this.cli(), 'test', `--only-changed=${base}`, '--list', '--reporter=json'],
      {
        cwd: this.opts.root,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    return reportSpecs(JSON.parse(stdout), this.opts.root);
  }

  async run(
    groups: ExecutionGroup[],
    { extraArgs }: { workers: number; extraArgs: string[] },
  ): Promise<number> {
    const cli = this.cli();
    for (const inv of buildInvocations(groups, { ...this.opts, extraArgs })) {
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...inv.args], {
          cwd: this.opts.root,
          env: { ...process.env, ...inv.env },
          stdio: 'inherit',
        });
        child.on('error', reject);
        child.on('exit', (c) => resolve(c ?? 1));
      });
      if (code) return code;
    }
    return 0;
  }
}
