import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { GitError, mergeBase, readDiff, resolveCommit, workingTreeChanges } from '../src/git.ts';
import { Fixture } from './fixture.ts';

const repos: Fixture[] = [];
after(() => {
  for (const r of repos) r.cleanup();
});
const fixture = () => {
  const f = new Fixture();
  repos.push(f);
  return f;
};

const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');

test('readDiff reports modified, added, deleted and renamed files against the merge base', async () => {
  const f = fixture();
  f.commit('base', { 'web/a.ts': 'a', 'web/old.ts': long, 'web/gone.ts': 'g', 'api/x.go': 'x' });
  f.git('checkout', '-q', '-b', 'feature');
  f.git('mv', 'web/old.ts', 'web/new.ts');
  f.git('rm', '-q', 'web/gone.ts');
  f.commit('feature', { 'web/a.ts': 'a2', 'web/added.ts': 'n' });
  f.git('checkout', '-q', 'main');
  f.commit('main moves on', { 'web/main-only.ts': 'm' });
  const d = await readDiff({ cwd: f.dir, base: 'main', head: 'feature' });
  assert.deepEqual(
    d.changes.sort((x, y) => x.path.localeCompare(y.path)),
    [
      { status: 'modified', path: 'web/a.ts' },
      { status: 'added', path: 'web/added.ts' },
      { status: 'deleted', path: 'web/gone.ts' },
      { status: 'renamed', path: 'web/new.ts', oldPath: 'web/old.ts' },
    ],
  );
  assert.match(d.patch, /a2/);
  const scoped = await readDiff({ cwd: f.dir, base: 'main', head: 'feature', paths: ['api'] });
  assert.deepEqual(scoped.changes, []);
});

test('mergeBase false compares trees directly', async () => {
  const f = fixture();
  f.commit('base', { 'a.ts': '1' });
  f.git('checkout', '-q', '-b', 'feature');
  f.commit('f', { 'b.ts': 'bee' });
  f.git('checkout', '-q', 'main');
  f.commit('m', { 'c.ts': 'sea' });
  const d = await readDiff({
    cwd: f.dir,
    base: 'main',
    head: 'feature',
    mergeBase: false,
    withPatch: false,
  });
  assert.deepEqual(d.changes.map((c) => `${c.status}:${c.path}`).sort(), [
    'added:b.ts',
    'deleted:c.ts',
  ]);
});

test('unknown refs raise a helpful GitError', async () => {
  const f = fixture();
  f.commit('base', { 'a.ts': '1' });
  await assert.rejects(
    resolveCommit('nope', f.dir),
    (e: unknown) => e instanceof GitError && e.code === 'unknown-ref',
  );
});

test('unrelated histories have no merge base', async () => {
  const f = fixture();
  f.commit('one', { 'a.ts': '1' });
  f.git('checkout', '-q', '--orphan', 'other');
  f.commit('two', { 'b.ts': '1' });
  await assert.rejects(mergeBase('main', 'other', { cwd: f.dir }), /share no history/);
});

test('shallow clones are deepened until the merge base is found', async () => {
  const origin = fixture();
  origin.commit('root', { 'a.ts': '0' });
  for (let i = 0; i < 5; i++) origin.commit(`main ${i}`, { 'a.ts': String(i) });
  const fork = origin.git('rev-parse', 'HEAD').trim();
  origin.git('checkout', '-q', '-b', 'feature');
  for (let i = 0; i < 3; i++) origin.commit(`feature ${i}`, { 'f.ts': String(i) });
  origin.git('checkout', '-q', 'main');
  origin.commit('main after', { 'm.ts': '1' });

  const clone = fixture();
  clone.git(
    'fetch',
    '-q',
    '--depth=1',
    `file://${origin.dir}`,
    'main:refs/remotes/origin/main',
    'feature:feature',
  );
  clone.git('remote', 'add', 'origin', `file://${origin.dir}`);
  assert.equal(clone.git('rev-parse', '--is-shallow-repository').trim(), 'true');
  const base = await mergeBase('origin/main', 'feature', { cwd: clone.dir });
  assert.equal(base, fork);
});

test('workingTreeChanges includes untracked files', async () => {
  const f = fixture();
  f.commit('base', { 'a.ts': '1' });
  f.write({ 'a.ts': '2', 'new.ts': 'n' });
  assert.deepEqual((await workingTreeChanges(f.dir)).map((c) => c.path).sort(), ['a.ts', 'new.ts']);
});
