import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Judge, JudgeError, type JudgeRequest, checkScores } from '../judge.ts';

/** Bump when request shaping or prompts change so stale answers are not reused. */
export const CACHE_VERSION = 1;

export type CacheMode = 'readwrite' | 'readonly' | 'replay' | 'off';

/** Canonical JSON: object keys sorted recursively so equal requests hash equally. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Deterministic key over judge identity (type/preset), model, prompt version, diff, changed files and specs. */
export function cacheKey(judgeName: string, request: JudgeRequest): string {
  return createHash('sha256')
    .update(canonical({ v: CACHE_VERSION, judge: judgeName, request }))
    .digest('hex');
}

export function cacheMode(env: NodeJS.ProcessEnv = process.env): CacheMode {
  const m = env.TESTSCOPE_JUDGE_CACHE;
  return m === 'readonly' || m === 'replay' || m === 'off' ? m : 'readwrite';
}

/**
 * Wraps a judge with an on-disk answer cache so repeated runs over the same change agree.
 * `replay` never calls the judge (misses fail with judge-cache-miss): use it for backtests and parity checks.
 */
export class CachedJudge implements Judge {
  readonly name: string;
  private readonly inner: Judge;
  private readonly dir: string;
  private readonly mode: CacheMode;
  hits = 0;
  misses = 0;
  constructor(inner: Judge, dir: string, mode: CacheMode = 'readwrite') {
    this.inner = inner;
    this.name = inner.name;
    this.dir = dir;
    this.mode = mode;
  }

  async score(request: JudgeRequest, options: { timeoutMs: number }) {
    if (this.mode === 'off') return this.inner.score(request, options);
    const specs = Object.keys(request.specs);
    const file = path.join(this.dir, `${cacheKey(this.inner.name, request)}.json`);
    const cached = await readFile(file, 'utf8').then(
      (t) => JSON.parse(t) as { scores: unknown },
      () => undefined,
    );
    if (cached) {
      try {
        const scores = checkScores(cached.scores, specs);
        this.hits++;
        return scores;
      } catch {}
    }
    this.misses++;
    if (this.mode === 'replay') throw new JudgeError('judge-cache-miss');
    const scores = await this.inner.score(request, options);
    if (this.mode === 'readwrite') {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${canonical({ scores })}\n`);
      await rename(tmp, file);
    }
    return scores;
  }
}

export function cacheDir(cache: boolean | string, root: string): string | undefined {
  if (cache === false) return undefined;
  return path.resolve(root, cache === true ? '.testscope-cache/judge' : cache);
}
