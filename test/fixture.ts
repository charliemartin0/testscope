import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** Throwaway git repository for tests. */
export class Fixture {
  readonly dir: string;
  constructor(dir?: string) {
    this.dir = dir ?? mkdtempSync(path.join(tmpdir(), 'testscope-git-'));
    if (!dir) this.git('init', '-q', '-b', 'main');
  }
  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, env: ENV, encoding: 'utf8' });
  }
  write(files: Record<string, string>) {
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(this.dir, f)), { recursive: true });
      writeFileSync(path.join(this.dir, f), c);
    }
    return this;
  }
  commit(message: string, files: Record<string, string> = {}): string {
    this.write(files);
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.git('rev-parse', 'HEAD').trim();
  }
  cleanup() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
