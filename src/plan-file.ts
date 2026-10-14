import { readFile } from 'node:fs/promises';
import type { Manifest, Plan } from './types.ts';

export const PLAN_VERSION = 1;

/** Stable on-disk/JSON plan. Keys are emitted in a fixed order so diffs and snapshots stay readable. */
export interface PlanFile extends Plan {
  version: typeof PLAN_VERSION;
  base: string;
  head: string;
}

const ORDER: (keyof PlanFile)[] = [
  'version',
  'base',
  'head',
  'mode',
  'total',
  'selected',
  'groups',
  'smokeOnly',
  'fallbackReason',
  'downgradedFrom',
  'reasons',
  'unmapped',
  'scores',
];

export function toPlanFile(plan: Plan, base: string, head: string): PlanFile {
  const full = { ...plan, version: PLAN_VERSION, base, head } as PlanFile;
  const out: Record<string, unknown> = {};
  for (const k of ORDER) if (full[k] !== undefined) out[k] = full[k];
  return out as unknown as PlanFile;
}

export function serializePlan(plan: PlanFile): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/** Load a saved plan and check it still applies to this HEAD and manifest. */
export async function readPlanFile(
  file: string,
  head: string,
  manifest: Manifest,
): Promise<PlanFile> {
  const plan = JSON.parse(await readFile(file, 'utf8')) as PlanFile;
  if (plan.version !== PLAN_VERSION)
    throw new Error(`Unsupported plan version ${String(plan.version)}`);
  if (plan.head !== head) throw new Error('Saved plan belongs to a different HEAD');
  if (!Array.isArray(plan.selected) || plan.selected.some((s) => !Object.hasOwn(manifest, s)))
    throw new Error('Saved plan selects specs that are not in the manifest');
  return plan;
}
