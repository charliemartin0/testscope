import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, DEFAULTS, loadConfig, resolveConfig } from '../src/config.ts';

test('empty config resolves to defaults', () => {
  assert.deepEqual(resolveConfig({}), DEFAULTS);
  assert.equal(DEFAULTS.judge.threshold, 0.25);
  assert.equal(DEFAULTS.judge.timeoutMs, 15000);
  assert.equal(DEFAULTS.workers, 2);
});

test('partial sections merge over defaults', () => {
  const c = resolveConfig({ judge: { threshold: 0.5 }, policy: { maxSpecs: 10 } });
  assert.equal(c.judge.threshold, 0.5);
  assert.equal(c.judge.timeoutMs, 15000);
  assert.equal(c.policy.maxSpecs, 10);
  assert.equal(c.policy.onUnmapped, 'smoke');
});

test('collects every issue', () => {
  try {
    resolveConfig({
      root: '../outside',
      bogus: 1,
      judge: { type: 'http', url: 'http://example.com', threshold: 2, apiKeyEnv: 'sk-live abc' },
      policy: { onUnmapped: 'maybe', maxSpecs: 0 },
      workers: 0,
    });
    assert.fail('expected ConfigError');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    const text = e.issues.join('\n');
    for (const needle of [
      'root',
      'config.bogus',
      'judge.url',
      'judge.threshold',
      'apiKeyEnv',
      'onUnmapped',
      'maxSpecs',
      'workers',
    ])
      assert.match(text, new RegExp(needle.replace('.', '\\.')));
  }
});

test('command judge requires a command', () => {
  assert.throws(() => resolveConfig({ judge: { type: 'command' } }), /judge\.command/);
  assert.equal(
    resolveConfig({ judge: { type: 'command', command: './score.sh' } }).judge.type,
    'command',
  );
});

test('http judge allows localhost over http', () => {
  assert.equal(
    resolveConfig({ judge: { type: 'http', url: 'http://localhost:8080/score' } }).judge.type,
    'http',
  );
});

test('loadConfig reads and reports bad files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'testscope-'));
  await writeFile(path.join(dir, 'testscope.config.json'), JSON.stringify({ root: 'web' }));
  assert.equal((await loadConfig(undefined, dir)).root, 'web');
  await writeFile(path.join(dir, 'bad.json'), '{');
  await assert.rejects(loadConfig('bad.json', dir), /not valid JSON/);
  await assert.rejects(loadConfig('missing.json', dir), /cannot read/);
});

test('example config validates', async () => {
  const c = await loadConfig(
    'testscope.config.example.json',
    path.resolve(import.meta.dirname, '..'),
  );
  assert.equal(c.policy.onAllSelected, 'smoke');
});
