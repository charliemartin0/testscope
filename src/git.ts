import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseNameStatus } from './diff.ts';
import type { ChangedFile } from './types.ts';

const exec = promisify(execFile);

export class GitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GitError';
    this.code = code;
  }
}

export async function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string };
    throw new GitError(
      'git-failed',
      `git ${args[0]} failed: ${
        String(err.stderr ?? '')
          .trim()
          .split('\n')[0]
      }`,
    );
  }
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
}

export async function resolveCommit(ref: string, cwd: string): Promise<string> {
  try {
    return (
      await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], cwd)
    ).trim();
  } catch {
    throw new GitError(
      'unknown-ref',
      `Cannot resolve ${ref}; fetch it first (CI: actions/checkout with fetch-depth: 0)`,
    );
  }
}

export async function isShallow(cwd: string): Promise<boolean> {
  return (await git(['rev-parse', '--is-shallow-repository'], cwd)).trim() === 'true';
}

export interface MergeBaseOptions {
  cwd: string;
  /** Deepen a shallow clone this many times (50 commits each) before unshallowing. */
  deepenSteps?: number;
  remote?: string;
}

/** Merge base of base and head. In a shallow clone, progressively deepens history until one is found. */
export async function mergeBase(
  base: string,
  head: string,
  opts: MergeBaseOptions,
): Promise<string> {
  const { cwd, deepenSteps = 3, remote = 'origin' } = opts;
  const attempt = async () => {
    try {
      return (await git(['merge-base', base, head], cwd)).trim();
    } catch {
      return undefined;
    }
  };
  let found = await attempt();
  if (found) return found;
  if (!(await isShallow(cwd)))
    throw new GitError('no-merge-base', `${base} and ${head} share no history`);
  for (let i = 0; i < deepenSteps && !found; i++) {
    await git(['fetch', '--quiet', '--deepen=50', remote], cwd).catch(() => undefined);
    found = await attempt();
  }
  if (!found) {
    await git(['fetch', '--quiet', '--unshallow', remote], cwd).catch(() => undefined);
    found = await attempt();
  }
  if (!found)
    throw new GitError(
      'no-merge-base',
      `No merge base for ${base} and ${head} even after deepening`,
    );
  return found;
}

export interface DiffResult {
  base: string;
  head: string;
  changes: ChangedFile[];
  /** `--stat --patch` text for judges; may be large. */
  patch: string;
}

export interface ReadDiffOptions {
  cwd: string;
  base: string;
  head?: string;
  /** Limit to these repo-relative paths (empty = whole repo). */
  paths?: string[];
  /** Compare against the merge base (PR semantics). Default true. */
  mergeBase?: boolean;
  withPatch?: boolean;
}

export async function readDiff(opts: ReadDiffOptions): Promise<DiffResult> {
  const { cwd, paths = [], withPatch = true } = opts;
  const headSha = await resolveCommit(opts.head ?? 'HEAD', cwd);
  await resolveCommit(opts.base, cwd);
  const base =
    opts.mergeBase === false
      ? await resolveCommit(opts.base, cwd)
      : await mergeBase(opts.base, headSha, { cwd });
  const scope = ['--', ...paths];
  const names = await git(
    ['diff', '--name-status', '-z', '-M', '--no-ext-diff', base, headSha, ...scope],
    cwd,
  );
  const patch = withPatch
    ? await git(
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '-M',
          '--stat',
          '--patch',
          base,
          headSha,
          ...scope,
        ],
        cwd,
      )
    : '';
  return { base, head: headSha, changes: parseNameStatus(names), patch };
}

/** Uncommitted (staged, unstaged and untracked) changes relative to HEAD. */
export async function workingTreeChanges(
  cwd: string,
  paths: string[] = [],
): Promise<ChangedFile[]> {
  const tracked = parseNameStatus(
    await git(['diff', '--name-status', '-z', '-M', 'HEAD', '--', ...paths], cwd),
  );
  const untracked = (
    await git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths], cwd)
  )
    .split('\0')
    .filter(Boolean)
    .map((path): ChangedFile => ({ status: 'added', path }));
  return [...tracked, ...untracked];
}
