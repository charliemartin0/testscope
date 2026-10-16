import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, replayChangedFilenames } from '../src/git.js';

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ts-git-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '-b', 'main');
  run('config', 'user.email', 't@example.test');
  run('config', 'user.name', 't');
  await writeFile(path.join(dir, 'a.ts'), 'a');
  await writeFile(path.join(dir, 'b.ts'), 'b');
  run('add', '.');
  run('commit', '-m', 'base');
  return dir;
}

describe('replayChangedFilenames', () => {
  it('baseline mode: two-dot diff against the baseline lists exactly the replayed files', async () => {
    const dir = await makeRepo();
    const names = await replayChangedFilenames(dir, ['a.ts', 'gone.ts'], 'baseline', async (baseline, env) =>
      (await git(dir, ['diff', '--name-only', baseline], env)).split('\n').filter(Boolean).sort()
    );
    expect(names).toEqual(['a.ts', 'gone.ts']);
  });

  it('head mode: three-dot diff (what `vitest --changed` runs) lists exactly the replayed files', async () => {
    const dir = await makeRepo();
    const names = await replayChangedFilenames(dir, ['b.ts'], 'head', async (baseline, env) =>
      (await git(dir, ['diff', '--name-only', `${baseline}...HEAD`], env)).split('\n').filter(Boolean)
    );
    expect(names).toEqual(['b.ts']);
  });

  it('leaves the real repository HEAD, index and worktree untouched', async () => {
    const dir = await makeRepo();
    const before = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    await replayChangedFilenames(dir, ['a.ts'], 'head', async () => undefined);
    expect((await git(dir, ['rev-parse', 'HEAD'])).trim()).toBe(before);
    expect((await git(dir, ['status', '--porcelain'])).trim()).toBe('');
  });
});
