import type { Judge } from '../judge.ts';
import type { JudgeConfig } from '../types.ts';
import { CachedJudge, cacheDir, cacheMode } from './cache.ts';
import { CommandJudge } from './command.ts';
import { HttpJudge } from './http.ts';
import { PRESETS } from './presets.ts';

/** Name of the env var holding the judge key (explicit, or the preset default). */
export function keyEnvFor(cfg: JudgeConfig): string | undefined {
  return cfg.apiKeyEnv ?? (cfg.preset === 'jev' ? PRESETS.jev.apiKeyEnv : undefined);
}

/** Create the configured judge, or undefined for type "none". The key is read from env by NAME only. */
export function createJudge(
  cfg: JudgeConfig,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Judge | undefined {
  const judge = createRawJudge(cfg, cwd, env);
  const dir = judge && cacheDir(cfg.cache, cwd);
  return judge && dir ? new CachedJudge(judge, dir, cacheMode(env)) : judge;
}

function createRawJudge(cfg: JudgeConfig, cwd: string, env: NodeJS.ProcessEnv): Judge | undefined {
  if (cfg.type === 'none') return undefined;
  if (cfg.type === 'command') return new CommandJudge(cfg.command as string, cwd);
  const keyEnv = keyEnvFor(cfg);
  return new HttpJudge({
    url: cfg.url,
    model: cfg.model,
    preset: cfg.preset,
    apiKey: keyEnv ? env[keyEnv] : undefined,
  });
}

export { CachedJudge, CommandJudge, HttpJudge, PRESETS };
export { cacheDir, cacheKey, cacheMode, canonical, CACHE_VERSION } from './cache.ts';
export type { CacheMode } from './cache.ts';
export { GENERIC } from './http.ts';
