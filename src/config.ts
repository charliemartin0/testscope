import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TestscopeConfig } from './types.ts';

export const CONFIG_FILE = 'testscope.config.json';

export const DEFAULT_SHARED = [
  '**/{package.json,package-lock.json,yarn.lock,pnpm-lock.yaml,bun.lockb,bun.lock}',
  '**/{playwright,vitest,jest}.config.*',
  '**/fixtures/**',
  '**/.env*',
  '**/{openapi,swagger}*.{json,yaml,yml}',
  'testscope.config.json',
];

export const DEFAULTS: TestscopeConfig = {
  root: '.',
  runner: { type: 'playwright', onlyChanged: true },
  manifest: { path: 'testscope.manifest.json' },
  smoke: { specs: [] },
  shared: DEFAULT_SHARED,
  ignore: [],
  extraDiffRoots: [],
  judge: { type: 'none', threshold: 0.25, timeoutMs: 15000, cache: true },
  policy: { onJudgeError: 'smoke', onAllSelected: 'all', onUnmapped: 'smoke' },
  workers: 2,
};

const POLICIES = ['smoke', 'all', 'manifest', 'fail'];
const TOP = [
  '$schema',
  'root',
  'runner',
  'manifest',
  'smoke',
  'shared',
  'ignore',
  'extraDiffRoots',
  'judge',
  'policy',
  'workers',
];

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid testscope config:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');

function relPath(v: unknown, at: string, issues: string[]) {
  if (typeof v !== 'string' || !v) return issues.push(`${at} must be a non-empty string`);
  if (path.isAbsolute(v) || v.split(/[\\/]/).includes('..'))
    issues.push(`${at} must be a relative path inside the repository`);
}

function keys(o: Obj, allowed: string[], at: string, issues: string[]) {
  for (const k of Object.keys(o))
    if (!allowed.includes(k)) issues.push(`${at}.${k} is not a known field`);
}

