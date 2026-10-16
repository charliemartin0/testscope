import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const MAX_PATCH_CHARS = 100_000;

export async function git(
  repoRoot: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd: repoRoot,
    env: env ?? process.env,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

export interface DiffResult {
  base: string;
  head: string;
  /** Repo-root-relative POSIX paths. */
  changedFiles: string[];
  /** `--stat --patch` text. */
  patch: string;
  /** `--stat` text only. */
  stat: string;
}

/** Changed file names (repo-root-relative) for merge-base(base, head)..head across the whole repository. */
export async function changedFilesBetween(repoRoot: string, base: string, head: string): Promise<string[]> {
  return (await git(repoRoot, ['diff', '--name-only', '-z', '--no-renames', base, head]))
    .split('\0')
    .filter(Boolean);
}

/** Diff of merge-base(base, head)..head, restricted to pathspecs (repo-root-relative; '' or '.' = whole repo). */
export async function readDiff(
  repoRoot: string,
  baseRef: string,
  headRef: string,
  pathspecs: string[] = []
): Promise<DiffResult> {
  const base = (await git(repoRoot, ['merge-base', baseRef, headRef])).trim();
  const head = (await git(repoRoot, ['rev-parse', `${headRef}^{commit}`])).trim();
  const specs = pathspecs.map((spec) => spec || '.');
  const tail = specs.length ? ['--', ...specs] : [];
  const changedFiles = (
    await git(repoRoot, ['diff', '--name-only', '-z', '--no-renames', base, head, ...tail])
  )
    .split('\0')
    .filter(Boolean);
  const common = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
  const patch = await git(repoRoot, [...common, '--stat', '--patch', base, head, ...tail]);
  const stat = await git(repoRoot, [...common, '--stat', base, head, ...tail]);
  return { base, head, changedFiles, patch, stat };
}

/** Keep model state under the 64k-token request limit: huge patches degrade to `--stat` only. */
export function limitPatch(patch: string, stat: string): { patch: string; truncated: boolean } {
  if (patch.length <= MAX_PATCH_CHARS) return { patch, truncated: false };
  return { patch: stat.slice(0, MAX_PATCH_CHARS), truncated: true };
}

/**
 * How a replay exposes historical changed filenames to a dependency-based collector:
 * - `baseline`: the baseline is a commit equal to HEAD with those files overwritten by a dummy blob
 *   (two-dot comparison, e.g. `playwright --only-changed=<comparison>`);
 * - `head`: HEAD itself is a private commit on top of the real HEAD whose tree has those files overwritten
 *   and the baseline is the real HEAD (three-dot comparison, e.g. `vitest --changed=<sha>`, which runs
 *   `git diff <sha>...HEAD`).
 */
export type ReplayMode = 'baseline' | 'head';

/**
 * Replay historical changed filenames against today's tree in an owned temporary Git database.
 * Only the private index/HEAD changes; the user's worktree, refs and index are untouched.
 * `fn` receives the baseline commit and an env that points git at the private database.
 */
export async function replayChangedFilenames<T>(
  repoRoot: string,
  changedFiles: string[],
  mode: ReplayMode,
  fn: (baseline: string, env: NodeJS.ProcessEnv) => Promise<T>
): Promise<T> {
  const current = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  const dir = await mkdtemp(path.join(tmpdir(), 'testscope-git-'));
  try {
    await exec('git', ['init', '--bare', dir]);
    const common = (
      await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).trim();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_DIR: dir,
      GIT_COMMON_DIR: dir,
      GIT_WORK_TREE: repoRoot,
      GIT_INDEX_FILE: path.join(dir, 'index'),
      GIT_OBJECT_DIRECTORY: path.join(dir, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(common, 'objects'),
    };
    const privateGit = (args: string[]) => git(repoRoot, args, env);
    await privateGit(['read-tree', current]);
    await writeFile(path.join(dir, 'comparison'), 'historical comparison');
    const blob = (await privateGit(['hash-object', '-w', path.join(dir, 'comparison')])).trim();
    for (const file of changedFiles) {
      await privateGit(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`]);
    }
    const tree = (await privateGit(['write-tree'])).trim();
    const author = {
      GIT_AUTHOR_NAME: 'testscope',
      GIT_AUTHOR_EMAIL: 'testscope@example.test',
      GIT_COMMITTER_NAME: 'testscope',
      GIT_COMMITTER_EMAIL: 'testscope@example.test',
    };
    const parents = mode === 'head' ? ['-p', current] : [];
    const replayed = (
      await git(repoRoot, ['commit-tree', tree, ...parents, '-m', 'historical filenames'], {
        ...env,
        ...author,
      })
    ).trim();
    const privateHead = mode === 'head' ? replayed : current;
    await privateGit(['update-ref', 'HEAD', privateHead]);
    await privateGit(['read-tree', privateHead]);
    return await fn(mode === 'head' ? current : replayed, env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** True when tracked or untracked changes exist under pathspecs. */
export async function isDirty(repoRoot: string, pathspecs: string[]): Promise<boolean> {
  const specs = pathspecs.map((spec) => spec || '.');
  const tracked = await git(repoRoot, ['diff', '--name-only', 'HEAD', '--', ...specs]);
  const untracked = await git(repoRoot, ['ls-files', '--others', '--exclude-standard', '--', ...specs]);
  return Boolean(tracked.trim() || untracked.trim());
}
