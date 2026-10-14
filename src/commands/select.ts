import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Debug } from '../debug.ts';
import { readDiff } from '../git.ts';
import { type PlanFile, toPlanFile } from '../plan-file.ts';
import { buildPlan } from '../plan.ts';
import type { Runner } from '../runner.ts';
import type { ChangedFile, Manifest, Plan, TestscopeConfig } from '../types.ts';

export interface Workspace {
  repoRoot: string;
  /** Absolute test root. */
  root: string;
  /** Config with root rewritten to be repository-relative. */
  config: TestscopeConfig;
  manifest: Manifest;
}

export async function openWorkspace(
  config: TestscopeConfig,
  configDir: string,
  repoRoot: string,
): Promise<Workspace> {
  const root = path.resolve(configDir, config.root);
  const rel = path.relative(repoRoot, root).split(path.sep).join('/') || '.';
  if (rel.startsWith('..')) throw new Error('root must be inside the repository');
  const manifest = JSON.parse(
    await readFile(path.join(root, config.manifest.path), 'utf8'),
  ) as Manifest;
  return { repoRoot, root, config: { ...config, root: rel }, manifest };
}

export interface SelectOptions {
  base: string;
  head?: string;
  /** Actions policy: never return an all-spec plan; downgrade to smoke instead. */
  requireTrimmed?: boolean;
  runner?: Runner;
  /** Supplies judge scores (later milestones). */
  judge?: (changes: ChangedFile[], patch: string) => Promise<Plan['scores']>;
  debug?: Debug;
}

export function trimmedConfig(config: TestscopeConfig, requireTrimmed?: boolean): TestscopeConfig {
  if (
    !requireTrimmed ||
    config.policy.onAllSelected === 'smoke' ||
    config.policy.onAllSelected === 'fail'
  )
    return config;
  return { ...config, policy: { ...config.policy, onAllSelected: 'smoke' } };
}

export function isFullSuite(plan: Plan) {
  return plan.mode === 'all' || (plan.total > 0 && plan.selected.length >= plan.total);
}

export async function selectPlan(ws: Workspace, opts: SelectOptions): Promise<PlanFile> {
  const debug = opts.debug ?? (() => {});
  const config = trimmedConfig(ws.config, opts.requireTrimmed);
  debug(
    `root=${config.root} manifest=${Object.keys(ws.manifest).length} specs policy=${JSON.stringify(config.policy)}`,
  );
  const paths = config.root === '.' ? [] : [config.root, ...config.extraDiffRoots];
  const diff = await readDiff({
    cwd: ws.repoRoot,
    base: opts.base,
    head: opts.head,
    paths,
    withPatch: !!opts.judge,
  });
  debug(
    `diff ${diff.base.slice(0, 12)}..${diff.head.slice(0, 12)}: ${diff.changes.length} changed files`,
  );
  for (const c of diff.changes)
    debug(`  ${c.status} ${c.oldPath ? `${c.oldPath} -> ` : ''}${c.path}`);
  let runnerChanged: string[] | undefined;
  let judge: { scores: Record<string, number> } | { error: string } | undefined;
  const preview = buildPlan({ config, manifest: ws.manifest, changes: diff.changes });
  const needsMore = preview.mode !== 'none' && preview.mode !== 'all' && !preview.downgradedFrom;
  if (needsMore && config.runner.onlyChanged && opts.runner?.listChanged) {
    try {
      runnerChanged = await opts.runner.listChanged(diff.base);
      debug(`runner reports ${runnerChanged.length} changed specs`);
    } catch (e) {
      debug(`runner change detection failed: ${(e as Error).message}`);
      judge = { error: 'runner-collection-error' };
    }
  }
  if (needsMore && !judge && opts.judge) {
    try {
      judge = { scores: await opts.judge(diff.changes, diff.patch) };
      debug(`judge scored ${Object.keys(judge.scores).length} specs`);
    } catch (e) {
      debug(`judge failed: ${(e as Error).name}`);
      judge = {
        error: e instanceof Error && /^judge-/.test(e.message) ? e.message : 'judge-error',
      };
    }
  }
  const plan = buildPlan({
    config,
    manifest: ws.manifest,
    changes: diff.changes,
    runnerChanged,
    judge,
  });
  if (opts.requireTrimmed && isFullSuite(plan))
    throw new Error('require-trimmed: refusing a full-suite selection');
  return toPlanFile(plan, diff.base, diff.head);
}
