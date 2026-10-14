import { matchesAny } from './glob.ts';
import type {
  ChangedFile,
  FallbackPolicy,
  Manifest,
  Plan,
  PlanMode,
  TestscopeConfig,
} from './types.ts';

export class PolicyError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`testscope policy refused the plan: ${reason}`);
    this.name = 'PolicyError';
    this.reason = reason;
  }
}

export interface PlanInput {
  config: TestscopeConfig;
  manifest: Manifest;
  changes: ChangedFile[];
  /** Specs reported by the runner's own change detection (e.g. Playwright --only-changed). Root-relative. */
  runnerChanged?: string[];
  /** Judge probabilities per spec, or an error code when the judge failed. */
  judge?: { scores: Record<string, number> } | { error: string };
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/** Map a repo-relative path to a root-relative one, or undefined when outside root and extra roots. */
export function scopePath(file: string, config: Pick<TestscopeConfig, 'root' | 'extraDiffRoots'>) {
  const f = norm(file);
  const root = norm(config.root);
  if (root === '' || root === '.') return { path: f, inRoot: true };
  if (f.startsWith(`${root}/`)) return { path: f.slice(root.length + 1), inRoot: true };
  if (config.extraDiffRoots.some((r) => f === norm(r) || f.startsWith(`${norm(r)}/`)))
    return { path: f, inRoot: false };
  return undefined;
}

/** Curated smoke selection: configured smoke specs (or manifest smoke entries), plus canary. */
export function smokeSet(config: TestscopeConfig, manifest: Manifest): string[] {
  const listed = config.smoke.specs.length
    ? config.smoke.specs
    : Object.keys(manifest).filter((s) => manifest[s]?.smoke);
  const set = new Set(listed.filter((s) => Object.hasOwn(manifest, s)));
  const canary = config.smoke.canary;
  if (canary) {
    if (!Object.hasOwn(manifest, canary))
      throw new PolicyError('smoke canary is missing from the manifest');
    set.add(canary);
  }
  if (!set.size) throw new PolicyError('no smoke specs are configured or present in the manifest');
  return [...set].sort();
}

/** Pure selection: decide which specs to run for a set of changed files. */
export function buildPlan(input: PlanInput): Plan {
  const { config, manifest } = input;
  const specs = Object.keys(manifest).sort();
  const total = specs.length;
  const reasons: Record<string, string[]> = {};
  const add = (spec: string, why: string) => {
    if (!Object.hasOwn(manifest, spec)) return;
    const list = reasons[spec] ?? [];
    reasons[spec] = list;
    if (!list.includes(why)) list.push(why);
  };
  const plan = (
    mode: PlanMode,
    selected: string[],
    smokeOnly = false,
    extra: Partial<Plan> = {},
  ): Plan => {
    const sel = [...new Set(selected)].sort();
    return {
      mode,
      selected: sel,
      groups: [
        ...new Set(sel.map((s) => manifest[s]?.group).filter((g): g is string => !!g)),
      ].sort(),
      smokeOnly,
      reasons: Object.fromEntries(sel.map((s) => [s, reasons[s] ?? []])),
      unmapped,
      scores,
      total,
      ...extra,
    };
  };
  const scores: Record<string, number> = {};
  const unmapped: string[] = [];

  const apply = (
    policy: FallbackPolicy,
    reason: string,
    current: string[],
    from?: PlanMode,
  ): Plan => {
    const downgradedFrom = from ? { mode: from, selectedCount: current.length } : undefined;
    switch (policy) {
      case 'all':
        for (const s of specs) add(s, reason);
        return plan('all', specs, false, { fallbackReason: reason });
      case 'manifest':
        return plan(current.length ? 'selected' : 'none', current, false, {
          fallbackReason: reason,
        });
      case 'fail':
        throw new PolicyError(reason);
      default: {
        const smoke = smokeSet(config, manifest);
        for (const s of Object.keys(reasons)) delete reasons[s];
        for (const s of smoke) add(s, 'smoke-fallback');
        return plan('smoke-fallback', smoke, true, {
          fallbackReason: reason,
          ...(downgradedFrom ? { downgradedFrom } : {}),
        });
      }
    }
  };

  // 1. Scope and filter changed paths. Renames contribute both sides; deleted specs are not runnable.
  const touched: { path: string; inRoot: boolean; deleted: boolean }[] = [];
  for (const change of input.changes) {
    for (const p of [change.oldPath, change.path]) {
      if (!p) continue;
      const scoped = scopePath(p, config);
      if (!scoped || matchesAny(scoped.path, config.ignore)) continue;
      const deleted =
        change.status === 'deleted' || (change.status === 'renamed' && p === change.oldPath);
      if (!touched.some((t) => t.path === scoped.path)) touched.push({ ...scoped, deleted });
    }
  }
  if (!touched.length) return plan('none', []);

  // 2. Shared infrastructure invalidates the whole suite (then onAllSelected decides).
  const shared =
    config.policy.onAllSelected === 'manifest'
      ? undefined
      : touched.find((t) => matchesAny(t.path, config.shared));
  if (shared) {
    const reason = `shared:${shared.path}`;
    if (config.policy.onAllSelected === 'all') return apply('all', reason, specs);
    return apply(
      config.policy.onAllSelected,
      `${reason} -> ${config.policy.onAllSelected}`,
      specs,
      'all',
    );
  }

  // 3. Manifest matching: the spec file itself, or one of its source globs.
  for (const t of touched) {
    let mapped = false;
    if (t.inRoot && Object.hasOwn(manifest, t.path)) {
      mapped = true;
      if (!t.deleted) add(t.path, 'spec-changed');
    }
    if (t.inRoot)
      for (const s of specs) {
        const globs = manifest[s]?.sources;
        if (globs?.length && matchesAny(t.path, globs)) {
          add(s, `source:${t.path}`);
          mapped = true;
        }
      }
    if (!mapped) unmapped.push(t.path);
  }

  // 4. Runner-detected dependencies.
  for (const s of input.runnerChanged ?? []) add(norm(s), 'runner-changed');

  // 5. Judge.
  let judgeError: string | undefined;
  if (input.judge && 'error' in input.judge) judgeError = input.judge.error;
  else if (input.judge) {
    for (const s of specs) {
      const p = input.judge.scores[s];
      if (p === undefined) continue;
      if (!Number.isFinite(p) || p < 0 || p > 1) {
        judgeError = 'judge-invalid-answer';
        break;
      }
      scores[s] = p;
    }
    if (!judgeError)
      for (const s of specs) if ((scores[s] ?? -1) >= config.judge.threshold) add(s, 'judge');
  }
  const judged = input.judge !== undefined && !judgeError;

  let current = Object.keys(reasons).sort();
  if (judgeError) return apply(config.policy.onJudgeError, judgeError, current);
  // Unmapped changes only fall back when no judge looked at them.
  if (unmapped.length && !judged && config.policy.onUnmapped !== 'manifest')
    return apply(config.policy.onUnmapped, `unmapped:${unmapped[0]}`, current);

  // 6. Canary always runs (in smoke mode unless directly affected).
  const canary = config.smoke.canary;
  if (canary && Object.hasOwn(manifest, canary)) add(canary, 'smoke-canary');
  current = Object.keys(reasons).sort();

  // 7. Budget cap and all-selected policy.
  const max = config.policy.maxSpecs;
  if (max !== undefined && current.length > max)
    return apply('smoke', `budget:${current.length}>${max}`, current, 'selected');
  if (total > 0 && current.length >= total && config.policy.onAllSelected !== 'all')
    return apply(
      config.policy.onAllSelected,
      `all-specs -> ${config.policy.onAllSelected}`,
      current,
      'selected',
    );

  return plan(current.length ? 'selected' : 'none', current);
}

export interface ExecutionGroup {
  specs: string[];
  smokeOnly: boolean;
}

/** Split a plan into runner invocations: affected specs in full, the canary in smoke-only mode. */
export function executionGroups(plan: Plan, canary?: string): ExecutionGroup[] {
  if (!plan.selected.length) return [];
  if (plan.smokeOnly) return [{ specs: plan.selected, smokeOnly: true }];
  if (plan.mode === 'all' || !canary || !plan.selected.includes(canary))
    return [{ specs: plan.selected, smokeOnly: false }];
  const canaryAffected = (plan.reasons[canary] ?? []).some((r) => r !== 'smoke-canary');
  const full = plan.selected.filter((s) => s !== canary || canaryAffected);
  return [
    ...(full.length ? [{ specs: full, smokeOnly: false }] : []),
    ...(canaryAffected ? [] : [{ specs: [canary], smokeOnly: true }]),
  ];
}