/** Validate a parsed config and merge it over the defaults. Throws ConfigError listing every issue. */
export function resolveConfig(input: unknown): TestscopeConfig {
  const issues: string[] = [];
  if (!isObj(input)) throw new ConfigError(['config must be a JSON object']);
  keys(input, TOP, 'config', issues);
  const c = input;

  if (c.root !== undefined) relPath(c.root, 'root', issues);

  const runner = c.runner ?? {};
  if (!isObj(runner)) issues.push('runner must be an object');
  else {
    keys(
      runner,
      ['type', 'projects', 'projectsEnv', 'smokeGrep', 'outputDir', 'onlyChanged'],
      'runner',
      issues,
    );
    if (runner.type !== undefined && runner.type !== 'playwright')
      issues.push('runner.type must be "playwright"');
    if (runner.projects !== undefined && !isStrArr(runner.projects))
      issues.push('runner.projects must be an array of strings');
    for (const k of ['projectsEnv', 'smokeGrep'])
      if (runner[k] !== undefined && typeof runner[k] !== 'string')
        issues.push(`runner.${k} must be a string`);
    if (runner.projectsEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/i.test(String(runner.projectsEnv)))
      issues.push('runner.projectsEnv must be an environment variable name');
    if (runner.onlyChanged !== undefined && typeof runner.onlyChanged !== 'boolean')
      issues.push('runner.onlyChanged must be a boolean');
    if (runner.outputDir !== undefined) relPath(runner.outputDir, 'runner.outputDir', issues);
  }

  const manifest = c.manifest ?? {};
  if (!isObj(manifest)) issues.push('manifest must be an object');
  else {
    keys(manifest, ['path'], 'manifest', issues);
    if (manifest.path !== undefined) relPath(manifest.path, 'manifest.path', issues);
  }

  const smoke = c.smoke ?? {};
  if (!isObj(smoke)) issues.push('smoke must be an object');
  else {
    keys(smoke, ['specs', 'canary'], 'smoke', issues);
    if (smoke.specs !== undefined && !isStrArr(smoke.specs))
      issues.push('smoke.specs must be an array of strings');
    if (smoke.canary !== undefined && typeof smoke.canary !== 'string')
      issues.push('smoke.canary must be a string');
  }

  for (const k of ['shared', 'ignore', 'extraDiffRoots'])
    if (c[k] !== undefined && !isStrArr(c[k])) issues.push(`${k} must be an array of strings`);
  if (isStrArr(c.extraDiffRoots))
    c.extraDiffRoots.forEach((r, i) => relPath(r, `extraDiffRoots[${i}]`, issues));

  const judge = c.judge ?? {};
  if (!isObj(judge)) issues.push('judge must be an object');
  else {
    keys(
      judge,
      ['type', 'url', 'apiKeyEnv', 'model', 'command', 'threshold', 'timeoutMs', 'cache'],
      'judge',
      issues,
    );
    const type = judge.type ?? 'none';
    if (!['none', 'http', 'command'].includes(String(type)))
      issues.push('judge.type must be none, http or command');
    if (type === 'http') {
      try {
        const u = new URL(String(judge.url));
        if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1')
          issues.push('judge.url must use https (http is allowed only for localhost)');
      } catch {
        issues.push('judge.url must be a valid URL when judge.type is "http"');
      }
    }
    if (type === 'command' && (typeof judge.command !== 'string' || !judge.command))
      issues.push('judge.command is required when judge.type is "command"');
    if (judge.apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/i.test(String(judge.apiKeyEnv)))
      issues.push('judge.apiKeyEnv must be the NAME of an environment variable, not a key');
    if (judge.model !== undefined && typeof judge.model !== 'string')
      issues.push('judge.model must be a string');
    const t = judge.threshold;
    if (t !== undefined && (typeof t !== 'number' || !(t >= 0 && t <= 1)))
      issues.push('judge.threshold must be a number between 0 and 1');
    const ms = judge.timeoutMs;
    if (ms !== undefined && (!Number.isInteger(ms) || (ms as number) <= 0))
      issues.push('judge.timeoutMs must be a positive integer');
    if (
      judge.cache !== undefined &&
      typeof judge.cache !== 'boolean' &&
      typeof judge.cache !== 'string'
    )
      issues.push('judge.cache must be a boolean or a cache directory');
  }

  const policy = c.policy ?? {};
  if (!isObj(policy)) issues.push('policy must be an object');
  else {
    keys(policy, ['onJudgeError', 'onAllSelected', 'onUnmapped', 'maxSpecs'], 'policy', issues);
    for (const k of ['onJudgeError', 'onAllSelected', 'onUnmapped'])
      if (policy[k] !== undefined && !POLICIES.includes(String(policy[k])))
        issues.push(`policy.${k} must be one of ${POLICIES.join('|')}`);
    if (
      policy.maxSpecs !== undefined &&
      (!Number.isInteger(policy.maxSpecs) || (policy.maxSpecs as number) < 1)
    )
      issues.push('policy.maxSpecs must be a positive integer');
  }

  if (c.workers !== undefined && (!Number.isInteger(c.workers) || (c.workers as number) < 1))
    issues.push('workers must be a positive integer');

  if (issues.length) throw new ConfigError(issues);

  const o = (v: unknown) => (isObj(v) ? v : {});
  return {
    root: (c.root as string) ?? DEFAULTS.root,
    runner: { ...DEFAULTS.runner, ...o(c.runner) } as TestscopeConfig['runner'],
    manifest: { ...DEFAULTS.manifest, ...o(c.manifest) } as TestscopeConfig['manifest'],
    smoke: { ...DEFAULTS.smoke, ...o(c.smoke) } as TestscopeConfig['smoke'],
    shared: (c.shared as string[]) ?? DEFAULTS.shared,
    ignore: (c.ignore as string[]) ?? DEFAULTS.ignore,
    extraDiffRoots: (c.extraDiffRoots as string[]) ?? DEFAULTS.extraDiffRoots,
    judge: { ...DEFAULTS.judge, ...o(c.judge) } as TestscopeConfig['judge'],
    policy: { ...DEFAULTS.policy, ...o(c.policy) } as TestscopeConfig['policy'],
    workers: (c.workers as number) ?? DEFAULTS.workers,
  };
}

/** Read and validate `testscope.config.json` (or an explicit path). */
export async function loadConfig(
  file = CONFIG_FILE,
  cwd = process.cwd(),
): Promise<TestscopeConfig> {
  const full = path.resolve(cwd, file);
  let text: string;
  try {
    text = await readFile(full, 'utf8');
  } catch {
    throw new ConfigError([`cannot read ${file}`]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError([`${file} is not valid JSON: ${(e as Error).message}`]);
  }
  return resolveConfig(parsed);
}
