import type { Manifest, Plan } from './types.ts';

const REASONS: Record<string, string> = {
  'spec-changed': 'the spec file itself changed',
  'runner-changed': 'the runner reports it depends on a changed file',
  judge: 'the judge scored it at or above the threshold',
  'smoke-canary': 'it is the smoke canary (always runs)',
  'smoke-fallback': 'part of the curated smoke fallback',
};

export function describeReason(reason: string): string {
  if (reason.startsWith('source:')) return `changed file ${reason.slice(7)} matches its sources`;
  if (reason.startsWith('shared:')) return `shared file ${reason.slice(7).split(' ')[0]} changed`;
  return REASONS[reason] ?? reason;
}

export function describeFallback(reason: string): string {
  if (reason.startsWith('unmapped:'))
    return `a changed file maps to no spec (${reason.slice(9)}); policy.onUnmapped applied`;
  if (reason.startsWith('budget:'))
    return `selection exceeded policy.maxSpecs (${reason.slice(7)})`;
  if (reason.startsWith('shared:')) return `a shared file changed (${reason.slice(7)})`;
  if (reason.startsWith('all-specs'))
    return 'the selection covered every spec; policy.onAllSelected applied';
  if (reason.startsWith('judge-') || reason === 'runner-collection-error')
    return `${reason}; policy.onJudgeError applied`;
  return reason;
}

/** Human-readable explanation of a plan, or of one spec within it. */
export function explainPlan(plan: Plan, manifest: Manifest, spec?: string): string {
  const lines: string[] = [];
  if (spec) {
    if (!Object.hasOwn(manifest, spec)) return `${spec} is not in the manifest\n`;
    const reasons = plan.reasons[spec];
    const score = plan.scores[spec];
    if (reasons) {
      lines.push(`${spec} is SELECTED${plan.smokeOnly ? ' (smoke tests only)' : ''} because:`);
      for (const r of reasons) lines.push(`  - ${describeReason(r)}`);
    } else {
      lines.push(`${spec} is NOT selected.`);
      if (score !== undefined) lines.push(`  - judge score ${score} is below the threshold`);
      else lines.push('  - no changed file matches the spec or its sources');
    }
    if (plan.fallbackReason) lines.push(`Plan fallback: ${describeFallback(plan.fallbackReason)}`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `Mode: ${plan.mode}${plan.smokeOnly ? ' (smoke tests only)' : ''}; ${plan.selected.length}/${plan.total} specs`,
  );
  if (plan.fallbackReason) lines.push(`Fallback: ${describeFallback(plan.fallbackReason)}`);
  if (plan.downgradedFrom)
    lines.push(
      `Downgraded from ${plan.downgradedFrom.mode} (${plan.downgradedFrom.selectedCount} specs would have run)`,
    );
  if (plan.selected.length) {
    lines.push('', 'Selected:');
    for (const s of plan.selected)
      lines.push(`  ${s}`, ...(plan.reasons[s] ?? []).map((r) => `    - ${describeReason(r)}`));
  }
  if (plan.unmapped.length) {
    lines.push('', 'Changed files that map to no spec:');
    for (const f of plan.unmapped) lines.push(`  ${f}`);
  }
  const scored = Object.entries(plan.scores).filter(([s]) => !plan.reasons[s]);
  if (scored.length) {
    lines.push('', 'Scored but not selected:');
    for (const [s, p] of scored.sort((a, b) => b[1] - a[1])) lines.push(`  ${p.toFixed(2)}  ${s}`);
  }
  return `${lines.join('\n')}\n`;
}
