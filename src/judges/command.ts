import { spawn } from 'node:child_process';
import { type Judge, JudgeError, type JudgeRequest, checkScores } from '../judge.ts';

/**
 * Local judge: runs `command` through the shell with the JudgeRequest JSON on stdin and expects
 * `{ "scores": { "<spec>": 0..1 } }` on stdout. Works offline and with any local model.
 */
export class CommandJudge implements Judge {
  readonly name = 'command';
  private readonly command: string;
  private readonly cwd: string;
  constructor(command: string, cwd: string) {
    this.command = command;
    this.cwd = cwd;
  }

  score(
    request: JudgeRequest,
    { timeoutMs }: { timeoutMs: number },
  ): Promise<Record<string, number>> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, {
        cwd: this.cwd,
        shell: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let out = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (d) => {
        out += d;
      });
      child.on('error', () => reject(new JudgeError('judge-command-error')));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new JudgeError('judge-timeout'));
        if (code !== 0) return reject(new JudgeError('judge-command-error'));
        try {
          resolve(checkScores(JSON.parse(out)?.scores, Object.keys(request.specs)));
        } catch (e) {
          reject(e instanceof JudgeError ? e : new JudgeError('judge-invalid-answer'));
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(request));
    });
  }
}
