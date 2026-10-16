import type { Config } from '../src/types.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cacheKey, cachedAsk } from '../src/cache.js';
import type { CacheKeyParts, CacheStore } from '../src/cache.js';
import { DEFAULT_CONFIG } from '../src/inputs.js';

const question = { instructions: 'q', criteria: { true: 't', false: 'f' } };
const parts: CacheKeyParts = {
  suite: 'vitest',
  patch: 'diff',
  changedFiles: ['a.ts'],
  candidates: [{ id: 'a.test.ts', data: {}, question }],
  config: DEFAULT_CONFIG,
};

describe('cacheKey', () => {
  it('changes with model, threshold, uncertainty settings, patch and suite', () => {
    const key = cacheKey(parts);
    expect(key).toMatch(/^testscope-v1-vitest-[0-9a-f]{64}$/);
    expect(cacheKey({ ...parts, config: { ...DEFAULT_CONFIG, model: 'jev-1.14.0' } })).not.toBe(key);
    expect(cacheKey({ ...parts, config: { ...DEFAULT_CONFIG, threshold: 0.3 } })).not.toBe(key);
    expect(cacheKey({ ...parts, config: { ...DEFAULT_CONFIG, uncertainBand: 0.2 } })).not.toBe(key);
    expect(cacheKey({ ...parts, config: { ...DEFAULT_CONFIG, maxUncertainRatio: 0.5 } })).not.toBe(key);
    expect(cacheKey({ ...parts, patch: 'other' })).not.toBe(key);
    expect(cacheKey({ ...parts, suite: 'dotnet' })).not.toBe(key);
  });

  it('ignores tunables that do not change the answers', () => {
    const tuned: Config = { ...DEFAULT_CONFIG, timeoutMs: 1, fallback: 'none' };
    expect(cacheKey({ ...parts, config: tuned })).toBe(cacheKey(parts));
  });
});

describe('cachedAsk', () => {
  const result = { model: 'jev-1.13.0', answers: { 'a.test.ts': 0.9 } };

  it('saves only successful responses and hits on the second call', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ts-cache-'));
    const saved = new Map<string, string>();
    const store: CacheStore = {
      restore: vi.fn(async (_dir, key) => saved.has(key)),
      save: vi.fn(async (_dir, key) => void saved.set(key, 'x')),
    };
    const failing = vi.fn(async () => {
      throw new Error('jev-timeout');
    });
    await expect(cachedAsk({ parts, enabled: true, cacheDir: dir, ask: failing, store })).rejects.toThrow();
    expect(store.save).not.toHaveBeenCalled();

    const ask = vi.fn(async () => result);
    const first = await cachedAsk({ parts, enabled: true, cacheDir: dir, ask, store });
    expect(first.hit).toBe(false);
    expect(store.save).toHaveBeenCalledTimes(1);
    const second = await cachedAsk({ parts, enabled: true, cacheDir: dir, ask, store });
    expect(second).toEqual({ result, hit: true });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('degrades to a plain call with a warning when the cache throws', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ts-cache-'));
    const store: CacheStore = {
      restore: async () => {
        throw new Error('cache down');
      },
      save: async () => {},
    };
    const warn = vi.fn();
    const out = await cachedAsk({ parts, enabled: true, cacheDir: dir, ask: async () => result, store, warn });
    expect(out).toEqual({ result, hit: false });
    expect(warn).toHaveBeenCalledWith('testscope cache unavailable');
  });

  it('ignores a cached file that misses a candidate', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ts-cache-'));
    const store: CacheStore = {
      restore: async () => {
        const hash = cacheKey(parts).split('-').pop();
        await writeFile(path.join(dir, `vitest-${hash}.json`), JSON.stringify({ model: 'm', answers: {} }));
        return true;
      },
      save: async () => {},
    };
    const out = await cachedAsk({ parts, enabled: true, cacheDir: dir, ask: async () => result, store });
    expect(out.hit).toBe(false);
  });

  it('is bypassed when disabled', async () => {
    const store: CacheStore = { restore: vi.fn(), save: vi.fn() };
    await cachedAsk({ parts, enabled: false, cacheDir: '/nonexistent', ask: async () => result, store });
    expect(store.restore).not.toHaveBeenCalled();
  });
});
