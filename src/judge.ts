import type { Manifest } from './types.ts';

export interface JudgeRequest {
  changedFiles: string[];
  diffSummary: string;
  specs: Manifest;
}

/** A judge scores each spec with the probability that the diff affects it. Implementations land in M1. */
export interface Judge {
  readonly name: string;
  score(
    request: JudgeRequest,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<Record<string, number>>;
}
