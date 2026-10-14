import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { matchesAny } from './glob.ts';
import type { Manifest, ManifestConfig, ManifestEntry } from './types.ts';

const SKIP = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
]);

export async function listFiles(root: string, dir = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** Pure: build one manifest entry from a spec's path and source text. */
export function describeSpec(file: string, source: string, cfg: ManifestConfig): ManifestEntry {
  const routes = new Set<string>();
  for (const pattern of cfg.routePatterns)
    for (const m of source.matchAll(new RegExp(pattern, 'g'))) if (m[1]) routes.add(m[1]);
  const title =
    new RegExp(cfg.titlePattern).exec(source)?.[1] ??
    path.basename(file).replace(/\.spec\.\w+$/, '');
  const tag = cfg.smokeTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry: ManifestEntry = {
    routes: [...routes].sort(),
    title,
    smoke: new RegExp(`(^|[\\s'"\`])${tag}($|[\\s'"\`])`).test(source),
  };
  if (cfg.groupPattern) {
    const g = new RegExp(cfg.groupPattern).exec(file)?.[1];
    if (g) entry.group = g;
  }
  const sources: string[] = [];
  for (const rule of cfg.sourceRules) {
    const m = new RegExp(rule.match).exec(file);
    if (m)
      for (const s of rule.sources)
        sources.push(s.replace(/\$(\d)/g, (_, i: string) => m[Number(i)] ?? ''));
  }
  if (sources.length) entry.sources = [...new Set(sources)].sort();
  return entry;
}

/** Scan root for spec files and describe each one. Deterministic: sorted keys and fields. */
export async function generateManifest(root: string, cfg: ManifestConfig): Promise<Manifest> {
  const files = (await listFiles(root)).filter((f) => matchesAny(f, cfg.specs));
  const manifest: Manifest = {};
  for (const f of files)
    manifest[f] = describeSpec(f, await readFile(path.join(root, f), 'utf8'), cfg);
  return manifest;
}

export const formatManifest = (m: Manifest) => `${JSON.stringify(m, null, 2)}\n`;

/** Write (or with check=true, verify) the manifest. Returns false when check finds it stale. */
export async function syncManifest(
  root: string,
  cfg: ManifestConfig,
  check = false,
): Promise<boolean> {
  const file = path.join(root, cfg.path);
  const next = formatManifest(await generateManifest(root, cfg));
  if (check) return (await readFile(file, 'utf8').catch(() => '')) === next;
  await writeFile(file, next);
  return true;
}
