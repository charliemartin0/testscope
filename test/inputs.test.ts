import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { INPUT_DEFAULTS, parseConfig, sharedPathsFor, withDefaults } from '../src/inputs.js';

describe('action.yml', () => {
  it('declares exactly the inputs and defaults the code uses', () => {
    const yaml = readFileSync('action.yml', 'utf8');
    const block = yaml.slice(yaml.indexOf('inputs:'), yaml.indexOf('\noutputs:'));
    const declared: Record<string, string> = {};
    for (const match of block.matchAll(/^  ([a-z-]+):\n(?:    .*\n)*?    default: "(.*)"$/gm)) {
      declared[match[1]!] = JSON.parse(`"${match[2]}"`) as string;
    }
    expect(declared).toEqual(INPUT_DEFAULTS);
  });
});

describe('parseConfig', () => {
  it('uses defaults and warns by input name only for invalid values', () => {
    const warn = vi.fn();
    const config = parseConfig(
      withDefaults({ threshold: 'banana', 'timeout-ms': '-5', fallback: 'sometimes', 'max-selected-ratio': '2' }),
      warn
    );
    expect(config).toMatchObject({ threshold: 0.25, timeoutMs: 20000, fallback: 'full', maxSelectedRatio: 0.6 });
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages).toHaveLength(4);
    expect(messages.join('\n')).not.toMatch(/banana|sometimes/);
  });

  it('accepts valid overrides', () => {
    const warn = vi.fn();
    const config = parseConfig(withDefaults({ threshold: '0.5', fallback: 'smoke', 'dry-run': 'true' }), warn);
    expect(config).toMatchObject({ threshold: 0.5, fallback: 'smoke', dryRun: true });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('inputs', () => {
  it('treats empty strings from the runner as "use the default"', () => {
    expect(withDefaults({ threshold: '', model: '' }).threshold).toBe('0.25');
    expect(withDefaults({ 'typesafe-api-key': '' })['typesafe-api-key']).toBe('');
  });

  it('extracts suite-scoped shared paths, keeping globs that contain colons', () => {
    const inputs = withDefaults({ 'shared-paths': 'vitest:a/**\ndotnet:b/**\n\nvitest: c.ts ' });
    expect(sharedPathsFor(inputs, 'vitest')).toEqual(['a/**', 'c.ts']);
    expect(sharedPathsFor(inputs, 'dotnet')).toEqual(['b/**']);
  });
});
