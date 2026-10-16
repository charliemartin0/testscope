import type { Candidate, Config, SuiteName, SuitePlan } from './types.js';

export interface PolicyInput {
  suite: SuiteName;
  smokeSupported: boolean;
  config: Config;
  /** Number of changed files under the suite's working directory. */
  relevantCount: number;
  /** First changed file matching a shared-infra glob. */
  sharedHit: string | null;
  /** Present when collection succeeded (full or lite). */
  collected?: {
    candidates: Candidate[];
    forced: Map<string, string[]>;
    totalCount: number;
    smoke?: string[];
    wholeReason?: string;
  };
  /** Closed-set reason for a deterministic collection failure (e.g. `vitest-collection-error`). */
  collectionError?: string;
  /** The selector itself threw. */
  selectorError?: boolean;
  /** Jev outcome: probabilities, or a JevError code (`jev-missing-key`, `jev-timeout`, ...). */
  probabilities?: Record<string, number>;
  jevError?: string;
  model: string;
  cacheHit: boolean;
}

export type PolicyOutput = Omit<SuitePlan, 'command' | 'fullCommand' | 'filters'>;

/**
 * The single selection policy for every adapter. Rule order:
 * 1 no relevant files -> none; 2 shared infra -> whole suite; 3 adapter/collection whole-suite reason;
 * 4 selector error; 5 Jev missing key / error; 6 too many uncertain answers; 7 threshold + forced;
 * 8 selected ratio too high -> whole suite; 9 nothing selected -> none; 10 selected.
 */
export function decide(input: PolicyInput): PolicyOutput {
  const { suite, config, collected } = input;
  const total = collected?.totalCount ?? null;
  const base = {
    suite,
    probabilities: {} as Record<string, number>,
    reasons: {} as Record<string, string[]>,
    model: input.model,
    cacheHit: input.cacheHit,
    dryRun: config.dryRun,
  };

  const whole = (reason: string): PolicyOutput => {
    const { fallback } = config;
    if (fallback === 'none') {
      return { ...base, mode: 'none', reason: `${reason};fallback-none`, selected: [], selectedCount: 0, totalCount: total };
    }
    if (fallback === 'smoke') {
      const smoke = collected?.smoke ?? [];
      if (input.smokeSupported && smoke.length > 0) {
        return {
          ...base,
          mode: 'smoke',
          reason,
          selected: [...smoke],
          selectedCount: smoke.length,
          totalCount: total,
          reasons: Object.fromEntries(smoke.map((id) => [id, ['smoke-fallback']])),
        };
      }
      return {
        ...base,
        mode: 'full',
        reason,
        note: input.smokeSupported ? 'no smoke tests available → full' : 'smoke unsupported → full',
        selected: [],
        selectedCount: total,
        totalCount: total,
      };
    }
    return { ...base, mode: 'full', reason, selected: [], selectedCount: total, totalCount: total };
  };

  if (input.relevantCount === 0) {
    return { ...base, mode: 'none', reason: 'no-relevant-changes', selected: [], selectedCount: 0, totalCount: total };
  }
  if (input.sharedHit) return whole(`shared-infra:${input.sharedHit}`);
  if (input.collectionError) return whole(input.collectionError);
  if (collected?.wholeReason) return whole(collected.wholeReason);
  if (input.selectorError || !collected) return whole('selector-error');
  if (input.jevError) return whole(input.jevError);

  const { candidates, forced } = collected;
  if (candidates.length === 0) {
    return { ...base, mode: 'none', reason: 'no-candidates', selected: [], selectedCount: 0, totalCount: total };
  }
  const probabilities = input.probabilities ?? {};
  const uncertain = candidates.filter(
    (candidate) => Math.abs((probabilities[candidate.id] ?? 0) - 0.5) <= config.uncertainBand
  ).length;
  if (uncertain / candidates.length > config.maxUncertainRatio) {
    return { ...whole('jev-uncertain'), probabilities };
  }

  const reasons: Record<string, string[]> = {};
  for (const candidate of candidates) {
    const why = [
      ...((probabilities[candidate.id] ?? 0) >= config.threshold ? ['jev'] : []),
      ...(forced.get(candidate.id) ?? []),
    ];
    if (why.length) reasons[candidate.id] = why;
  }
  const selected = Object.keys(reasons).sort();
  if (total && selected.length / total > config.maxSelectedRatio) {
    return { ...whole('selected-ratio-exceeded'), probabilities };
  }
  if (selected.length === 0) {
    return { ...base, probabilities, mode: 'none', reason: 'jev-selected-none', selected: [], selectedCount: 0, totalCount: total };
  }
  return {
    ...base,
    probabilities,
    reasons,
    mode: 'selected',
    reason: 'jev',
    selected,
    selectedCount: selected.length,
    totalCount: total,
  };
}
