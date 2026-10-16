import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, withDefaults } from '../src/inputs.js';
import { runSuite } from '../src/run.js';
import type { Adapter, Collected, SuiteContext } from '../src/types.js';

const question = { instructions: 'i', criteria: { true: 't', false: 'f' } };

function collected(): Collected {
  return {
    candidates: ['a', 'b', 'c', 'd'].map((id) => ({ id, data: id, question })),
    forced: new Map(),
    totalCount: 20,
    state: {},
  };
}

function setup(overrides: Partial<SuiteContext> = {}, inputs: Record<string, string> = {}) {
  const collect = vi.fn(async (_ctx: SuiteContext, _opts: { lite: boolean }) => collected());
  const adapter: Adapter = {
    name: 'dotnet',
    smokeSupported: false,
    defaultShared: () => [],
    collect,
    command: (plan) => ({ command: `${plan.mode}:${plan.selected.join(',')}` }),
    truth: async () => ({ ids: [], files: [] }),
  };
  const ctx: SuiteContext = {
    suite: 'dotnet',
    repoRoot: '/repo',
    workingDirectory: 'Backend',
    base: 'b',
    head: 'h',
    changedFiles: ['Backend/src/A.cs'],
    patch: 'patch',
    patchTruncated: false,
    inputs: withDefaults(inputs),
    ...overrides,
  };
  return { adapter, ctx, collect };
}

const base = { config: DEFAULT_CONFIG, apiKey: 'key', cacheEnabled: false, cacheDir: '/nonexistent' };

describe('runSuite', () => {
  it('a shared glob outside the working directory forces the whole suite even when nothing else changed', async () => {
    const { adapter, ctx, collect } = setup(
      { changedFiles: [], allChangedFiles: ['design-tokens/palette.json'] },
      { 'shared-paths': 'dotnet:design-tokens/**' }
    );
    const fetchImpl = vi.fn();
    const plan = await runSuite({ ...base, adapter, ctx, fetchImpl });
    expect(plan).toMatchObject({ mode: 'full', reason: 'shared-infra:design-tokens/palette.json', command: 'full:' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(collect).toHaveBeenCalledWith(ctx, { lite: true });
  });

  it('does not call Jev without a key and falls back with jev-missing-key', async () => {
    const { adapter, ctx } = setup();
    const fetchImpl = vi.fn();
    const plan = await runSuite({ ...base, apiKey: '', adapter, ctx, fetchImpl });
    expect(plan).toMatchObject({ mode: 'full', reason: 'jev-missing-key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('makes exactly one Jev call and selects by threshold', async () => {
    const { adapter, ctx } = setup();
    const answers = { q_0: 0.9, q_1: 0.01, q_2: 0.02, q_3: 0.03 };
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { type: 'noul', noul: v }])) }),
        { status: 200 }
      )
    );
    const plan = await runSuite({ ...base, adapter, ctx, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(plan).toMatchObject({ mode: 'selected', selected: ['a'], command: 'selected:a', fullCommand: 'full:' });
  });

  it('turns an adapter crash into selector-error without throwing', async () => {
    const { adapter, ctx } = setup();
    adapter.collect = async () => {
      throw new Error('boom');
    };
    const plan = await runSuite({ ...base, adapter, ctx });
    expect(plan).toMatchObject({ mode: 'full', reason: 'selector-error' });
  });

  it('maps a Jev HTTP failure to its code', async () => {
    const { adapter, ctx } = setup();
    const fetchImpl = vi.fn(async () => new Response('x', { status: 429 }));
    const plan = await runSuite({ ...base, adapter, ctx, fetchImpl });
    expect(plan).toMatchObject({ mode: 'full', reason: 'jev-http-429' });
  });
});
