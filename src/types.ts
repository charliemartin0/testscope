export type FallbackPolicy = 'smoke' | 'all' | 'manifest' | 'fail';

export interface RunnerConfig {
  type: 'playwright';
  /** Runner projects to enable (e.g. Playwright project names). */
  projects?: string[];
  /** Optional env var that receives the comma-separated projects/groups for the selected specs. */
  projectsEnv?: string;
  /** Grep expression applied when only smoke tests should run (e.g. "@smoke"). */
  smokeGrep?: string;
  outputDir?: string;
  /** Ask the runner which specs import changed files (Playwright --only-changed). */
  onlyChanged: boolean;
}

export interface JudgeConfig {
  type: 'none' | 'http' | 'command';
  url?: string;
  /** Name of the environment variable holding the API key. Never the key itself. */
  apiKeyEnv?: string;
  model?: string;
  /** Command line for type "command"; receives the judge request on stdin. */
  command?: string;
  threshold: number;
  timeoutMs: number;
  cache: boolean | string;
}

export interface PolicyConfig {
  onJudgeError: FallbackPolicy;
  onAllSelected: FallbackPolicy;
  onUnmapped: FallbackPolicy;
  maxSpecs?: number;
}

export interface ManifestConfig {
  path: string;
  /** Globs (relative to root) of spec files. */
  specs: string[];
  /** Regexes whose first capture group is a route visited by the spec. */
  routePatterns: string[];
  /** Regex whose first capture group is the spec title. */
  titlePattern: string;
  /** Tag that marks smoke tests. */
  smokeTag: string;
  /** Regex applied to the spec path; first capture group becomes the group. */
  groupPattern?: string;
  /** Derive sources from the spec path: `match` is a regex, `$1`… in sources are its captures. */
  sourceRules: { match: string; sources: string[] }[];
}

export interface TestscopeConfig {
  root: string;
  runner: RunnerConfig;
  manifest: ManifestConfig;
  smoke: { specs: string[]; canary?: string };
  shared: string[];
  ignore: string[];
  extraDiffRoots: string[];
  judge: JudgeConfig;
  policy: PolicyConfig;
  workers: number;
}

export interface ManifestEntry {
  /** Free-form grouping (app, project, area). Used for projectsEnv. */
  group?: string;
  routes?: string[];
  title?: string;
  smoke?: boolean;
  /** Globs (relative to root) of source files this spec covers. */
  sources?: string[];
}

export type Manifest = Record<string, ManifestEntry>;

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'other';

export interface ChangedFile {
  status: ChangeStatus;
  /** Repo-relative path after the change. */
  path: string;
  /** Repo-relative path before a rename/copy. */
  oldPath?: string;
}

export type PlanMode = 'none' | 'selected' | 'all' | 'smoke-fallback' | 'fail';

export interface Plan {
  mode: PlanMode;
  selected: string[];
  groups: string[];
  smokeOnly: boolean;
  reasons: Record<string, string[]>;
  unmapped: string[];
  fallbackReason?: string;
  downgradedFrom?: { mode: PlanMode; selectedCount: number };
  scores: Record<string, number>;
  total: number;
}
