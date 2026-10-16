import { buildContext, normalizeDirectory, runSuite } from './run.js';
import { git, isDirty, limitPatch, readDiff, replayChangedFilenames } from './git.js';
import type { ReplayMode } from './git.js';
import type { Adapter, Config, Inputs, SuiteContext, SuiteName, SuitePlan } from './types.js';

export interface MergedPr {
  number: number;
  commit: string;
  parent: string;
  subject: string;
  commitKind: 'merge' | 'squash';
  /** Repo-root-relative files changed by the PR. */
  changedFiles: string[];
}

export interface PrResult {
  pr: number;
  suite: SuiteName;
  /** True when the holdout diff was decided by Jev rather than a deterministic rule. */
  reachedJev: boolean;
  mode: SuitePlan['mode'];
  reason: string;
  truth: string[];
  hits: string[];
  misses: string[];
  /** Tests the plan would run; null when the suite total is unknown. */
  selectedCount: number | null;
  totalCount: number | null;
  /** Jev probability of each missed test, when Jev scored it. */
  missedP: number[];
}

export interface SuiteMetrics {
  suite: SuiteName;
  prs: number;
  jevReached: number;
  truthTotal: number;
  hits: number;
  recall: number | null;
  misses: { pr: number; test: string }[];
  reduction: number | null;
  modes: Record<string, number>;
  meanP: number | null;
}

export interface EvaluationReport {
  schemaVersion: 1;
  ref: string;
  tip: string;
  count: number;
  historyExhausted: boolean;
  config: Config;
  suites: SuiteMetrics[];
  results: PrResult[];
}

export const LIMITATIONS: string[] = [
  'Recall proxy: tests changed in the same PR, held out from the diff.',
  'Ground truth only covers tests that still exist in the current tree; tests added then deleted, and regressions in tests the PR did not touch, are not counted.',
  'Replays the current test inventory and current dependency graph against historical filenames and patches; historical suites are not reconstructed.',
  'Counts estimate selection savings, not wall-clock savings. Smoke fallback executes only smoke-tagged tests within its selected specs.',
  'No historical tests are executed, so this is not evidence of coverage completeness or regression detection.',
  'PR identity comes from GitHub squash (#NN) or Merge pull request #NN subjects on first-parent history. Direct commits, rebase merges, and nonstandard PR subjects are excluded.',
  'Merge commits are compared with their first parent and squash commits with their only parent. Eligibility per suite is decided by changes under its working directory.',
  'Only locally available history is traversed. A shallow clone or short history may yield fewer PRs than requested; use fetch-depth: 0 or fetch full history.',
  'Missing credentials or model/response failures are recorded in each plan (reason column), not interpreted as successful Jev selections.',
  'Jev model responses may vary between runs even though history discovery and report ordering are deterministic.',
];

