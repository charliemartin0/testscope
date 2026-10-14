import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { resolveConfig } from '../src/config.ts';
import { type Judge, type JudgeRequest, buildRequest } from '../src/judge.ts';
import { CachedJudge, cacheDir, cacheKey, cacheMode, canonical } from '../src/judges/cache.ts';
import { createJudge } from '../src/judges/index.ts';
import { manifest } from './helpers.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'testscope-cache-'));
  dirs.push(d);
  return d;
};

class Counting implements Judge {
  readonly name = 'counting';
  calls = 0;
  value = 0.4;
  async score(r: JudgeRequest) {
    this.calls++;
    return Object.fromEntries(Object.keys(r.specs).map((s) => [s, this.value]));
  }
}

const req = buildRequest(manifest, ['a.ts'], 'patch', { model: 'm' });

test('canonical JSON and keys are order independent and sensitive to inputs', () => {
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: undefined }] }), '{"a":[{"d":2}],"b":1}');
  const reordered = { ...req, specs: Object.fromEntries(Object.entries(req.specs).reverse()) };
  assert.equal(cacheKey('x', req), cacheKey('x', reordered));
  assert.notEqual(cacheKey('x', req), cacheKey('y', req));
  assert.notEqual(cacheKey('x', req), cacheKey('x', { ...req, model: 'other' }));
  assert.notEqual(cacheKey('x', req), cacheKey('x', { ...req, diffSummary: 'patch2' }));
  assert.match(cacheKey('x', req), /^[0-9a-f]{64}$/);
});

test('readwrite caches answers so repeat runs agree', async () => {
  const inner = new Counting();
  const dir = tmp();
  const first = await new CachedJudge(inner, dir).score(req, { timeoutMs: 1 });
  inner.value = 0.9; // a non-deterministic model would answer differently now
  const cached = new CachedJudge(inner, dir);
  assert.deepEqual(await cached.score(req, { timeoutMs: 1 }), first);
  assert.equal(inner.calls, 1);
  assert.equal(cached.hits, 1);
  assert.equal(readdirSync(dir).length, 1);
});

test('replay never calls the judge; readonly does not write; off bypasses', async () => {
  const inner = new Counting();
  const dir = tmp();
  await assert.rejects(
    new CachedJudge(inner, dir, 'replay').score(req, { timeoutMs: 1 }),
    /judge-cache-miss/,
  );
  assert.equal(inner.calls, 0);
  await new CachedJudge(inner, dir, 'readonly').score(req, { timeoutMs: 1 });
  assert.equal(readdirSync(dir).length, 0);
  await new CachedJudge(inner, dir, 'off').score(req, { timeoutMs: 1 });
  assert.equal(inner.calls, 2);
});

test('cache settings come from config and env', () => {
  assert.equal(cacheDir(false, '/r'), undefined);
  assert.equal(cacheDir(true, '/r'), path.resolve('/r/.testscope-cache/judge'));
  assert.equal(cacheDir('answers', '/r'), path.resolve('/r/answers'));
  assert.equal(cacheMode({ TESTSCOPE_JUDGE_CACHE: 'replay' }), 'replay');
  assert.equal(cacheMode({}), 'readwrite');
  const j = createJudge(resolveConfig({ judge: { type: 'command', command: 'x' } }).judge, '/r');
  assert.ok(j instanceof CachedJudge);
  const raw = createJudge(
    resolveConfig({ judge: { type: 'command', command: 'x', cache: false } }).judge,
    '/r',
  );
  assert.ok(!(raw instanceof CachedJudge));
});
