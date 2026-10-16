import { restoreCache, saveCache } from '@actions/cache';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AskNoulsResult } from './jev.js';
import type { Candidate, Config, SuiteName } from './types.js';

export interface CacheStore {
  restore(dir: string, key: string): Promise<boolean>;
  save(dir: string, key: string): Promise<void>;
}

export interface CacheKeyParts {
  suite: SuiteName;
  patch: string;
  changedFiles: string[];
  candidates: Candidate[];
  config: Pick<Config, 'model' | 'threshold' | 'uncertainBand' | 'maxUncertainRatio'>;
}

export function cacheHash(parts: CacheKeyParts): string {
  const payload = JSON.stringify({
    patch: parts.patch,
    changedFiles: parts.changedFiles,
    candidates: parts.candidates.map(({ id, data, question }) => ({ id, data, question })),
    model: parts.config.model,
    threshold: parts.config.threshold,
    uncertainBand: parts.config.uncertainBand,
    maxUncertainRatio: parts.config.maxUncertainRatio,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export function cacheKey(parts: CacheKeyParts): string {
  return `testscope-v1-${parts.suite}-${cacheHash(parts)}`;
}

/** Real store backed by @actions/cache. */
export function actionsCacheStore(): CacheStore {
  return {
    restore: async (dir, key) => Boolean(await restoreCache([dir], key)),
    save: async (dir, key) => {
      await saveCache([dir], key);
    },
  };
}

export interface CachedAskOptions {
  parts: CacheKeyParts;
  enabled: boolean;
  cacheDir: string;
  ask: () => Promise<AskNoulsResult>;
  store?: CacheStore;
  warn?: (message: string) => void;
}

/**
 * Wrap a Jev call with the Actions cache. Only successful responses are saved; any cache failure
 * degrades to a plain call. A cached answer set must cover every candidate or it is ignored.
 */
export async function cachedAsk(
  options: CachedAskOptions
): Promise<{ result: AskNoulsResult; hit: boolean }> {
  const { parts, enabled, cacheDir, ask, warn = () => {} } = options;
  if (!enabled) return { result: await ask(), hit: false };
  const key = cacheKey(parts);
  const file = path.join(cacheDir, `${parts.suite}-${cacheHash(parts)}.json`);
  let store: CacheStore | undefined;
  try {
    store = options.store ?? (await actionsCacheStore());
    await mkdir(cacheDir, { recursive: true });
    if (await store.restore(cacheDir, key)) {
      const cached = JSON.parse(await readFile(file, 'utf8')) as AskNoulsResult;
      if (parts.candidates.every((c) => typeof cached.answers?.[c.id] === 'number')) {
        return { result: cached, hit: true };
      }
    }
  } catch {
    warn('testscope cache unavailable');
    store = undefined;
  }
  const result = await ask();
  if (store) {
    try {
      await writeFile(file, JSON.stringify(result));
      await store.save(cacheDir, key);
    } catch {
      warn('testscope cache unavailable');
    }
  }
  return { result, hit: false };
}
