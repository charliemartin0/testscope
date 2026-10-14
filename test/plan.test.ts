import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolicyError, buildPlan, executionGroups, smokeSet } from '../src/plan.ts';
import { config, manifest, mod } from './helpers.ts';

const CANARY = 'e2e/shell/canary.spec.ts';

test('no changes in scope selects nothing', () => {
  assert.equal(buildPlan({ config: config(), manifest, changes: [] }).mode, 'none');
  assert.equal(
    buildPlan({ config: config(), manifest, changes: mod('docs/readme.md') }).mode,
    'none',
  );
  assert.equal(
    buildPlan({ config: config({ ignore: ['**/*.md'] }), manifest, changes: mod('web/notes.md') })
      .mode,
    'none',
  );
});

test('source globs select specs and add the canary', () => {
  const p = buildPlan({
    config: config(),
    manifest,
    changes: mod('web/src/billing/refunds/form.ts'),
  });
  assert.equal(p.mode, 'selected');
  assert.deepEqual(p.selected, [
    'e2e/billing/invoices.spec.ts',
    'e2e/billing/refunds.spec.ts',
    CANARY,
  ]);
  assert.deepEqual(p.reasons[CANARY], ['smoke-canary']);
  assert.deepEqual(p.groups, ['billing', 'shell']);
});

test('changed spec is selected; deleted spec is not', () => {
  const p = buildPlan({
    config: config(),
    manifest,
    changes: [
      { status: 'modified', path: 'web/e2e/users/list.spec.ts' },
      { status: 'deleted', path: 'web/e2e/billing/refunds.spec.ts' },
    ],
  });
  assert.deepEqual(p.selected, [CANARY, 'e2e/users/list.spec.ts']);
});

test('renames consider both old and new paths', () => {
  const p = buildPlan({
    config: config(),
    manifest,
    changes: [{ status: 'renamed', oldPath: 'web/src/users/a.ts', path: 'web/lib/a.ts' }],
  });
  // old path maps to users; new path is unmapped -> default smoke fallback
  assert.equal(p.mode, 'smoke-fallback');
  assert.deepEqual(p.unmapped, ['lib/a.ts']);
  const q = buildPlan({
    config: config({ policy: { onUnmapped: 'manifest' } }),
    manifest,
    changes: [{ status: 'renamed', oldPath: 'web/src/users/a.ts', path: 'web/lib/a.ts' }],
  });
  assert.deepEqual(q.selected, [CANARY, 'e2e/users/list.spec.ts']);
});

test('unmapped policy variants', () => {
  const changes = mod('web/src/misc.ts');
  assert.equal(
    buildPlan({ config: config(), manifest, changes }).fallbackReason,
    'unmapped:src/misc.ts',
  );
  assert.equal(
    buildPlan({ config: config({ policy: { onUnmapped: 'all' } }), manifest, changes }).mode,
    'all',
  );
  assert.throws(
    () => buildPlan({ config: config({ policy: { onUnmapped: 'fail' } }), manifest, changes }),
    PolicyError,
  );
});

test('extra diff roots count as changes', () => {
  const p = buildPlan({ config: config(), manifest, changes: mod('api/handlers/x.go') });
  assert.equal(p.mode, 'smoke-fallback');
  assert.deepEqual(p.unmapped, ['api/handlers/x.go']);
});

test('shared files select all, or smoke when all-selected is downgraded', () => {
  const all = buildPlan({ config: config(), manifest, changes: mod('web/package.json') });
  assert.equal(all.mode, 'all');
  assert.equal(all.selected.length, 5);
  assert.equal(all.fallbackReason, 'shared:package.json');
  const smoke = buildPlan({
    config: config({ policy: { onAllSelected: 'smoke' } }),
    manifest,
    changes: mod('web/.env.test'),
  });
  assert.equal(smoke.mode, 'smoke-fallback');
  assert.deepEqual(smoke.selected, [CANARY, 'e2e/shell/home.spec.ts']);
  assert.deepEqual(smoke.downgradedFrom, { mode: 'all', selectedCount: 5 });
  assert.throws(
    () =>
      buildPlan({
        config: config({ policy: { onAllSelected: 'fail' } }),
        manifest,
        changes: mod('web/package.json'),
      }),
    PolicyError,
  );
});

