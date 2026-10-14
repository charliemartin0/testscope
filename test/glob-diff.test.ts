import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SHARED } from '../src/config.ts';
import { parseNameStatus } from '../src/diff.ts';
import { globToRegExp, matchesAny } from '../src/glob.ts';

test('glob basics', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.ts'));
  assert.ok(globToRegExp('**/x.ts').test('x.ts'));
  assert.ok(globToRegExp('**/x.ts').test('a/b/x.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('a?.{js,ts}').test('ab.ts'));
  assert.ok(!globToRegExp('a.ts').test('aXts'));
});

test('default shared globs', () => {
  for (const f of [
    'package.json',
    'pkg/yarn.lock',
    'playwright.config.ts',
    'e2e/fixtures/user.ts',
    '.env',
    'conf/.env.local',
    'api/openapi.yaml',
    'swagger.json',
  ])
    assert.ok(matchesAny(f, DEFAULT_SHARED), f);
  for (const f of ['src/app.ts', 'e2e/home.spec.ts', 'docs/environment.md'])
    assert.equal(matchesAny(f, DEFAULT_SHARED), undefined, f);
});

test('parseNameStatus handles renames, copies and deletes', () => {
  const out = [
    'M',
    'a.ts',
    'R087',
    'old.ts',
    'new.ts',
    'D',
    'gone.ts',
    'C100',
    'src.ts',
    'copy.ts',
    'A',
    'n.ts',
    '',
  ].join('\0');
  assert.deepEqual(parseNameStatus(out), [
    { status: 'modified', path: 'a.ts' },
    { status: 'renamed', path: 'new.ts', oldPath: 'old.ts' },
    { status: 'deleted', path: 'gone.ts' },
    { status: 'copied', path: 'copy.ts', oldPath: 'src.ts' },
    { status: 'added', path: 'n.ts' },
  ]);
  assert.throws(() => parseNameStatus('R100\0only-old'), /Truncated/);
});
