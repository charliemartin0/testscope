import { DefaultArtifactClient } from '@actions/artifact';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config, SuitePlan } from './types.js';

export interface Plan {
  schemaVersion: 1;
  base: string;
  head: string;
  model: string;
  config: Config;
  suites: SuitePlan[];
}

export function buildPlan(base: string, head: string, config: Config, suites: SuitePlan[]): Plan {
  const model = suites.find((suite) => suite.cacheHit || Object.keys(suite.probabilities).length)?.model ?? config.model;
  return { schemaVersion: 1, base, head, model, config, suites };
}

function cell(value: unknown): string {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function formatCount(plan: SuitePlan): string {
  const selected = plan.selectedCount ?? (plan.mode === 'full' ? 'all' : '?');
  return `${plan.mode === 'full' && plan.selected.length === 0 ? 'all' : selected}/${plan.totalCount ?? '?'}`;
}

export function formatSummary(plan: Plan): string {
  const dry = plan.suites.some((suite) => suite.dryRun);
  const lines = [
    '## testscope',
    '',
    ...(dry ? ['**DRY RUN: would select** (outputs force the full suite)', ''] : []),
    '| Suite | Mode | Reason | Selected/Total | Model | Cache |',
    '| --- | --- | --- | ---: | --- | --- |',
    ...plan.suites.map(
      (suite) =>
        `| ${suite.suite} | ${suite.mode} | ${cell(suite.reason)}${suite.note ? ` (${cell(suite.note)})` : ''} | ${formatCount(suite)} | ${cell(suite.model)} | ${suite.cacheHit ? 'hit' : 'miss'} |`
    ),
    '',
  ];
  for (const suite of plan.suites) {
    const ids = Object.keys(suite.probabilities).sort();
    if (!ids.length) continue;
    lines.push(
      `<details><summary>${suite.suite}: per-test probabilities (${ids.length})</summary>`,
      '',
      '| Test | p | Reasons |',
      '| --- | ---: | --- |',
      ...ids.map(
        (id) =>
          `| ${cell(id)} | ${suite.probabilities[id]!.toFixed(3)} | ${cell((suite.reasons[id] ?? []).join(', ') || '—')} |`
      ),
      '',
      '</details>',
      ''
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function writePlan(plan: Plan, file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
}

export async function appendStepSummary(plan: Plan, summaryFile: string | undefined): Promise<void> {
  if (!summaryFile) return;
  await appendFile(summaryFile, formatSummary(plan));
}

export async function uploadPlan(
  file: string,
  warn: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!env.ACTIONS_RUNTIME_TOKEN) return;
  try {
    await new DefaultArtifactClient().uploadArtifact(
      `testscope-plan-${env.GITHUB_RUN_ID ?? 'local'}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`,
      [file],
      path.dirname(file)
    );
  } catch {
    warn('testscope: plan artifact upload failed');
  }
}
