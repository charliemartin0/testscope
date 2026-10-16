# testscope

Select the tests a change can affect, with [Jev](https://docs.typesafe.ai) as the judge and deterministic code as the policy. A GitHub Action (Node 24, bundled) and a `testscope` CLI with adapters for **Playwright**, **Vitest** and **.NET (`dotnet test`)**.

The action never fails your workflow. Every error degrades to a whole-suite outcome (`full`, `smoke` or `none`, your choice) and the reason is recorded in the outputs, the step summary and a plan artifact.

## How Jev is used

For each suite the adapter produces *candidates* (spec files, test files, or test classes). testscope sends **one Noul question per candidate** (`POST https://api.typesafe.ai/v1/systemone`, native `fetch`, no SDK) with shared state (the diff, the changed files, a description of each candidate). Questions are chunked at 80 per request, sent concurrently under one deadline; state is the same in every chunk. Jev only returns probabilities. **What to run is decided in code**, not by the model.

Model state is bounded: a diff over 100,000 characters is replaced by its `--stat` summary. The API key is redacted from every string sent as state.

### Rules, in order

For each suite, the first matching rule wins:

1. No changed files under the suite's working directory → `none` / `no-relevant-changes`.
2. A changed file matches a shared-infra glob → whole suite, `shared-infra:<file>`.
3. Collection failed or the adapter found a deterministic reason (e.g. `non-code-change:<file>`, `dotnet-no-candidates`, `vitest-collection-error`) → whole suite.
4. Internal selector error → whole suite, `selector-error`.
5. No API key, or a Jev error (`jev-missing-key`, `jev-timeout`, `jev-http-<status>`, `jev-parse-error`, `jev-invalid-answer`, `jev-error`) → whole suite with that reason.
6. More than `max-uncertain-ratio` of answers within `uncertain-band` of 0.5 → whole suite, `jev-uncertain`.
7. Selected set = `p >= threshold` ∪ tests forced by the adapter (changed tests, `--only-changed` results, canary).
8. `selected / total > max-selected-ratio` → whole suite, `selected-ratio-exceeded`.
9. Nothing selected → `none` / `jev-selected-none`.
10. Otherwise `selected` / `jev`.

"Whole suite" applies `fallback`: `full`, `smoke` (the adapter's smoke list; Vitest and .NET have none, so smoke means full and the summary says so), or `none` (reason gets `;fallback-none`). With no candidates at all (nothing depends on the change) the result is `none` / `no-candidates`.

### Adapters

| Suite | Candidates | Forced | Whole-suite triggers (default shared globs) |
| --- | --- | --- | --- |
| `playwright` | every spec in the (generated or committed) manifest | `playwright test --only-changed`, canary | `playwright.config.*`, `package.json`, lockfiles |
| `vitest` | `vitest list --changed` | changed test files | `vitest.config.*`, `vitest.workspace.*`, `package.json`, lockfiles, `tsconfig*.json` |
| `dotnet` | test classes found by csproj graph + namespace + type-reference heuristics | changed test classes | `Directory.Build.*`, `Directory.Packages.props`, `global.json`, `*.sln`, `nuget.config`, `packages.lock.json`; any non-`.cs` change in a project |

Add more with `shared-paths` (`suite:glob` lines, repo-root-relative).

## Action

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # base..head must be reachable
- id: select
  uses: charliemartin0/testscope@v1
  with:
    typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
    suites: vitest
    vitest-working-directory: web
- name: Run selected tests
  if: steps.select.outputs.vitest-mode != 'none'
  working-directory: web
  env:
    TESTSCOPE_CMD: ${{ steps.select.outputs.vitest-command }}
  run: eval "$TESTSCOPE_CMD"   # pass via env, never interpolate into the script
```

### Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `typesafe-api-key` | | Jev key. Registered as a secret; only ever sent as the bearer token. |
| `base-ref` | PR `base.sha`, else `merge_group.base_sha`, else `origin/<default branch>` | Diff base (merge-base with head). |
| `head-ref` | `HEAD` | Diff head. Keep it equal to the checked-out commit: Playwright (`--only-changed`) and Vitest (`--changed`) always compare against the checked-out `HEAD`. |
| `suites` | `playwright,vitest,dotnet` | Comma list. |
| `playwright-working-directory`, `vitest-working-directory`, `dotnet-working-directory` | `.` | Relative to the repo root. |
| `playwright-manifest` | `e2e/spec-manifest.json` | Committed manifest. If missing or stale it is regenerated (warning). |
| `playwright-canary` | | Spec always selected (runs smoke-only unless affected). |
| `playwright-smoke-specs` | | Multiline: specs for the `smoke` fallback (must be `@smoke` in the manifest). |
| `playwright-env` | | Multiline `KEY=VALUE` for `--only-changed` collection. |
| `playwright-app-env` | | Env var name that receives the comma list of apps of the selected specs. |
| `playwright-args` | | Appended to the Playwright command. |
| `vitest-command` | `npx vitest` | |
| `vitest-projects` | | Comma/space list passed as `--project`. |
| `vitest-args` | | Appended to `vitest run`. |
| `dotnet-test-args` | | Appended to every `dotnet test`. |
| `dotnet-full-target` | | Target(s) for the whole-suite command (sln/csproj). One per line: one `dotnet test` each, joined with `&&`. |
| `shared-paths` | | Multiline `suite:glob`. |
| `threshold` | `0.25` | Select when `p >= threshold`. |
| `timeout-ms` | `20000` | Shared deadline for the Jev calls. |
| `fallback` | `full` | `full`, `smoke` or `none`. |
| `max-selected-ratio` | `0.6` | |
| `uncertain-band` | `0.1` | |
| `max-uncertain-ratio` | `0.3` | |
| `model` | `jev-1.13.0` | Pinned stable model (`jev-latest` at time of writing). |
| `dry-run` | `false` | Compute and report, but output `mode=full`, `command=<full>`, `reason=dry-run:<real reason>`. Jev is still called (shadow mode). |

Invalid numeric/enum inputs warn (naming the input) and use the default.

### Outputs

For each suite `s` in `playwright`, `vitest`, `dotnet`: `s-mode` (`none|selected|full|smoke`), `s-reason`, `s-selected-count`, `s-selected` (JSON array), `s-command` (a shell command; run with `eval` from the suite's working directory). Also `dotnet-filters` (JSON `[{project, filter}]`) and `plan-path`.

A decision table is added to the step summary and the plan JSON is uploaded as artifact `testscope-plan-<run id>-<attempt>`. Jev answers are cached with `@actions/cache` (key hashes the diff, candidates, model and thresholds; only successful answers are saved; cache errors only warn).

## Examples

### Playwright with manifest, canary and smoke fallback

```yaml
- id: select
  uses: charliemartin0/testscope@v1
  with:
    typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
    suites: playwright
    playwright-working-directory: Frontend
    playwright-canary: e2e/platform-admin/shell/shell-canary.spec.ts
    playwright-smoke-specs: |
      e2e/platform-admin/shell/shell-canary.spec.ts
      e2e/admin/shell/shell-home.spec.ts
    playwright-env: E2E_APPS=platform-admin,admin,public
    playwright-app-env: E2E_APPS
    fallback: smoke
    max-selected-ratio: '0.99' # a selection of every spec also falls back to smoke
```

### Vitest

```yaml
- id: select
  uses: charliemartin0/testscope@v1
  with:
    typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
    suites: vitest
    vitest-working-directory: Frontend
    vitest-command: yarn vitest
    vitest-args: --silent
- if: steps.select.outputs.vitest-mode != 'none'
  working-directory: Frontend
  env:
    TESTSCOPE_CMD: ${{ steps.select.outputs.vitest-command }}
  run: eval "$TESTSCOPE_CMD"
```

Install dependencies **before** the action: `vitest list` needs them.

### .NET

```yaml
- id: select
  uses: charliemartin0/testscope@v1
  with:
    typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
    suites: dotnet
    dotnet-working-directory: Backend
    dotnet-full-target: App.sln
    dotnet-test-args: --configuration Release
- if: steps.select.outputs.dotnet-mode != 'none'
  working-directory: Backend
  env:
    TESTSCOPE_CMD: ${{ steps.select.outputs.dotnet-command }}
  run: eval "$TESTSCOPE_CMD"
```

The command is one `dotnet test <project> --filter "FullyQualifiedName~A|FullyQualifiedName~B"` per affected test project; `dotnet-filters` has the same data as JSON.

## CLI

```sh
npx --yes github:charliemartin0/testscope select --base-ref origin/main --suites vitest --vitest-working-directory web
# or, from a checkout:  node dist/cli/index.js select ...
```

Flags mirror the action inputs (`--<input-name>`). The key is read **only** from `TYPESAFE_API_KEY`. `select` always exits 0.

### `testscope evaluate`

Retrospective check against merged PRs:

```sh
TYPESAFE_API_KEY=... testscope evaluate --count 20 --ref origin/main --suites vitest,dotnet \
  --vitest-working-directory Frontend --dotnet-working-directory Backend \
  --out report.json --markdown report.md
```

For each first-parent merged PR the tests the PR itself changed are the ground truth. Those files are **held out** of the diff before selection, so the selector must infer them from the source changes. Reported per suite: recall (`hits / truth`), the misses, spec/test reduction, selection modes, and how many PRs reached Jev. This is a recall *proxy*: tests changed in the same PR, held out from the diff. It replays today's suite against historical filenames and requires a clean working tree. Exit code 2 when the key is missing.

## Security notes

- The key is `core.setSecret`-ed, never an input to adapters, never written to the plan or summary, and redacted from model state.
- Jev response bodies and transport error messages are never logged; only the closed set of error codes above.
- Commands are exposed as outputs; run them through an env var and `eval`, not `${{ }}` interpolation into the script. Paths in commands are shell-quoted.
- Whatever is in the diff is sent to Jev. Do not use this on repositories whose code may not leave your boundary.

## Development

```sh
npm ci && npm run typecheck && npm test && npm run build   # dist/ is committed and CI-checked
npm run fixture -- /tmp/fixture                            # throwaway repo used by self-test
```
