import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as core from '@actions/core';
import { getAdapter } from './adapters/index.js';
import { INPUT_DEFAULTS, lines, parseConfig, withDefaults } from './inputs.js';
import { appendStepSummary, buildPlan, uploadPlan, writePlan } from './report.js';
import type { Plan } from './report.js';
import { buildContext, fallbackContext, repoRootOf, runSuite, selectorErrorPlan } from './run.js';
import { SUITE_NAMES } from './types.js';
import type { Config, Inputs, SuiteName, SuitePlan } from './types.js';

export function resolveBaseRef(inputs: Inputs, env: NodeJS.ProcessEnv): string {
  const explicit = inputs['base-ref']?.trim();
  if (explicit) return explicit;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8')) as {
      pull_request?: { base?: { sha?: string } };
      merge_group?: { base_sha?: string };
      repository?: { default_branch?: string };
    };
    const sha = event.pull_request?.base?.sha ?? event.merge_group?.base_sha;
    if (sha) return sha;
    if (event.repository?.default_branch) return `origin/${event.repository.default_branch}`;
  } catch {
    // no event payload (workflow_dispatch from a fork, local run): fall through
  }
  return 'origin/main';
}

export function parseSuites(value: string): SuiteName[] {
  const requested = value
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  const suites = requested.filter((name): name is SuiteName => (SUITE_NAMES as readonly string[]).includes(name));
  for (const name of requested) {
    if (!suites.includes(name as SuiteName)) core.warning(`testscope: unknown suite '${name}' ignored`);
  }
  return [...new Set(suites)];
}

/** Map a plan to action outputs. Dry-run forces the full suite while keeping the real reason. */
export function planOutputs(plan: SuitePlan): Record<string, string> {
  const dry = plan.dryRun;
  const prefix = plan.suite;
  const outputs: Record<string, string> = {
    [`${prefix}-mode`]: dry ? 'full' : plan.mode,
    [`${prefix}-reason`]: dry ? `dry-run:${plan.reason}` : plan.reason,
    [`${prefix}-selected-count`]: String(plan.selectedCount ?? ''),
    [`${prefix}-selected`]: JSON.stringify(plan.selected),
    [`${prefix}-command`]: dry ? plan.fullCommand : plan.command,
  };
  if (plan.filters !== undefined) outputs[`${prefix}-filters`] = JSON.stringify(plan.filters);
  return outputs;
}

const KEY_ENV = 'INPUT_TYPESAFE-API-KEY';

/**
 * Read every input. The key is returned separately and removed from the process environment so that
 * repository code run during collection (vitest/playwright configs and specs) cannot read it.
 */
function readInputs(env: NodeJS.ProcessEnv): { inputs: Inputs; apiKey: string } {
  const raw: Partial<Inputs> = {};
  for (const name of Object.keys(INPUT_DEFAULTS)) raw[name] = core.getInput(name);
  const inputs = withDefaults(raw);
  const apiKey = inputs['typesafe-api-key']?.trim() ?? '';
  if (apiKey) core.setSecret(apiKey);
  delete process.env[KEY_ENV];
  delete env[KEY_ENV];
  inputs['typesafe-api-key'] = '';
  return { inputs, apiKey };
}

/**
 * Entry point. Never fails the workflow: every error degrades to a whole-suite `selector-error`
 * outcome and outputs are still set.
 */
export async function run(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { inputs, apiKey } = readInputs(env);

  const config: Config = parseConfig(inputs, core.warning);
  const suites = parseSuites(inputs.suites ?? INPUT_DEFAULTS.suites!);
  const baseRef = resolveBaseRef(inputs, env);
  const headRef = inputs['head-ref']?.trim() || 'HEAD';
  const cacheDir = path.join(env.RUNNER_TEMP ?? '/tmp', 'testscope-cache');

  let repoRoot = '';
  const plans: SuitePlan[] = [];
  try {
    repoRoot = await repoRootOf(env.GITHUB_WORKSPACE ?? process.cwd());
  } catch {
    repoRoot = env.GITHUB_WORKSPACE ?? process.cwd();
  }

  for (const suite of suites) {
    const adapter = getAdapter(suite);
    try {
      const ctx = await buildContext({ suite, repoRoot, baseRef, headRef, inputs });
      plans.push(
        await runSuite({
          adapter,
          ctx,
          config,
          apiKey,
          cacheEnabled: Boolean(env.ACTIONS_RUNTIME_TOKEN),
          cacheDir,
          warn: core.warning,
        })
      );
    } catch {
      plans.push(selectorErrorPlan(adapter, fallbackContext(suite, repoRoot, inputs, baseRef, headRef), config));
    }
  }

  const plan: Plan = buildPlan(baseRef, headRef, config, plans);
  const planPath = path.join(env.RUNNER_TEMP ?? '/tmp', 'testscope-plan.json');
  for (const item of plans) {
    for (const [name, value] of Object.entries(planOutputs(item))) core.setOutput(name, value);
  }
  core.setOutput('plan-path', planPath);
  for (const step of [
    () => writePlan(plan, planPath),
    () => appendStepSummary(plan, env.GITHUB_STEP_SUMMARY),
    () => uploadPlan(planPath, core.warning, env),
  ]) {
    try {
      await step();
    } catch {
      core.warning('testscope: could not write the plan or summary');
    }
  }
}

/** Last line of defence: any exception still yields outputs for every requested suite. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await run(env);
  } catch {
    const { inputs } = readInputs(env);
    const config = parseConfig(inputs, () => {});
    for (const suite of parseSuites(inputs.suites ?? INPUT_DEFAULTS.suites!)) {
      const adapter = getAdapter(suite);
      const ctx = fallbackContext(suite, env.GITHUB_WORKSPACE ?? process.cwd(), inputs, '', '');
      for (const [name, value] of Object.entries(planOutputs(selectorErrorPlan(adapter, ctx, config)))) {
        core.setOutput(name, value);
      }
    }
    core.setOutput('plan-path', '');
    core.warning('testscope: selector error; running whole suites');
  }
}

if (process.env.GITHUB_ACTIONS === 'true' && !process.env.VITEST) {
  void main();
}
