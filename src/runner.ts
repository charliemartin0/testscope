import type { ExecutionGroup } from './plan.ts';

/** A runner lists and executes specs. Implementations (Playwright first) land in M1. */
export interface Runner {
  readonly name: string;
  /** Specs the runner itself considers changed relative to a base ref. */
  listChanged?(base: string): Promise<string[]>;
  run(groups: ExecutionGroup[], options: { workers: number; extraArgs: string[] }): Promise<number>;
}
