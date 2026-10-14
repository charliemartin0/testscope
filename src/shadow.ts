import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PlanFile } from './plan-file.ts';

interface PwSuite {
  file?: string;
  specs?: { file: string; ok?: boolean; tests?: { status?: string }[] }[];
  suites?: PwSuite[];
}

/**
 * Failing spec files from a full-suite run. Accepts a Playwright JSON report
 * (`--reporter=json`) or a generic `{ "failed": ["<spec>", ...] }` list. Paths are root-relative.
 */
export function failedSpecs(report: unknown, root: string): string[] {
  const r = report as { failed?: unknown; suites?: PwSuite[]; config?: { rootDir?: string } };
  if (Array.isArray(r.failed)) return [...new Set(r.failed.map(String))].sort();
  const testDir = r.config?.rootDir ?? root;
  const out = new Set<string>();
  const visit = (s: PwSuite) => {
    for (const spec of s.specs ?? []) {
      const bad = spec.ok === false || spec.tests?.some((t) => t.status === 'unexpected');
      if (bad)
        out.add(path.relative(root, path.resolve(testDir, spec.file)).split(path.sep).join('/'));
    }
    for (const c of s.suites ?? []) visit(c);
  };
  for (const s of r.suites ?? []) visit(s);
  return [...out].sort();
}

export interface ShadowResult {
  head: string;
  mode: PlanFile['mode'];
  selected: number;
  total: number;
  failed: string[];
  /** Failing specs the plan would not have run. */
  missed: string[];
  /** Failing specs selected only in smoke mode (non-smoke tests in them would not have run). */
  smokeOnlyFailures: string[];
}

/** Compare a plan with the outcome of a full run of the same commit. */
export function shadowResult(plan: PlanFile, failed: string[]): ShadowResult {
  const sel = new Set(plan.selected);
  return {
    head: plan.head,
    mode: plan.mode,
    selected: plan.selected.length,
    total: plan.total,
    failed,
    missed: failed.filter((s) => !sel.has(s)),
    smokeOnlyFailures: plan.smokeOnly ? failed.filter((s) => sel.has(s)) : [],
  };
}

export interface ShadowSummary {
  runs: number;
  runsWithFailures: number;
  runsWithMisses: number;
  failedSpecs: number;
  missedSpecs: number;
  /** Fraction of failing spec occurrences the plans would not have run. */
  missRate: number;
  /** Fraction of spec executions avoided. */
  savings: number;
}

export function summarize(results: ShadowResult[]): ShadowSummary {
  const sum = (f: (r: ShadowResult) => number) => results.reduce((a, r) => a + f(r), 0);
  const failedSpecs = sum((r) => r.failed.length);
  const missedSpecs = sum((r) => r.missed.length);
  const total = sum((r) => r.total);
  return {
    runs: results.length,
    runsWithFailures: results.filter((r) => r.failed.length).length,
    runsWithMisses: results.filter((r) => r.missed.length).length,
    failedSpecs,
    missedSpecs,
    missRate: failedSpecs ? missedSpecs / failedSpecs : 0,
    savings: total ? 1 - sum((r) => r.selected) / total : 0,
  };
}

export function formatShadow(summary: ShadowSummary, results: ShadowResult[]): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    '## testscope shadow report',
    '',
    `Runs: **${summary.runs}** (${summary.runsWithFailures} with failures, ${summary.runsWithMisses} with misses)`,
    `Miss rate: **${pct(summary.missRate)}** (${summary.missedSpecs}/${summary.failedSpecs} failing specs not selected)`,
    `Spec executions avoided: **${pct(summary.savings)}**`,
  ];
  const missed = results.filter((r) => r.missed.length);
  if (missed.length) {
    lines.push('', '| Head | Mode | Missed specs |', '| --- | --- | --- |');
    for (const r of missed)
      lines.push(`| \`${r.head.slice(0, 12)}\` | ${r.mode} | ${r.missed.join(', ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

export async function appendHistory(file: string, result: ShadowResult) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await appendFile(file, `${JSON.stringify(result)}\n`);
}

export async function readHistory(file: string): Promise<ShadowResult[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ShadowResult);
}
