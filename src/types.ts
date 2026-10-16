export type Fallback = 'full' | 'smoke' | 'none';
export type Mode = 'none' | 'selected' | 'full' | 'smoke';
export type SuiteName = 'playwright' | 'vitest' | 'dotnet';
export const SUITE_NAMES: readonly SuiteName[] = ['playwright', 'vitest', 'dotnet'];

/** Raw string inputs keyed by action input name (see inputs.ts for defaults). */
export type Inputs = Record<string, string>;

/** Selection tunables. The API key is deliberately NOT part of this: it is only passed to askNouls. */
export interface Config {
  threshold: number;
  timeoutMs: number;
  fallback: Fallback;
  maxSelectedRatio: number;
  uncertainBand: number;
  maxUncertainRatio: number;
  model: string;
  dryRun: boolean;
}

export interface Question {
  instructions: string;
  criteria: { true: string; false: string };
}

/** One Jev question is asked per candidate. `data` feeds the cache key. */
export interface Candidate {
  id: string;
  data: unknown;
  question: Question;
}

/** Raised by adapters for deterministic collection failures that map to a whole-suite outcome. */
export class CollectionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'CollectionError';
  }
}

export interface Collected {
  candidates: Candidate[];
  /** id -> reasons the test must run regardless of Jev. Keys must be candidate ids. */
  forced: Map<string, string[]>;
  /** Total number of tests/specs/classes in the suite (denominator for ratios). */
  totalCount: number;
  /** Model state (without secrets). Built by the adapter, includes patch/changedFiles as it sees fit. */
  state: Record<string, unknown>;
  /** Adapter-specific smoke list (playwright). */
  smoke?: string[];
  /** Adapter detected a deterministic whole-suite reason (e.g. `non-code-change:<file>`). */
  wholeReason?: string;
  /** Adapter-private data reused by command(). */
  extra?: unknown;
}

export interface SuiteContext {
  suite: SuiteName;
  /** Absolute path of the git repository root. */
  repoRoot: string;
  /** Working directory relative to repoRoot, '' for the root. POSIX separators. */
  workingDirectory: string;
  base: string;
  head: string;
  /** All changed files, repo-root-relative POSIX paths. */
  changedFiles: string[];
  /**
   * Changed files across the whole repository (not limited to the working directory); only used to match
   * `shared-paths` globs that live outside the working directory. Defaults to `changedFiles`.
   */
  allChangedFiles?: string[];
  /** Diff text for the model: `--stat --patch`, or `--stat` alone when truncated. */
  patch: string;
  patchTruncated: boolean;
  inputs: Inputs;
  /** Evaluator replay: use this commit (instead of `base`) as the baseline for dependency-based collection. */
  collectBase?: string;
  /** Evaluator replay: environment for collection subprocesses (points git at a private database). */
  collectEnv?: NodeJS.ProcessEnv;
}

export interface CommandResult {
  command: string;
  filters?: unknown;
}

/** Ground truth for retrospective evaluation: tests the change itself touched, and the files to hold out. */
export interface Truth {
  /** Candidate ids (same id space as `Candidate.id`) of tests changed by the diff. */
  ids: string[];
  /** Changed files that constitute that truth (removed from the diff before selection). */
  files: string[];
}

export interface Adapter {
  name: SuiteName;
  /** Whether the `smoke` fallback exists; otherwise smoke maps to full. */
  smokeSupported: boolean;
  /** Glob patterns (repo-root-relative) whose change forces the whole suite. */
  defaultShared(workingDirectory: string): string[];
  /** `lite` skips expensive forced-candidate collection (used when a deterministic rule already decided). */
  collect(ctx: SuiteContext, opts: { lite: boolean }): Promise<Collected>;
  command(
    plan: Pick<SuitePlan, 'mode' | 'selected' | 'reasons'>,
    ctx: SuiteContext,
    collected: Collected | undefined
  ): CommandResult;
  /** Tests changed by ctx.changedFiles that exist in the current tree (evaluator ground truth). */
  truth(ctx: SuiteContext): Promise<Truth>;
}

export interface SuitePlan {
  suite: SuiteName;
  mode: Mode;
  reason: string;
  note?: string;
  selected: string[];
  /** null when the suite total is unknown (collection skipped or failed). */
  selectedCount: number | null;
  totalCount: number | null;
  probabilities: Record<string, number>;
  reasons: Record<string, string[]>;
  command: string;
  /** Command that runs the entire suite; used by dry-run. */
  fullCommand: string;
  filters?: unknown;
  model: string;
  cacheHit: boolean;
  dryRun: boolean;
}
