import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInvocations, reportSpecs, validateExtraArgs } from '../src/runners/playwright.ts';
import { manifest } from './helpers.ts';

const runner = {
  type: 'playwright' as const,
  onlyChanged: true,
  projectsEnv: 'E2E_GROUPS',
  smokeGrep: '@smoke',
};

test('buildInvocations anchors spec paths, sets groups env and smoke grep', () => {
  const inv = buildInvocations(
    [
      { specs: ['e2e/users/list.spec.ts'], smokeOnly: false },
      { specs: ['e2e/shell/canary.spec.ts'], smokeOnly: true },
    ],
    { root: '/r/web', runner, manifest, workers: 2, extraArgs: ['--repeat-each=3'] },
  );
  assert.deepEqual(inv[0], {
    env: { E2E_GROUPS: 'users' },
    args: [
      'test',
      '/r/web/e2e/users/list\\.spec\\.ts$',
      '--output=test-results/testscope/run-0',
      '--workers=2',
      '--repeat-each=3',
    ],
  });
  assert.deepEqual(inv[1]?.args.slice(-4), [
    '--output=test-results/testscope/run-1',
    '--grep=@smoke',
    '--workers=2',
    '--repeat-each=3',
  ]);
});

test('caller --workers wins and projects are forwarded', () => {
  const [inv] = buildInvocations([{ specs: ['e2e/users/list.spec.ts'], smokeOnly: false }], {
    root: '/r',
    runner: { ...runner, projects: ['chromium'] },
    manifest,
    workers: 2,
    extraArgs: ['--workers=1'],
  });
  assert.ok(inv?.args.includes('--project=chromium'));
  assert.deepEqual(
    inv?.args.filter((a) => a.startsWith('--workers')),
    ['--workers=1'],
  );
});

test('selection-changing passthrough flags are refused', () => {
  for (const bad of ['--grep=x', '--project=y', 'some.spec.ts', '--config=z'])
    assert.throws(() => validateExtraArgs([bad]));
  assert.doesNotThrow(() => validateExtraArgs(['--trace=on', '--headed', '--retries=1']));
});

test('reportSpecs flattens nested suites relative to the test root', () => {
  const report = {
    config: { rootDir: '/r/web/e2e' },
    suites: [
      {
        suites: [{ specs: [{ file: 'users/list.spec.ts' }] }],
        specs: [{ file: 'shell/home.spec.ts' }],
      },
    ],
  };
  assert.deepEqual(reportSpecs(report, '/r/web'), [
    'e2e/shell/home.spec.ts',
    'e2e/users/list.spec.ts',
  ]);
  assert.throws(() => reportSpecs({ errors: [{}] }, '/r'), /collection failed/);
});
