import type { Config, Fallback, Inputs } from './types.js';

/** Every action input and its default. The CLI exposes the same names as `--<name>` flags. */
export const INPUT_DEFAULTS: Record<string, string> = {
  'typesafe-api-key': '',
  'base-ref': '',
  'head-ref': 'HEAD',
  suites: 'playwright,vitest,dotnet',
  'playwright-working-directory': '.',
  'vitest-working-directory': '.',
  'dotnet-working-directory': '.',
  'playwright-manifest': 'e2e/spec-manifest.json',
  'playwright-canary': '',
  'playwright-smoke-specs': '',
  'playwright-env': '',
  'playwright-app-env': '',
  'playwright-args': '',
  'vitest-command': 'npx vitest',
  'vitest-projects': '',
  'vitest-args': '',
  'dotnet-test-args': '',
  'dotnet-full-target': '',
  'shared-paths': '',
  threshold: '0.25',
  'timeout-ms': '20000',
  fallback: 'full',
  'max-selected-ratio': '0.6',
  'uncertain-band': '0.1',
  'max-uncertain-ratio': '0.3',
  model: 'jev-1.13.0',
  'dry-run': 'false',
};

export const DEFAULT_CONFIG: Config = {
  threshold: 0.25,
  timeoutMs: 20000,
  fallback: 'full',
  maxSelectedRatio: 0.6,
  uncertainBand: 0.1,
  maxUncertainRatio: 0.3,
  model: 'jev-1.13.0',
  dryRun: false,
};

/** Fill defaults for any input not supplied. Empty strings count as supplied for non-defaulted-empty inputs only. */
export function withDefaults(raw: Partial<Inputs>): Inputs {
  const out: Inputs = { ...INPUT_DEFAULTS };
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    // GitHub passes '' for unset inputs: treat it as "use the default".
    if (value === '' && INPUT_DEFAULTS[name] !== '') continue;
    out[name] = value;
  }
  return out;
}

/**
 * Parse tunables. An invalid value warns naming the input (never the value) and falls back to the default.
 */
export function parseConfig(inputs: Inputs, warn: (message: string) => void): Config {
  const config = { ...DEFAULT_CONFIG };
  const number = (
    name: string,
    min: number,
    max: number,
    assign: (value: number) => void
  ): void => {
    const text = (inputs[name] ?? '').trim();
    const value = Number(text);
    if (text === '' || !Number.isFinite(value) || value < min || value > max) {
      warn(`testscope: invalid input '${name}'; using default ${INPUT_DEFAULTS[name]}`);
      return;
    }
    assign(value);
  };
  number('threshold', 0, 1, (v) => (config.threshold = v));
  number('timeout-ms', 1, 600_000, (v) => (config.timeoutMs = v));
  number('max-selected-ratio', 0, 1, (v) => (config.maxSelectedRatio = v));
  number('uncertain-band', 0, 0.5, (v) => (config.uncertainBand = v));
  number('max-uncertain-ratio', 0, 1, (v) => (config.maxUncertainRatio = v));
  const fallback = (inputs.fallback ?? '').trim();
  if (fallback === 'full' || fallback === 'smoke' || fallback === 'none') {
    config.fallback = fallback as Fallback;
  } else {
    warn("testscope: invalid input 'fallback'; using default full");
  }
  const model = (inputs.model ?? '').trim();
  if (model) config.model = model;
  const dryRun = (inputs['dry-run'] ?? '').trim().toLowerCase();
  if (dryRun === 'true') config.dryRun = true;
  else if (dryRun !== 'false' && dryRun !== '') {
    warn("testscope: invalid input 'dry-run'; using default false");
  }
  return config;
}

export function lines(value: string | undefined): string[] {
  return (value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** `suite:glob` lines for the given suite. */
export function sharedPathsFor(inputs: Inputs, suite: string): string[] {
  return lines(inputs['shared-paths'])
    .filter((line) => line.startsWith(`${suite}:`))
    .map((line) => line.slice(suite.length + 1).trim())
    .filter(Boolean);
}