test('judge scores above threshold are selected', () => {
  const p = buildPlan({
    config: config(),
    manifest,
    changes: mod('web/src/misc.ts'),
    judge: { scores: { 'e2e/users/list.spec.ts': 0.25, 'e2e/billing/invoices.spec.ts': 0.24 } },
  });
  assert.equal(p.mode, 'selected');
  assert.deepEqual(p.selected, [CANARY, 'e2e/users/list.spec.ts']);
  assert.deepEqual(p.reasons['e2e/users/list.spec.ts'], ['judge']);
  assert.equal(p.scores['e2e/billing/invoices.spec.ts'], 0.24);
});

test('judge errors follow onJudgeError', () => {
  const changes = mod('web/src/users/x.ts');
  const smoke = buildPlan({
    config: config(),
    manifest,
    changes,
    judge: { error: 'judge-timeout' },
  });
  assert.equal(smoke.mode, 'smoke-fallback');
  assert.equal(smoke.fallbackReason, 'judge-timeout');
  const kept = buildPlan({
    config: config({ policy: { onJudgeError: 'manifest' } }),
    manifest,
    changes,
    judge: { error: 'x' },
  });
  assert.deepEqual(kept.selected, ['e2e/users/list.spec.ts']);
  const bad = buildPlan({
    config: config(),
    manifest,
    changes,
    judge: { scores: { 'e2e/users/list.spec.ts': 7 } },
  });
  assert.equal(bad.fallbackReason, 'judge-invalid-answer');
});

test('runner-changed specs are merged in', () => {
  const p = buildPlan({
    config: config(),
    manifest,
    changes: mod('web/src/users/x.ts'),
    runnerChanged: ['e2e/billing/invoices.spec.ts', 'e2e/unknown.spec.ts'],
  });
  assert.deepEqual(p.reasons['e2e/billing/invoices.spec.ts'], ['runner-changed']);
  assert.ok(!p.selected.includes('e2e/unknown.spec.ts'));
});

test('budget cap downgrades to curated smoke', () => {
  const p = buildPlan({
    config: config({ policy: { maxSpecs: 2 } }),
    manifest,
    changes: mod('web/src/billing/refunds/x.ts'),
  });
  assert.equal(p.mode, 'smoke-fallback');
  assert.equal(p.fallbackReason, 'budget:3>2');
  assert.ok(p.smokeOnly);
});

test('selection covering every spec follows onAllSelected', () => {
  const scores = Object.fromEntries(Object.keys(manifest).map((s) => [s, 0.9]));
  const p = buildPlan({
    config: config({ policy: { onAllSelected: 'smoke' } }),
    manifest,
    changes: mod('web/src/x.ts'),
    judge: { scores },
  });
  assert.equal(p.mode, 'smoke-fallback');
  assert.equal(p.downgradedFrom?.selectedCount, 5);
});

test('root "." uses repo-relative paths', () => {
  const p = buildPlan({
    config: config({ root: '.', extraDiffRoots: [] }),
    manifest,
    changes: mod('src/users/a.ts'),
  });
  assert.deepEqual(p.selected, [CANARY, 'e2e/users/list.spec.ts']);
});

test('smokeSet uses manifest smoke flags when no list is configured and validates canary', () => {
  assert.deepEqual(smokeSet(config({ smoke: {} }), manifest), [CANARY, 'e2e/shell/home.spec.ts']);
  assert.throws(
    () => smokeSet(config({ smoke: { canary: 'missing.spec.ts' } }), manifest),
    /canary/,
  );
  assert.throws(() => smokeSet(config({ smoke: {} }), { 'a.spec.ts': {} }), /no smoke specs/);
});

test('execution groups run the canary smoke-only unless affected', () => {
  const p = buildPlan({ config: config(), manifest, changes: mod('web/src/users/a.ts') });
  assert.deepEqual(executionGroups(p, CANARY), [
    { specs: ['e2e/users/list.spec.ts'], smokeOnly: false },
    { specs: [CANARY], smokeOnly: true },
  ]);
  const q = buildPlan({ config: config(), manifest, changes: mod('web/e2e/shell/canary.spec.ts') });
  assert.deepEqual(executionGroups(q, CANARY), [{ specs: [CANARY], smokeOnly: false }]);
  const s = buildPlan({ config: config(), manifest, changes: mod('web/src/misc.ts') });
  assert.deepEqual(executionGroups(s, CANARY), [{ specs: s.selected, smokeOnly: true }]);
  assert.deepEqual(
    executionGroups(buildPlan({ config: config(), manifest, changes: [] }), CANARY),
    [],
  );
});
