import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/inputs.js';
import { decide } from '../src/policy.js';
import type { PolicyInput } from '../src/policy.js';
import { planOutputs } from '../src/main.js';
import type { Candidate, Config } from '../src/types.js';

const question = { instructions: '', criteria: { true: '', false: '' } };

function candidates(...ids: string[]): Candidate[] {
  return ids.map((id) => ({ id, data: id, question }));
}

function input(overrides: Omit<Partial<PolicyInput>, 'config'> & { config?: Partial<Config> } = {}): PolicyInput {
  const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);
  const { config, ...rest } = overrides;
  return {
    suite: 'vitest',
    smokeSupported: false,
    relevantCount: 1,
    sharedHit: null,
    collected: { candidates: candidates(...ids), forced: new Map(), totalCount: 100 },
    probabilities: Object.fromEntries(ids.map((id) => [id, 0.01])),
    model: 'jev-1.13.0',
    cacheHit: false,
    ...rest,
    config: { ...DEFAULT_CONFIG, ...config },
  };
}

describe('decide rule order', () => {
  it('1 no relevant files beats everything', () => {
    const plan = decide(input({ relevantCount: 0, sharedHit: 'package.json', jevError: 'jev-timeout' }));
    expect(plan).toMatchObject({ mode: 'none', reason: 'no-relevant-changes' });
  });

  it('2 shared infra beats collection and Jev errors', () => {
    const plan = decide(input({ sharedHit: 'vitest.config.ts', jevError: 'jev-timeout', collectionError: 'x' }));
    expect(plan).toMatchObject({ mode: 'full', reason: 'shared-infra:vitest.config.ts' });
  });

  it('3 collection error and adapter whole reason', () => {
    expect(decide(input({ collectionError: 'vitest-collection-error' }))).toMatchObject({
      mode: 'full',
      reason: 'vitest-collection-error',
    });
    const collected = { candidates: [], forced: new Map(), totalCount: 5, wholeReason: 'non-code-change:a.json' };
    expect(decide(input({ collected }))).toMatchObject({ mode: 'full', reason: 'non-code-change:a.json', selectedCount: 5 });
  });

  it('4 selector error and missing collection', () => {
    expect(decide(input({ selectorError: true }))).toMatchObject({ mode: 'full', reason: 'selector-error' });
    expect(decide(input({ collected: undefined }))).toMatchObject({ mode: 'full', reason: 'selector-error' });
  });

  it('5 jev error reasons pass through', () => {
    for (const code of ['jev-missing-key', 'jev-timeout', 'jev-http-529', 'jev-invalid-answer']) {
      expect(decide(input({ jevError: code }))).toMatchObject({ mode: 'full', reason: code });
    }
  });

  it('no candidates yields none without needing Jev', () => {
    const collected = { candidates: [], forced: new Map(), totalCount: 100 };
    expect(decide(input({ collected, probabilities: undefined }))).toMatchObject({ mode: 'none', reason: 'no-candidates' });
  });

  it('6 uncertain answers beyond the allowed ratio fall back', () => {
    const probabilities = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, i < 4 ? 0.5 : 0.01]));
    expect(decide(input({ probabilities }))).toMatchObject({ mode: 'full', reason: 'jev-uncertain' });
    const fine = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, i < 3 ? 0.55 : 0.01]));
    expect(decide(input({ probabilities: fine })).reason).not.toBe('jev-uncertain');
  });

  it('uncertain band edges are inclusive', () => {
    const probabilities = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, i < 4 ? 0.6 : 0.01]));
    expect(decide(input({ probabilities })).reason).toBe('jev-uncertain');
  });

  it('7 selects p >= threshold (boundary) plus forced', () => {
    const probabilities = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, 0.01]));
    probabilities.t1 = 0.25;
    probabilities.t2 = 0.2499;
    const forced = new Map([['t3', ['changed-test']]]);
    const plan = decide(
      input({
        probabilities,
        collected: { candidates: candidates(...Object.keys(probabilities)), forced, totalCount: 100 },
      })
    );
    expect(plan).toMatchObject({ mode: 'selected', reason: 'jev', selected: ['t1', 't3'], selectedCount: 2 });
    expect(plan.reasons).toEqual({ t1: ['jev'], t3: ['changed-test'] });
  });

  it('8 selected ratio above the cap falls back to the whole suite', () => {
    const probabilities = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, 0.9]));
    const collected = { candidates: candidates(...Object.keys(probabilities)), forced: new Map(), totalCount: 10 };
    expect(decide(input({ probabilities, collected }))).toMatchObject({ mode: 'full', reason: 'selected-ratio-exceeded' });
    expect(decide(input({ probabilities, collected, config: { maxSelectedRatio: 1 } })).mode).toBe('selected');
  });

  it('9 nothing selected after Jev is none', () => {
    expect(decide(input())).toMatchObject({ mode: 'none', reason: 'jev-selected-none', selected: [] });
  });
});

describe('fallback modes', () => {
  const missing = { jevError: 'jev-missing-key' };

  it('full', () => {
    expect(decide(input(missing))).toMatchObject({ mode: 'full', selectedCount: 100, totalCount: 100 });
  });

  it('none suffixes the reason', () => {
    expect(decide(input({ ...missing, config: { fallback: 'none' } }))).toMatchObject({
      mode: 'none',
      reason: 'jev-missing-key;fallback-none',
    });
  });

  it('smoke uses the adapter smoke list', () => {
    const collected = { candidates: candidates('a'), forced: new Map(), totalCount: 50, smoke: ['s1', 's2'] };
    const plan = decide(input({ ...missing, smokeSupported: true, collected, config: { fallback: 'smoke' } }));
    expect(plan).toMatchObject({ mode: 'smoke', selected: ['s1', 's2'], selectedCount: 2 });
  });

  it('smoke on suites without smoke becomes full and says so', () => {
    const plan = decide(input({ ...missing, config: { fallback: 'smoke' } }));
    expect(plan).toMatchObject({ mode: 'full', note: 'smoke unsupported → full' });
  });

  it('smoke without any smoke tests becomes full', () => {
    const plan = decide(input({ ...missing, smokeSupported: true, config: { fallback: 'smoke' } }));
    expect(plan.mode).toBe('full');
    expect(plan.note).toContain('no smoke');
  });
});

describe('dry-run outputs', () => {
  it('forces the full suite but keeps the real reason', () => {
    const plan = {
      ...decide(input({ config: { dryRun: true } })),
      command: 'run a',
      fullCommand: 'run all',
    };
    expect(plan.mode).toBe('none');
    expect(planOutputs(plan)).toMatchObject({
      'vitest-mode': 'full',
      'vitest-reason': 'dry-run:jev-selected-none',
      'vitest-command': 'run all',
    });
  });
});
