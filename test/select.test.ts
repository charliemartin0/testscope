import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { main } from '../src/cli.ts';
import { openWorkspace, selectPlan } from '../src/commands/select.ts';
import { resolveConfig } from '../src/config.ts';
import { readPlanFile } from '../src/plan-file.ts';
import { Fixture } from './fixture.ts';
import { manifest } from './helpers.ts';

const repos: Fixture[] = [];
after(() => {
  for (const r of repos) r.cleanup();
});

function repo(cfg: Record<string, unknown> = {}) {
  const f = new Fixture();
  repos.push(f);
  f.commit('base', {
    'testscope.config.json': JSON.stringify({
      root: 'web',
      manifest: { path: 'e2e/manifest.json' },
      smoke: { specs: ['e2e/shell/home.spec.ts'], canary: 'e2e/shell/canary.spec.ts' },
      ...cfg,
    }),
    'web/e2e/manifest.json': JSON.stringify(manifest),
    'web/src/users/a.ts': 'a',
    'web/src/misc.ts': 'm',
    'web/package.json': '{}',
  });
  f.git('checkout', '-q', '-b', 'feature');
  return f;
}

const ws = async (f: Fixture) => {
  const config = resolveConfig(
    JSON.parse(readFileSync(path.join(f.dir, 'testscope.config.json'), 'utf8')),
  );
  return openWorkspace(config, f.dir, f.dir);
};

test('selectPlan maps a source change and writes a stable plan', async () => {
  const f = repo({ runner: { onlyChanged: false } });
  const head = f.commit('change', { 'web/src/users/a.ts': 'a2' });
  const plan = await selectPlan(await ws(f), { base: 'main' });
  assert.equal(plan.version, 1);
  assert.equal(plan.head, head);
  assert.equal(plan.mode, 'selected');
  assert.deepEqual(plan.selected, ['e2e/shell/canary.spec.ts', 'e2e/users/list.spec.ts']);
  assert.deepEqual(Object.keys(plan).slice(0, 5), ['version', 'base', 'head', 'mode', 'total']);
});

test('runner collection failure follows onJudgeError', async () => {
  const f = repo(); // onlyChanged defaults to true; Playwright is not installed in the fixture
  f.commit('change', { 'web/src/users/a.ts': 'a2' });
  const w = await ws(f);
  const runner = {
    name: 'x',
    run: async () => 0,
    listChanged: async () => Promise.reject(new Error('boom')),
  };
  const plan = await selectPlan(w, { base: 'main', runner });
  assert.equal(plan.mode, 'smoke-fallback');
  assert.equal(plan.fallbackReason, 'runner-collection-error');
});

test('require-trimmed downgrades shared changes to smoke', async () => {
  const f = repo({ runner: { onlyChanged: false } });
  f.commit('change', { 'web/package.json': '{"x":1}' });
  const plan = await selectPlan(await ws(f), { base: 'main', requireTrimmed: true });
  assert.equal(plan.mode, 'smoke-fallback');
  assert.deepEqual(plan.downgradedFrom, { mode: 'all', selectedCount: 5 });
  const loose = await selectPlan(await ws(f), { base: 'main' });
  assert.equal(loose.mode, 'all');
});

test('cli select --json --out and saved-plan validation', async () => {
  const f = repo({ runner: { onlyChanged: false } });
  const head = f.commit('change', { 'web/src/users/a.ts': 'a2' });
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'testscope-out-')), 'plan.json');
  const cwd = process.cwd();
  let printed = '';
  try {
    process.chdir(f.dir);
    assert.equal(
      await main(['select', '--base', 'main', '--json', '--out', out], {
        write: (x: string) => {
          printed += x;
        },
      }),
      0,
    );
  } finally {
    process.chdir(cwd);
  }
  assert.equal(JSON.parse(printed).head, head);
  const w = await ws(f);
  assert.equal((await readPlanFile(out, head, w.manifest)).selected.length, 2);
  await assert.rejects(readPlanFile(out, 'deadbeef', w.manifest), /different HEAD/);
});
