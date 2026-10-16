import type { Adapter, SuiteName } from '../types.js';
import { dotnetAdapter } from './dotnet.js';
import { playwrightAdapter } from './playwright.js';
import { vitestAdapter } from './vitest.js';

const ADAPTERS: Record<SuiteName, Adapter> = {
  playwright: playwrightAdapter,
  vitest: vitestAdapter,
  dotnet: dotnetAdapter,
};

export function getAdapter(name: SuiteName): Adapter {
  return ADAPTERS[name];
}