export function mergedPrNumber(subject: string, parentCount: number): string | null {
  if (parentCount > 1) return /^Merge pull request #(\d+)\b/.exec(subject)?.[1] ?? null;
  if (parentCount !== 1) return null;
  return /\(#(\d+)\)\s*$/.exec(subject)?.[1] ?? null;
}

export interface LogRecord {
  commit: string;
  parents: string[];
  subject: string;
}

/** Parse `git log --format=%H%x00%P%x00%s` output. */
export function parseFirstParentLog(log: string): LogRecord[] {
  return log
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((record) => {
      const [commit = '', parentText = '', subject = ''] = record.split('\0');
      return { commit, parents: parentText ? parentText.split(' ') : [], subject };
    });
}

/** Walk first-parent history from a pinned tip and collect up to `count` merged PRs touching any file. */
export async function discoverMergedPrs(
  repoRoot: string,
  ref: string,
  count: number
): Promise<{ tip: string; prs: MergedPr[]; historyExhausted: boolean }> {
  const tip = (await git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  const prs: MergedPr[] = [];
  let cursor: string | null = tip;
  let historyExhausted = false;
  while (cursor && prs.length < count) {
    const records = parseFirstParentLog(
      await git(repoRoot, ['log', '--first-parent', '--max-count=100', '--format=%H%x00%P%x00%s', cursor, '--'])
    );
    if (records.length === 0) {
      historyExhausted = true;
      break;
    }
    for (const { commit, parents, subject } of records) {
      cursor = parents[0] ?? null;
      if (!cursor) historyExhausted = true;
      const number = mergedPrNumber(subject, parents.length);
      if (!number || !cursor) continue;
      const changedFiles = (
        await git(repoRoot, ['diff', '--name-only', '-z', '--no-renames', cursor, commit])
      )
        .split('\0')
        .filter(Boolean);
      if (changedFiles.length === 0) continue;
      prs.push({
        number: Number(number),
        commit,
        parent: cursor,
        subject,
        commitKind: parents.length > 1 ? 'merge' : 'squash',
        changedFiles,
      });
      if (prs.length === count) break;
    }
  }
  return { tip, prs, historyExhausted };
}

export function underDirectory(file: string, directory: string): boolean {
  return directory === '' || file === directory || file.startsWith(`${directory}/`);
}

/**
 * Remove ground-truth files from the context: changedFiles and the patch are recomputed from the
 * remaining files only. Returns null when nothing remains.
 */
export async function holdout(ctx: SuiteContext, truthFiles: string[]): Promise<SuiteContext | null> {
  const held = new Set(truthFiles);
  const remaining = ctx.changedFiles.filter((file) => !held.has(file));
  if (remaining.length === 0) return null;
  const diff = await readDiff(ctx.repoRoot, ctx.base, ctx.head, remaining);
  const { patch, truncated } = limitPatch(diff.patch, diff.stat);
  return { ...ctx, changedFiles: diff.changedFiles, patch, patchTruncated: truncated };
}

/** Number of tests the plan would run, counting a whole-suite `full` as everything. */
export function plannedCount(plan: Pick<SuitePlan, 'mode' | 'selected' | 'selectedCount' | 'totalCount'>): number | null {
  if (plan.mode === 'none') return 0;
  if (plan.mode === 'full') return plan.totalCount;
  return plan.selectedCount ?? plan.selected.length;
}

export function reachedJev(plan: Pick<SuitePlan, 'probabilities' | 'reason'>): boolean {
  return Object.keys(plan.probabilities).length > 0 || /^jev-(?!missing-key)/.test(plan.reason);
}

/** Compare a plan against the held-out truth. */
export function scorePlan(pr: number, suite: SuiteName, truth: string[], plan: SuitePlan): PrResult {
  const ran = new Set(plan.selected);
  const isHit = (test: string): boolean => plan.mode === 'full' || (plan.mode !== 'none' && ran.has(test));
  const hits = truth.filter(isHit);
  const misses = truth.filter((test) => !isHit(test));
  return {
    pr,
    suite,
    reachedJev: reachedJev(plan),
    mode: plan.mode,
    reason: plan.reason,
    truth,
    hits,
    misses,
    selectedCount: plannedCount(plan),
    totalCount: plan.totalCount,
    missedP: misses.flatMap((test) => (test in plan.probabilities ? [plan.probabilities[test]!] : [])),
  };
}

export function aggregate(suite: SuiteName, results: PrResult[]): SuiteMetrics {
  const truthTotal = results.reduce((sum, r) => sum + r.truth.length, 0);
  const hits = results.reduce((sum, r) => sum + r.hits.length, 0);
  // Unknown suite totals (collection failed before counting) fall back to the largest known total, so that
  // whole-suite runs still count as "everything selected" instead of silently dropping out of the reduction.
  const knownTotal = Math.max(0, ...results.map((r) => r.totalCount ?? 0));
  const totalOf = (r: PrResult): number => r.totalCount ?? knownTotal;
  const selectedOf = (r: PrResult): number => r.selectedCount ?? (r.mode === 'full' ? totalOf(r) : 0);
  const selectedSum = results.reduce((sum, r) => sum + selectedOf(r), 0);
  const totalSum = results.reduce((sum, r) => sum + totalOf(r), 0);
  const modes: Record<string, number> = {};
  for (const r of results) modes[r.mode] = (modes[r.mode] ?? 0) + 1;
  const missedP = results.flatMap((r) => r.missedP);
  return {
    suite,
    prs: results.length,
    jevReached: results.filter((r) => r.reachedJev).length,
    truthTotal,
    hits,
    recall: truthTotal === 0 ? null : hits / truthTotal,
    misses: results.flatMap((r) => r.misses.map((test) => ({ pr: r.pr, test }))),
    reduction: totalSum === 0 ? null : 1 - selectedSum / totalSum,
    modes,
    meanP: missedP.length === 0 ? null : missedP.reduce((a, b) => a + b, 0) / missedP.length,
  };
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function formatMarkdown(report: EvaluationReport): string {
  const cell = (text: string) => text.replaceAll('|', '\\|');
  const rows = report.suites.map((m) => {
    const modes = Object.entries(m.modes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mode, n]) => `${mode}:${n}`)
      .join(' ');
    return `| ${m.suite} | ${m.prs} (${m.jevReached}) | ${percent(m.recall)} (${m.hits}/${m.truthTotal}) | ${m.misses.length} | ${percent(m.reduction)} | ${modes || '—'} |`;
  });
  const out = [
    '# testscope evaluation',
    '',
    `Ref \`${cell(report.ref)}\` at \`${report.tip.slice(0, 12)}\`, model \`${report.config.model}\`, threshold ${report.config.threshold}, up to ${report.count} PRs per suite.`,
    '',
    '| Suite | PRs (Jev-reached) | Recall | Misses | Reduction | Modes |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...rows,
    '',
    '## Misses',
    '',
  ];
  const missLines = report.suites.flatMap((m) =>
    m.misses.map((miss) => `- ${m.suite}: #${miss.pr} \`${miss.test}\``)
  );
  out.push(...(missLines.length ? missLines : ['None.']), '', '## Limitations', '');
  out.push(...LIMITATIONS.map((line) => `- ${line}`), '');
  return out.join('\n');
}

export interface EvaluateOptions {
  repoRoot: string;
  ref: string;
  count: number;
  suites: SuiteName[];
  inputs: Inputs;
  config: Config;
  apiKey: string;
  getAdapter: (name: SuiteName) => Adapter;
  fetchImpl?: typeof fetch;
  warn: (message: string) => void;
}

/** Suites whose dependency-based collection is replayed against historical filenames, and how (see ReplayMode). */
const REPLAYS: Record<SuiteName, ReplayMode | null> = { playwright: 'baseline', vitest: 'head', dotnet: null };

async function evaluatePr(options: EvaluateOptions, adapter: Adapter, pr: MergedPr): Promise<PrResult | null> {
  const { repoRoot, inputs, config, apiKey, warn } = options;
  const suite = adapter.name;
  const full = await buildContext({ suite, repoRoot, baseRef: pr.parent, headRef: pr.commit, inputs });
  if (full.changedFiles.length === 0) return null;
  const truth = await adapter.truth(full);
  if (truth.ids.length === 0) return null;
  const held = await holdout(full, truth.files);
  const base = { pr: pr.number, suite, truth: truth.ids };
  if (!held) {
    const empty: SuitePlan = {
      suite,
      mode: 'none',
      reason: 'no-relevant-changes',
      selected: [],
      selectedCount: 0,
      totalCount: null,
      probabilities: {},
      reasons: {},
      command: '',
      fullCommand: '',
      model: config.model,
      cacheHit: false,
      dryRun: false,
    };
    return scorePlan(base.pr, suite, base.truth, empty);
  }
  const runOptions = { adapter, config: { ...config, dryRun: false }, apiKey, cacheEnabled: false, cacheDir: '', fetchImpl: options.fetchImpl, warn };
  // Always replay (even when HEAD is the PR commit) so held-out test files cannot leak back in through
  // `--only-changed` / `--changed` seeing them as changed in the working tree.
  const replay = REPLAYS[suite];
  const plan = replay
    ? await replayChangedFilenames(repoRoot, held.changedFiles, replay, (baseline, env) =>
        runSuite({ ...runOptions, ctx: { ...held, collectBase: baseline, collectEnv: env } })
      )
    : await runSuite({ ...runOptions, ctx: held });
  return scorePlan(pr.number, suite, truth.ids, plan);
}

/** Evaluate each suite on merged PRs: qualifying (reached Jev) PRs first, non-qualifying fillers after. */
export async function evaluate(options: EvaluateOptions): Promise<EvaluationReport> {
  const { repoRoot, ref, count, suites, inputs, config } = options;
  const history = await discoverMergedPrs(repoRoot, ref, count * 10);
  const metrics: SuiteMetrics[] = [];
  const allResults: PrResult[] = [];
  for (const suite of suites) {
    const directory = normalizeDirectory(inputs[`${suite}-working-directory`] ?? '.');
    if (REPLAYS[suite] && (await isDirty(repoRoot, [directory]))) {
      throw new Error(`evaluate needs a clean working directory for ${suite}: '${directory || '.'}' has uncommitted changes`);
    }
    const adapter = options.getAdapter(suite);
    const qualifying: PrResult[] = [];
    const fillers: PrResult[] = [];
    for (const pr of history.prs) {
      if (qualifying.length >= count) break;
      if (!pr.changedFiles.some((file) => underDirectory(file, directory))) continue;
      const result = await evaluatePr(options, adapter, pr);
      if (!result) continue;
      (result.reachedJev ? qualifying : fillers).push(result);
    }
    const chosen = [...qualifying, ...fillers.slice(0, Math.max(0, count - qualifying.length))];
    metrics.push(aggregate(suite, chosen));
    allResults.push(...chosen);
  }
  return {
    schemaVersion: 1,
    ref,
    tip: history.tip,
    count,
    historyExhausted: history.historyExhausted,
    config,
    suites: metrics,
    results: allResults,
  };
}
