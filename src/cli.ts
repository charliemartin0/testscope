#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { applyPolicyFlags } from './commands/policy.ts';
import { isFullSuite, openWorkspace, selectPlan } from './commands/select.ts';
import { CONFIG_FILE, ConfigError, loadConfig } from './config.ts';
import { createDebug, debugEnabled } from './debug.ts';
import { explainPlan } from './explain.ts';
import { repoRoot, resolveCommit } from './git.ts';
import { buildRequest } from './judge.ts';
import { createJudge, keyEnvFor } from './judges/index.ts';
import { syncManifest } from './manifest.ts';
import { type PlanFile, readPlanFile, serializePlan } from './plan-file.ts';
import { executionGroups } from './plan.ts';
import { PlaywrightRunner, validateExtraArgs } from './runners/playwright.ts';
import {
  appendHistory,
  failedSpecs,
  formatShadow,
  readHistory,
  shadowResult,
  summarize,
} from './shadow.ts';

const HELP = `testscope <command> [options]

Commands:
  select   Compute a plan for the current change
  run      Compute (or load with --plan) a plan and execute it
  manifest [--check]  Regenerate (or verify) the spec manifest
  shadow   Compare --plan with a full run's --report; --summary prints the miss rate
  explain [SPEC]  Explain the plan, or why SPEC is or is not selected
  check-config

Options:
  --config PATH        Config file (default ${CONFIG_FILE})
  --base REF           Base ref (default origin/main)
  --head REF           Head ref (default HEAD)
  --json               Print the plan as JSON
  --out PATH           Write the plan JSON to PATH
  --plan PATH          (run) execute a saved plan
  --require-trimmed    Never select the full suite (downgrade to smoke)
  --on-unmapped P | --on-judge-error P | --on-all-selected P   Policy overrides (smoke|all|manifest|fail)
  --max-specs N        Budget cap override
  --report PATH        (shadow) Playwright JSON report or {"failed": [...]} of a full run
  --history PATH       (shadow) JSONL history (default .testscope-cache/shadow.jsonl)
  --summary            (shadow) print the aggregated shadow report
  --debug              Log each phase to stderr (also TESTSCOPE_DEBUG=1)
  -- <flags>           (run) execution flags passed to the runner, e.g. -- --repeat-each=3
`;

const OPTIONS = {
  config: { type: 'string', default: CONFIG_FILE },
  base: { type: 'string', default: 'origin/main' },
  head: { type: 'string', default: 'HEAD' },
  json: { type: 'boolean' },
  out: { type: 'string' },
  plan: { type: 'string' },
  'require-trimmed': { type: 'boolean' },
  debug: { type: 'boolean' },
  check: { type: 'boolean' },
  'on-unmapped': { type: 'string' },
  'on-judge-error': { type: 'string' },
  'on-all-selected': { type: 'string' },
  'max-specs': { type: 'string' },
  report: { type: 'string' },
  history: { type: 'string', default: '.testscope-cache/shadow.jsonl' },
  summary: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

export function summary(plan: PlanFile) {
  const why = plan.fallbackReason ? ` [${plan.fallbackReason}]` : '';
  return `testscope: ${plan.selected.length}/${plan.total} specs (${plan.mode}${plan.smokeOnly ? ', smoke only' : ''})${why}; groups=${plan.groups.join(',')}\n`;
}

export interface Out {
  write(s: string): unknown;
}

async function emit(plan: PlanFile, values: { json?: boolean; out?: string }, stdout: Out) {
  if (values.out) {
    await mkdir(path.dirname(path.resolve(values.out)), { recursive: true });
    await writeFile(values.out, serializePlan(plan), { mode: 0o600 });
  }
  stdout.write(values.json ? serializePlan(plan) : summary(plan));
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `mode=${plan.mode}\nselected_count=${plan.selected.length}\ntotal=${plan.total}\ngroups=${plan.groups.join(',')}\n`,
    );
}

