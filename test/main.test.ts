import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Adapter, Collected } from '../src/types.js';

const KEY = 'sk-test-super-secret-key';

const mocks = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  outputs: {} as Record<string, string>,
  logged: [] as string[],
  setFailed: vi.fn(),
  collect: vi.fn(),
}));

vi.mock('@actions/core', () => ({
  getInput: (name: string) => mocks.inputs[name] ?? '',
  setOutput: (name: string, value: string) => {
    mocks.outputs[name] = value;
    mocks.logged.push(`${name}=${value}`);
  },
  setSecret: (value: string) => void mocks.logged.push(`setSecret(${value.length})`),
  warning: (message: string) => void mocks.logged.push(`warning:${message}`),
  info: (message: string) => void mocks.logged.push(message),
  setFailed: mocks.setFailed,
}));

vi.mock('../src/report.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/report.js')>();
  return { ...original, uploadPlan: async () => {} };
});

vi.mock('../src/adapters/index.js', () => {
  const adapter: Adapter = {
    name: 'vitest',
    smokeSupported: false,
    defaultShared: () => ['package.json'],
    collect: (...args) => mocks.collect(...args),
    command: (plan) => ({ command: plan.mode === 'full' ? 'run-all' : `run ${plan.selected.join(' ')}` }),
    truth: async () => ({ ids: [], files: [] }),
  };
  return { getAdapter: () => adapter };
});

import { main } from '../src/main.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function makeRepo(content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ts-main-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 't');
  await writeFile(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'base');
  await writeFile(path.join(dir, 'a.ts'), content);
  git(dir, 'commit', '-am', 'head');
  return dir;
}

function collected(): Collected {
  return {
    candidates: [
      { id: 'a.test.ts', data: {}, question: { instructions: 'i', criteria: { true: 't', false: 'f' } } },
      { id: 'b.test.ts', data: {}, question: { instructions: 'i', criteria: { true: 't', false: 'f' } } },
    ],
    forced: new Map(),
    totalCount: 10,
    state: { patch: 'PATCH' },
  };
}

let stdout: string[];

beforeEach(() => {
  mocks.inputs = { 'typesafe-api-key': KEY, suites: 'vitest', 'base-ref': 'HEAD~1', 'vitest-working-directory': '.' };
  mocks.outputs = {};
  mocks.logged = [];
  mocks.setFailed.mockReset();
  mocks.collect.mockReset();
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('action entry', () => {
  it('never fails and still sets outputs when the selector throws', async () => {
    const repo = await makeRepo('export const a = 2;\n');
    const runner = await mkdtemp(path.join(tmpdir(), 'ts-runner-'));
    mocks.collect.mockRejectedValue(new Error('boom'));
    await main({ GITHUB_WORKSPACE: repo, RUNNER_TEMP: runner });
    expect(mocks.setFailed).not.toHaveBeenCalled();
    expect(mocks.outputs['vitest-mode']).toBe('full');
    expect(mocks.outputs['vitest-reason']).toBe('selector-error');
    expect(mocks.outputs['vitest-command']).toBe('run-all');
    expect(mocks.outputs['plan-path']).toBe(path.join(runner, 'testscope-plan.json'));
  });

  it('sets outputs even when git itself is unusable', async () => {
    const notRepo = await mkdtemp(path.join(tmpdir(), 'ts-norepo-'));
    await main({ GITHUB_WORKSPACE: notRepo, RUNNER_TEMP: notRepo });
    expect(mocks.setFailed).not.toHaveBeenCalled();
    expect(mocks.outputs['vitest-mode']).toBe('full');
    expect(mocks.outputs['vitest-reason']).toBe('selector-error');
  });

  it('selects tests from Jev answers and never leaks the key', async () => {
    const repo = await makeRepo(`export const token = '${KEY}';\n`);
    const runner = await mkdtemp(path.join(tmpdir(), 'ts-runner-'));
    const summary = path.join(runner, 'summary.md');
    await writeFile(summary, '');
    mocks.collect.mockImplementation(async (ctx: { patch: string }) => ({ ...collected(), state: { patch: ctx.patch } }));
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return new Response(
          JSON.stringify({ answers: { q_0: { type: 'noul', noul: 0.9 }, q_1: { type: 'noul', noul: 0.01 } } }),
          { status: 200 }
        );
      })
    );
    await main({ GITHUB_WORKSPACE: repo, RUNNER_TEMP: runner, GITHUB_STEP_SUMMARY: summary });
    expect(mocks.outputs['vitest-mode']).toBe('selected');
    expect(JSON.parse(mocks.outputs['vitest-selected']!)).toEqual(['a.test.ts']);
    expect(mocks.outputs['vitest-command']).toBe('run a.test.ts');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('[REDACTED]');
    const planText = await readFile(path.join(runner, 'testscope-plan.json'), 'utf8');
    const everything = [bodies[0], planText, await readFile(summary, 'utf8'), ...mocks.logged, ...stdout].join('\n');
    expect(everything).not.toContain(KEY);
  });

  it('removes the key from the process environment so repository code cannot read it', async () => {
    const repo = await makeRepo('export const a = 5;\n');
    process.env['INPUT_TYPESAFE-API-KEY'] = KEY;
    mocks.collect.mockResolvedValue({ ...collected(), candidates: [] });
    await main({ GITHUB_WORKSPACE: repo, RUNNER_TEMP: repo });
    expect(process.env['INPUT_TYPESAFE-API-KEY']).toBeUndefined();
  });

  it('dry-run reports the real reason but outputs the full suite', async () => {
    const repo = await makeRepo('export const a = 3;\n');
    const runner = await mkdtemp(path.join(tmpdir(), 'ts-runner-'));
    mocks.inputs['dry-run'] = 'true';
    mocks.inputs['typesafe-api-key'] = '';
    mocks.collect.mockResolvedValue(collected());
    await main({ GITHUB_WORKSPACE: repo, RUNNER_TEMP: runner });
    expect(mocks.outputs['vitest-mode']).toBe('full');
    expect(mocks.outputs['vitest-reason']).toBe('dry-run:jev-missing-key');
    expect(mocks.outputs['vitest-command']).toBe('run-all');
  });

  it('warns about invalid numeric inputs and uses defaults', async () => {
    const repo = await makeRepo('export const a = 4;\n');
    const runner = await mkdtemp(path.join(tmpdir(), 'ts-runner-'));
    mocks.inputs.threshold = 'banana';
    mocks.inputs['typesafe-api-key'] = '';
    mocks.collect.mockResolvedValue(collected());
    await main({ GITHUB_WORKSPACE: repo, RUNNER_TEMP: runner });
    expect(mocks.logged).toContain("warning:testscope: invalid input 'threshold'; using default 0.25");
    expect(mocks.logged.join('\n')).not.toContain('banana');
  });
});
