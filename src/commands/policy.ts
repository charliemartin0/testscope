import { resolveConfig } from '../config.ts';
import type { TestscopeConfig } from '../types.ts';

export interface PolicyFlags {
  'on-unmapped'?: string;
  'on-judge-error'?: string;
  'on-all-selected'?: string;
  'max-specs'?: string;
}

/** Apply CLI policy overrides on top of the file config, validated by the same rules as the file. */
export function applyPolicyFlags(config: TestscopeConfig, flags: PolicyFlags): TestscopeConfig {
  const policy: Record<string, unknown> = {};
  if (flags['on-unmapped']) policy.onUnmapped = flags['on-unmapped'];
  if (flags['on-judge-error']) policy.onJudgeError = flags['on-judge-error'];
  if (flags['on-all-selected']) policy.onAllSelected = flags['on-all-selected'];
  if (flags['max-specs']) policy.maxSpecs = Number(flags['max-specs']);
  if (!Object.keys(policy).length) return config;
  const checked = resolveConfig({ policy: { ...config.policy, ...policy } }).policy;
  return { ...config, policy: checked };
}