export async function main(
  argv = process.argv.slice(2),
  stdout: Out = process.stdout,
): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    stdout.write(HELP);
    return 0;
  }
  const sep = rest.indexOf('--');
  const extraArgs = sep < 0 ? [] : rest.slice(sep + 1);
  const { values, positionals } = parseArgs({
    args: sep < 0 ? rest : rest.slice(0, sep),
    options: OPTIONS,
    allowPositionals: true,
  });
  if (values.help) {
    stdout.write(HELP);
    return 0;
  }
  try {
    const config = applyPolicyFlags(await loadConfig(values.config), values);
    if (cmd === 'check-config') {
      stdout.write('testscope config OK\n');
      return 0;
    }
    if (cmd === 'manifest') {
      const root = path.resolve(path.dirname(path.resolve(values.config)), config.root);
      const ok = await syncManifest(root, config.manifest, values.check);
      stdout.write(ok ? `testscope: manifest ${values.check ? 'is up to date' : 'written'}\n` : '');
      if (!ok) process.stderr.write('testscope: manifest is stale; run testscope manifest\n');
      return ok ? 0 : 1;
    }
    if (cmd === 'shadow') {
      if (values.summary) {
        const results = await readHistory(values.history);
        stdout.write(
          values.json
            ? `${JSON.stringify(summarize(results), null, 2)}\n`
            : formatShadow(summarize(results), results),
        );
        return 0;
      }
      if (!values.plan || !values.report)
        throw new Error('shadow needs --plan and --report (or --summary)');
      const root = path.resolve(path.dirname(path.resolve(values.config)), config.root);
      const plan = JSON.parse(await readFile(values.plan, 'utf8')) as PlanFile;
      const result = shadowResult(
        plan,
        failedSpecs(JSON.parse(await readFile(values.report, 'utf8')), root),
      );
      await appendHistory(values.history, result);
      stdout.write(
        values.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `testscope shadow: ${result.failed.length} failing, ${result.missed.length} missed\n`,
      );
      return 0;
    }
    if (cmd !== 'select' && cmd !== 'run' && cmd !== 'explain') {
      process.stderr.write(`testscope ${cmd}: unknown or not yet implemented command\n`);
      return 2;
    }
    const configDir = path.dirname(path.resolve(values.config));
    const ws = await openWorkspace(config, configDir, await repoRoot(configDir));
    const runner = new PlaywrightRunner({
      root: ws.root,
      runner: config.runner,
      manifest: ws.manifest,
      workers: config.workers,
    });
    validateExtraArgs(extraArgs);
    const judge = createJudge(config.judge, ws.root);
    const keyEnv = keyEnvFor(config.judge);
    const judgeFn = judge
      ? (changes: { path: string }[], patch: string) =>
          judge.score(
            buildRequest(
              ws.manifest,
              changes.map((c) => c.path),
              patch,
              {
                model: config.judge.model,
                secret: keyEnv ? process.env[keyEnv] : undefined,
              },
            ),
            { timeoutMs: config.judge.timeoutMs },
          )
      : undefined;
    const plan = values.plan
      ? await readPlanFile(values.plan, await resolveCommit(values.head, ws.repoRoot), ws.manifest)
      : await selectPlan(ws, {
          base: values.base,
          head: values.head,
          requireTrimmed: values['require-trimmed'],
          runner,
          judge: judgeFn,
          debug: createDebug(debugEnabled(values.debug)),
        });
    if (values['require-trimmed'] && isFullSuite(plan))
      throw new Error('require-trimmed: refusing a full-suite selection');
    if (cmd === 'explain') {
      stdout.write(
        values.json ? serializePlan(plan) : explainPlan(plan, ws.manifest, positionals[0]),
      );
      return 0;
    }
    await emit(plan, values, stdout);
    if (cmd === 'select') return 0;
    const groups = executionGroups(plan, config.smoke.canary);
    if (!groups.length) return 0;
    return await runner.run(groups, { workers: config.workers, extraArgs });
  } catch (e) {
    process.stderr.write(
      `${e instanceof ConfigError ? e.message : `testscope: ${(e as Error).message}`}\n`,
    );
    return 1;
  }
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url))
  main().then((code) => {
    process.exitCode = code;
  });
