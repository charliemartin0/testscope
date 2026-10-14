# testscope

Manifest-first, budget-capped test selection for pull requests.

`testscope` decides which end-to-end specs a change needs, so CI runs a trimmed set instead of the whole suite.
A spec manifest is the source of truth; an optional judge (HTTP service or local command) can add specs the manifest
cannot see; and every uncertain case falls back to a small curated smoke set (or whatever your policy says) rather
than silently running everything.

> Status: **M0** — config schema, config loader and the pure selection logic. The CLI is a stub; runners, judges and
> the GitHub Action are interfaces only. Not published to npm yet.

## How selection works

1. Changed files (from `git diff --name-status -M`) are scoped to `root` plus any `extraDiffRoots`. Renames count both
   paths; deleted specs are never scheduled. `ignore` globs are dropped.
2. A change matching a `shared` glob (lockfiles, runner config, fixtures, `.env*`, OpenAPI files…) invalidates every
   spec, then `policy.onAllSelected` decides what actually runs.
3. A spec is selected when the spec file itself changed, a changed file matches one of its `sources` globs, the runner's
   own change detection reports it, or the judge scores it at or above `judge.threshold`.
4. Changes that map to nothing follow `policy.onUnmapped` (unless a judge reviewed them); judge failures follow
   `policy.onJudgeError`.
5. The optional `smoke.canary` always runs — smoke-only unless it is directly affected.
6. More than `policy.maxSpecs` selections downgrades to the curated smoke set.

Policies are one of `smoke` (curated smoke set), `all` (every spec), `manifest` (keep what the manifest matched) or
`fail` (refuse the plan).

## Configuration

`testscope.config.json`, validated against [`schema.json`](./schema.json). Every field is optional:

```json
{
  "$schema": "./node_modules/@charliemartin0/testscope/schema.json",
  "root": "web",
  "runner": { "type": "playwright", "projectsEnv": "E2E_PROJECTS", "smokeGrep": "@smoke" },
  "manifest": { "path": "e2e/spec-manifest.json" },
  "smoke": { "specs": ["e2e/shell/home.spec.ts"], "canary": "e2e/shell/canary.spec.ts" },
  "judge": { "type": "http", "url": "https://judge.example.com/v1/score", "apiKeyEnv": "JUDGE_API_KEY" },
  "policy": { "onJudgeError": "smoke", "onAllSelected": "smoke", "onUnmapped": "smoke", "maxSpecs": 40 },
  "workers": 2
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `root` | `.` | Directory holding the tests; manifest paths are relative to it. |
| `runner` | `{ "type": "playwright" }` | `projects`, `projectsEnv`, `smokeGrep`, `outputDir`. |
| `manifest.path` | `testscope.manifest.json` | Relative to `root`. |
| `smoke.specs` / `smoke.canary` | manifest `smoke: true` entries | Curated fallback set. |
| `shared` | lockfiles, runner configs, `**/fixtures/**`, `**/.env*`, OpenAPI | Replaces the defaults when set. |
| `ignore`, `extraDiffRoots` | `[]` | |
| `judge` | `none`, threshold `0.25`, timeout `15000` ms, cache on | `apiKeyEnv` is the *name* of an env var, never a key. |
| `policy` | `smoke` / `all` / `smoke` | `onJudgeError`, `onAllSelected`, `onUnmapped`, `maxSpecs`. |
| `workers` | `2` | |

### Manifest

```json
{
  "e2e/billing/invoices.spec.ts": {
    "group": "billing",
    "title": "Invoices list",
    "routes": ["/invoices"],
    "sources": ["src/billing/**"],
    "smoke": false
  }
}
```

`group` feeds `runner.projectsEnv`; `title` and `routes` give a judge context.

## Library use

```ts
import { buildPlan, executionGroups, loadConfig, parseNameStatus } from '@charliemartin0/testscope';

const config = await loadConfig();
const plan = buildPlan({ config, manifest, changes: parseNameStatus(gitOutput) });
const groups = executionGroups(plan, config.smoke.canary);
```

## Roadmap

- **M0** (this): schema, loader, selection logic, tests, CI.
- **M1**: `select` / `run` / `explain` commands, Playwright runner, HTTP and command judges with caching, `--json`.
- **M2**: shadow mode, `manifest` generation, `evaluate` (replay merged PRs), GitHub Action, more runners.

## Development

```sh
npm ci
npm run lint && npm run typecheck && npm test
```

## License

MIT
