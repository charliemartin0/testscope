import type { Manifest } from './types.ts';

export interface JudgeRequest {
  model?: string;
  changedFiles: string[];
  diffSummary: string;
  specs: Record<string, { group?: string; routes?: string[]; title?: string }>;
}

/** A judge scores each spec with the probability (0..1) that the diff affects it. */
export interface Judge {
  readonly name: string;
  score(request: JudgeRequest, options: { timeoutMs: number }): Promise<Record<string, number>>;
}

/** Errors judges raise; only these codes are ever recorded in plans (never raw messages). */
export const JUDGE_ERRORS = [
  'judge-timeout',
  'judge-http-error',
  'judge-invalid-answer',
  'judge-missing-api-key',
  'judge-command-error',
  'judge-cache-miss',
] as const;

export class JudgeError extends Error {
  constructor(code: (typeof JUDGE_ERRORS)[number]) {
    super(code);
    this.name = 'JudgeError';
  }
}

/** Build the judge request from a manifest, redacting the active secret from every string. */
export function buildRequest(
  manifest: Manifest,
  changedFiles: string[],
  diffSummary: string,
  opts: { model?: string; secret?: string } = {},
): JudgeRequest {
  const secret = opts.secret?.trim();
  const redact = (v: string) => (secret ? v.replaceAll(secret, '[REDACTED]') : v);
  const specs: JudgeRequest['specs'] = {};
  for (const s of Object.keys(manifest).sort()) {
    const e = manifest[s] ?? {};
    specs[s] = { group: e.group, routes: e.routes, title: e.title };
  }
  return {
    ...(opts.model ? { model: opts.model } : {}),
    changedFiles: changedFiles.map(redact),
    diffSummary: redact(diffSummary),
    specs,
  };
}

/** Validate a `{ spec: probability }` map against the requested specs. */
export function checkScores(scores: unknown, specs: string[]): Record<string, number> {
  if (typeof scores !== 'object' || scores === null) throw new JudgeError('judge-invalid-answer');
  const out: Record<string, number> = {};
  for (const s of specs) {
    const p = (scores as Record<string, unknown>)[s];
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1)
      throw new JudgeError('judge-invalid-answer');
    out[s] = p;
  }
  return out;
}

/** Map any thrown value to a safe judge error code. */
export function judgeErrorCode(e: unknown): string {
  if (e instanceof Error && e.name === 'TimeoutError') return 'judge-timeout';
  const m = e instanceof Error ? e.message : '';
  return (JUDGE_ERRORS as readonly string[]).includes(m) ? m : 'judge-error';
}
