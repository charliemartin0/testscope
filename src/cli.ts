import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { getAdapter as defaultGetAdapter } from './adapters/index.js';
import { evaluate, formatMarkdown } from './evaluate.js';
import { INPUT_DEFAULTS, parseConfig, withDefaults } from './inputs.js';
import { buildPlan, formatSummary, writePlan } from './report.js';
import { buildContext, repoRootOf, runSuite } from './run.js';
import { SUITE_NAMES } from './types.js';
import type { Adapter, SuiteName, SuitePlan } from './types.js';

export interface CliDeps {
  getAdapter?: (name: SuiteName) => Adapter;
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  fetchImpl?: typeof fetch;
}

const API_KEY_INPUT = 'typesafe-api-key';
const OPTIONS = {
  ...Object.fromEntries(
    Object.keys(INPUT_DEFAULTS)
      .filter((name) => name !== API_KEY_INPUT)
      .map((name) => [name, { type: 'string' as const }])
  ),
  out: { type: 'string' as const },
  markdown: { type: 'string' as const },
  count: { type: 'string' as const },
  ref: { type: 'string' as const },
};

const USAGE = `usage: testscope <select|evaluate> [--<input> value ...] [--out file]
  select    [--base-ref origin/main] [--head-ref HEAD] [--suites a,b]
  evaluate  [--count 20] [--ref origin/main] [--suites a,b] [--markdown report.md]
The API key is read from the TYPESAFE_API_KEY environment variable only.`;

function parseSuites(value: string, warn: (message: string) => void): SuiteName[] {
  const requested = value.split(',').map((name) => name.trim()).filter(Boolean);
  const suites: SuiteName[] = [];
  for (const name of requested) {
    const known = SUITE_NAMES.find((suite) => suite === name);
    if (known) suites.push(known);
    else warn(`testscope: unknown suite '${name}' ignored`);
  }
  return suites;
}

function redact(text: string, key: string): string {
  return key ? text.replaceAll(key, '[REDACTED]') : text;
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: CliDeps = {}
): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => void process.stderr.write(text));
  const getAdapter = deps.getAdapter ?? defaultGetAdapter;
  const apiKey = env.TYPESAFE_API_KEY ?? '';
  // Repository code runs during collection (vitest/playwright configs, specs): keep the key out of its environment.
  delete process.env.TYPESAFE_API_KEY;
  const [command, ...rest] = argv;
  if (command !== 'select' && command !== 'evaluate') {
    stderr(`${USAGE}\n`);
    return command === undefined || command === '--help' ? 0 : 2;
  }
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({ args: rest, options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (error) {
    stderr(`testscope: ${error instanceof Error ? redact(error.message, apiKey) : 'invalid arguments'}\n${USAGE}\n`);
    return 2;
  }
  const warn = (message: string) => stderr(`${redact(message, apiKey)}\n`);
  const inputs = withDefaults(
    Object.fromEntries(Object.keys(INPUT_DEFAULTS).map((name) => [name, values[name]]))
  );
  if (!inputs['base-ref']) inputs['base-ref'] = 'origin/main';
  const config = parseConfig(inputs, warn);
  const suites = parseSuites(inputs.suites ?? '', warn);
  const repoRoot = await repoRootOf(deps.cwd ?? process.cwd());

  if (command === 'select') {
    const plans: SuitePlan[] = [];
    let base = inputs['base-ref'] ?? '';
    let head = inputs['head-ref'] ?? 'HEAD';
    for (const suite of suites) {
      try {
        const ctx = await buildContext({ suite, repoRoot, baseRef: base, headRef: head, inputs });
        base = ctx.base;
        head = ctx.head;
        plans.push(
          await runSuite({
            adapter: getAdapter(suite),
            ctx,
            config,
            apiKey,
            cacheEnabled: false,
            cacheDir: '',
            fetchImpl: deps.fetchImpl,
            warn,
          })
        );
      } catch {
        stderr(`testscope: ${suite}: selector-error\n`);
        plans.push({
          suite,
          mode: config.fallback === 'none' ? 'none' : 'full',
          reason: 'selector-error',
          selected: [],
          selectedCount: null,
          totalCount: null,
          probabilities: {},
          reasons: {},
          command: '',
          fullCommand: '',
          model: config.model,
          cacheHit: false,
          dryRun: false,
        });
      }
    }
    const plan = buildPlan(base, head, config, plans);
    if (values.out) await writePlan(plan, values.out);
    stdout(redact(formatSummary(plan), apiKey));
    return 0;
  }

  if (!apiKey) {
    stderr('testscope: evaluate requires the TYPESAFE_API_KEY environment variable\n');
    return 2;
  }
  const countText = values.count ?? '20';
  const count = Number(countText);
  if (!Number.isInteger(count) || count < 1) {
    stderr("testscope: invalid '--count'; expected a positive integer\n");
    return 2;
  }
  try {
    const report = await evaluate({
      repoRoot,
      ref: values.ref ?? 'origin/main',
      count,
      suites,
      inputs,
      config,
      apiKey,
      getAdapter,
      fetchImpl: deps.fetchImpl,
      warn,
    });
    if (values.out) await writeFile(values.out, redact(`${JSON.stringify(report, null, 2)}\n`, apiKey));
    const markdown = redact(formatMarkdown(report), apiKey);
    if (values.markdown) await writeFile(values.markdown, markdown);
    stdout(markdown);
    return 0;
  } catch (error) {
    stderr(`testscope: evaluate failed: ${error instanceof Error ? redact(error.message, apiKey) : 'unknown error'}\n`);
    return 1;
  }
}
