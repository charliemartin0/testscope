import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DEFAULTS, resolveConfig } from '../src/config.ts';
import { describeSpec, generateManifest, syncManifest } from '../src/manifest.ts';

const cfg = resolveConfig({
  manifest: {
    path: 'e2e/manifest.json',
    groupPattern: '^e2e/([^/]+)/',
    sourceRules: [
      { match: '^e2e/([^/]+)/([^/]+)/', sources: ['src/$1/$2/**', 'src/$1/shared/**'] },
    ],
  },
}).manifest;

const SPEC = `
import { test } from '@playwright/test';
test.describe.serial('Users list', () => {
  test('loads @smoke', async ({ page }) => {
    await page.goto('/users');
    await page.goto("/users?page=2");
    await page.goto(\`/users/\${id}\`);
  });
});
`;

test('describeSpec extracts routes, title, smoke, group and sources', () => {
  assert.deepEqual(describeSpec('e2e/admin/users/list.spec.ts', SPEC, cfg), {
    routes: ['/users', '/users/', '/users?page=2'],
    title: 'Users list',
    smoke: true,
    group: 'admin',
    sources: ['src/admin/shared/**', 'src/admin/users/**'],
  });
});

test('describeSpec falls back to the file name and no smoke', () => {
  const e = describeSpec('e2e/x/plain.spec.ts', "test('a', () => {})", DEFAULTS.manifest);
  assert.deepEqual(e, { routes: [], title: 'plain', smoke: false });
  assert.equal(
    describeSpec('a.spec.ts', "test('@smoker', () => {})", DEFAULTS.manifest).smoke,
    false,
  );
});

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('generateManifest scans spec globs deterministically and --check detects staleness', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'testscope-manifest-'));
  dirs.push(root);
  const put = (f: string, c: string) => {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), c);
  };
  put('e2e/b/two/z.spec.ts', SPEC);
  put('e2e/a/one/y.spec.ts', "test.describe('Y', () => {})");
  put('e2e/a/one/helper.ts', 'export {}');
  put('node_modules/pkg/x.spec.ts', SPEC);
  const m = await generateManifest(root, cfg);
  assert.deepEqual(Object.keys(m), ['e2e/a/one/y.spec.ts', 'e2e/b/two/z.spec.ts']);
  assert.equal(await syncManifest(root, cfg, true), false);
  assert.equal(await syncManifest(root, cfg), true);
  assert.equal(await syncManifest(root, cfg, true), true);
  assert.equal(
    JSON.parse(readFileSync(path.join(root, 'e2e/manifest.json'), 'utf8'))['e2e/a/one/y.spec.ts']
      .group,
    'a',
  );
  put('e2e/a/one/new.spec.ts', '');
  assert.equal(await syncManifest(root, cfg, true), false);
});

test('invalid manifest regexes and rules are rejected', () => {
  assert.throws(
    () => resolveConfig({ manifest: { groupPattern: '(' } }),
    /invalid regular expression/,
  );
  assert.throws(
    () => resolveConfig({ manifest: { sourceRules: [{ match: 'x' }] } }),
    /sourceRules/,
  );
});
