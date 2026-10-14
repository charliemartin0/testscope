import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDebug } from '../src/debug.ts';
import { explainPlan } from '../src/explain.ts';
import { buildPlan } from '../src/plan.ts';
import { config, manifest, mod } from './helpers.ts';

test('explains selected specs and their reasons', () => {
  const plan = buildPlan({
    config: config(),
    manifest,
    changes: mod('web/src/users/a.ts', 'web/e2e/billing/invoices.spec.ts'),
  });
  const text = explainPlan(plan, manifest);
  assert.match(text, /Mode: selected; 3\/5 specs/);
  assert.match(
    text,
    /e2e\/users\/list\.spec\.ts\n {4}- changed file src\/users\/a\.ts matches its sources/,
  );
  assert.match(text, /the spec file itself changed/);
  assert.match(text, /smoke canary/);
});

test('explains fallbacks, downgrades, unmapped files and judge scores', () => {
  const smoke = buildPlan({ config: config(), manifest, changes: mod('web/src/misc.ts') });
  assert.match(
    explainPlan(smoke, manifest),
    /maps to no spec \(src\/misc\.ts\); policy\.onUnmapped/,
  );
  assert.match(
    explainPlan(smoke, manifest),
    /Changed files that map to no spec:\n {2}src\/misc\.ts/,
  );
  const down = buildPlan({
    config: config({ policy: { onAllSelected: 'smoke' } }),
    manifest,
    changes: mod('web/package.json'),
  });
  assert.match(explainPlan(down, manifest), /Downgraded from all \(5 specs would have run\)/);
  const judged = buildPlan({
    config: config(),
    manifest,
    changes: mod('web/src/misc.ts'),
    judge: { scores: { 'e2e/users/list.spec.ts': 0.9, 'e2e/billing/invoices.spec.ts': 0.1 } },
  });
  assert.match(
    explainPlan(judged, manifest),
    /Scored but not selected:\n {2}0\.10 {2}e2e\/billing\/invoices\.spec\.ts/,
  );
});

test('explains a single spec', () => {
  const plan = buildPlan({
    config: config(),
    manifest,
    changes: mod('web/src/misc.ts'),
    judge: { scores: { 'e2e/users/list.spec.ts': 0.1 } },
  });
  assert.match(
    explainPlan(plan, manifest, 'e2e/users/list.spec.ts'),
    /NOT selected\.\n {2}- judge score 0\.1 is below/,
  );
  assert.match(
    explainPlan(plan, manifest, 'e2e/shell/canary.spec.ts'),
    /SELECTED because:\n {2}- it is the smoke canary/,
  );
  assert.match(explainPlan(plan, manifest, 'nope.spec.ts'), /not in the manifest/);
});

test('debug logger is silent unless enabled', () => {
  const out: string[] = [];
  createDebug(false, (s) => out.push(s))('hidden');
  createDebug(true, (s) => out.push(s))('shown');
  assert.equal(out.length, 1);
  assert.match(out[0] ?? '', /^\[testscope \+\d+ms\] shown\n$/);
});
