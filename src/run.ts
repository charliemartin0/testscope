import path from 'node:path';
import { cachedAsk } from './cache.js';
import type { CacheStore } from './cache.js';
import { firstMatch } from './globs.js';
import { changedFilesBetween, git, limitPatch, readDiff } from './git.js';
import { sharedPathsFor } from './inputs.js';
import { askNouls, JevError } from './jev.js';
import { decide } from './policy.js';
import type { PolicyInput } from './policy.js';
import { CollectionError } from './types.js';
import type { Adapter, Collected, Config, Inputs, SuiteContext, SuiteName, SuitePlan } from './types.js';

export function normalizeDirectory(directory: string): string {
  const normalized = path.posix.normalize(directory.replaceAll('\\', '/')).replace(/\/+$/, '');
  return normalized === '.' || normalized === '' ? '' : normalized;
}

export async function repoRootOf(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

/** Diff the suite's working directory and build the context handed to its adapter. */
export async function buildContext(options: {
  suite: SuiteName;
  repoRoot: string;
  baseRef: string;
  headRef: string;
  inputs: Inputs;
}): Promise<SuiteContext> {
  const { suite, repoRoot, baseRef, headRef, inputs } = options;
  const workingDirectory = normalizeDirectory(inputs[`${suite}-working-directory`] ?? '.');
  const diff = await readDiff(repoRoot, baseRef, headRef, [workingDirectory]);
  const { patch, truncated } = limitPatch(diff.patch, diff.stat);
  return {
    suite,
    repoRoot,
    workingDirectory,
    base: diff.base,
    head: diff.head,
    changedFiles: diff.changedFiles,
    allChangedFiles: await changedFilesBetween(repoRoot, diff.base, diff.head),
    patch,
    patchTruncated: truncated,
    inputs,
  };
}

export interface RunSuiteOptions {
  adapter: Adapter;
  ctx: SuiteContext;
  config: Config;
  apiKey: string;
  cacheEnabled: boolean;
  cacheDir: string;
  cacheStore?: CacheStore;
  fetchImpl?: typeof fetch;
  warn?: (message: string) => void;
}

function underWorkingDirectory(file: string, directory: string): boolean {
  return directory === '' || file === directory || file.startsWith(`${directory}/`);
}

/**
 * Select tests for one suite: deterministic rules, adapter collection, exactly one (chunked) Jev call,
 * then the shared policy. Never throws; internal failures become a `selector-error` whole-suite outcome.
 */
export async function runSuite(options: RunSuiteOptions): Promise<SuitePlan> {
  const { adapter, ctx, config, apiKey } = options;
  const relevant = ctx.changedFiles.filter((file) => underWorkingDirectory(file, ctx.workingDirectory));
  const shared = [...adapter.defaultShared(ctx.workingDirectory), ...sharedPathsFor(ctx.inputs, adapter.name)];
  // Shared globs may point outside the working directory (e.g. design tokens); match them repo-wide.
  const sharedHit = firstMatch(ctx.allChangedFiles ?? relevant, shared);

  let collected: Collected | undefined;
  let collectionError: string | undefined;
  let selectorError = false;
  let probabilities: Record<string, number> | undefined;
  let jevError: string | undefined;
  let model = config.model;
  let cacheHit = false;

  try {
    if (relevant.length > 0 || sharedHit) {
      try {
        collected = await adapter.collect(ctx, { lite: sharedHit !== null });
      } catch (error) {
        if (error instanceof CollectionError) collectionError = error.code;
        else selectorError = true;
      }
    }
    const needsJev =
      relevant.length > 0 &&
      !sharedHit &&
      !collectionError &&
      !selectorError &&
      collected !== undefined &&
      !collected.wholeReason &&
      collected.candidates.length > 0;
    if (needsJev && collected) {
      if (!apiKey) {
        jevError = 'jev-missing-key';
      } else {
        const { candidates, state } = collected;
        const ids = candidates.map((candidate) => candidate.id);
        const questions = Object.fromEntries(
          candidates.map((candidate, index) => [`q_${index}`, candidate.question])
        );
        try {
          const { result, hit } = await cachedAsk({
            parts: {
              suite: adapter.name,
              patch: ctx.patch,
              changedFiles: ctx.changedFiles,
              candidates: collected.candidates,
              config,
            },
            enabled: options.cacheEnabled,
            cacheDir: options.cacheDir,
            store: options.cacheStore,
            warn: options.warn,
            ask: async () => {
              const result = await askNouls({
                state,
                questions,
                apiKey,
                model: config.model,
                timeoutMs: config.timeoutMs,
                fetchImpl: options.fetchImpl,
              });
              return {
                model: result.model,
                answers: Object.fromEntries(ids.map((id, index) => [id, result.answers[`q_${index}`]!])),
              };
            },
          });
          cacheHit = hit;
          model = result.model;
          probabilities = result.answers;
        } catch (error) {
          jevError = error instanceof JevError ? error.code : 'jev-error';
        }
      }
    }
  } catch {
    selectorError = true;
  }

  const input: PolicyInput = {
    suite: adapter.name,
    smokeSupported: adapter.smokeSupported,
    config,
    relevantCount: relevant.length || (sharedHit ? 1 : 0),
    sharedHit,
    collected,
    collectionError,
    selectorError,
    probabilities,
    jevError,
    model,
    cacheHit,
  };
  const decision = decide(input);

  let command = '';
  let fullCommand = '';
  let filters: unknown;
  try {
    fullCommand = adapter.command({ mode: 'full', selected: [], reasons: {} }, ctx, collected).command;
    if (decision.mode !== 'none') {
      const result = adapter.command(decision, ctx, collected);
      command = result.command;
      filters = result.filters;
    }
  } catch {
    // Command construction failed: run the whole suite rather than nothing.
    if (decision.mode !== 'none') {
      return {
        ...decide({ ...input, selectorError: true, collected: undefined, sharedHit: null, collectionError: undefined, jevError: undefined }),
        command: fullCommand,
        fullCommand,
      };
    }
  }
  return { ...decision, command, fullCommand, ...(filters === undefined ? {} : { filters }) };
}

/** Context usable when diffing failed: enough for an adapter to build its whole-suite command. */
export function fallbackContext(
  suite: SuiteName,
  repoRoot: string,
  inputs: Inputs,
  base: string,
  head: string
): SuiteContext {
  return {
    suite,
    repoRoot,
    workingDirectory: normalizeDirectory(inputs[`${suite}-working-directory`] ?? '.'),
    base,
    head,
    changedFiles: [],
    patch: '',
    patchTruncated: false,
    inputs,
  };
}

/** Whole-suite outcome for an unexpected failure outside runSuite (diff, git, anything). */
export function selectorErrorPlan(adapter: Adapter, ctx: SuiteContext, config: Config): SuitePlan {
  const decision = decide({
    suite: adapter.name,
    smokeSupported: adapter.smokeSupported,
    config,
    relevantCount: 1,
    sharedHit: null,
    selectorError: true,
    model: config.model,
    cacheHit: false,
  });
  let fullCommand = '';
  let command = '';
  try {
    fullCommand = adapter.command({ mode: 'full', selected: [], reasons: {} }, ctx, undefined).command;
    command = decision.mode === 'none' ? '' : fullCommand;
  } catch {
    // leave empty: the caller still gets mode/reason outputs
  }
  return { ...decision, command, fullCommand };
}
