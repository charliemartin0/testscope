import { resolveConfig } from '../src/config.ts';
import type { ChangedFile, Manifest } from '../src/types.ts';

export const manifest: Manifest = {
  'e2e/shell/canary.spec.ts': { group: 'shell', smoke: true },
  'e2e/shell/home.spec.ts': { group: 'shell', smoke: true },
  'e2e/billing/invoices.spec.ts': { group: 'billing', sources: ['src/billing/**'] },
  'e2e/billing/refunds.spec.ts': { group: 'billing', sources: ['src/billing/refunds/**'] },
  'e2e/users/list.spec.ts': { group: 'users', sources: ['src/users/**'] },
};

export const config = (over: Record<string, unknown> = {}) =>
  resolveConfig({
    root: 'web',
    smoke: { specs: ['e2e/shell/home.spec.ts'], canary: 'e2e/shell/canary.spec.ts' },
    extraDiffRoots: ['api'],
    ...over,
  });

export const mod = (...paths: string[]): ChangedFile[] =>
  paths.map((path) => ({ status: 'modified', path }));
