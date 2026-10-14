import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, DEFAULTS, resolveConfig } from '../src/config.ts';

// biome-ignore lint/suspicious/noExplicitAny: walking untyped JSON schema
type S = Record<string, any>;
const schema: S = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../schema.json'), 'utf8'),
);
const deref = (s: S): S => (s.$ref ? deref(schema.$defs[s.$ref.split('/').pop()]) : s);

function sample(s: S, name: string): unknown {
  const d = deref(s);
  if (d.const !== undefined) return d.const;
  if (d.enum) return d.enum[0];
  const type = Array.isArray(d.type) ? d.type[0] : d.type;
  if (type === 'string')
    return d.format === 'uri'
      ? 'https://example.com/x'
      : d.pattern
        ? 'SOME_NAME'
        : name === 'command'
          ? './x.sh'
          : 'x';
  if (type === 'integer') return 1;
  if (type === 'number') return 0.5;
  if (type === 'boolean') return true;
  if (type === 'array') return [];
  if (type === 'object') return {};
  throw new Error(`no sample for ${name}`);
}

const objects = (): [string, S][] => [
  ['', schema],
  ...Object.entries(schema.properties as S)
    .filter(([, v]) => deref(v).type === 'object')
    .map(([k, v]) => [k, deref(v)] as [string, S]),
];

test('every schema field is accepted by the loader', () => {
  for (const [at, obj] of objects())
    for (const [name, prop] of Object.entries(obj.properties as S)) {
      const value = sample(prop, name);
      const input = at ? { [at]: { [name]: value } } : { [name]: value };
      if (at === 'judge' && name === 'type') continue; // 'none' already default
      assert.doesNotThrow(() => resolveConfig(input), `${at}.${name}`);
    }
});

test('the loader rejects fields the schema does not declare', () => {
  for (const [at, obj] of objects()) {
    assert.equal(obj.additionalProperties, false, `${at || 'root'} must be closed`);
    const input = at ? { [at]: { notAField: 1 } } : { notAField: 1 };
    assert.throws(
      () => resolveConfig(input),
      (e: unknown) => e instanceof ConfigError && /notAField/.test(e.message),
    );
  }
});

test('schema defaults match loader defaults', () => {
  const d = DEFAULTS as unknown as S;
  for (const [at, obj] of objects())
    for (const [name, prop] of Object.entries(obj.properties as S)) {
      const def = prop.default ?? deref(prop).default;
      if (def === undefined) continue;
      assert.deepEqual(at ? d[at][name] : d[name], def, `${at}.${name}`);
    }
});

test('schema enums match loader enums', () => {
  for (const p of deref(schema.$defs.policy).enum)
    assert.doesNotThrow(() => resolveConfig({ policy: { onUnmapped: p } }));
  assert.throws(() => resolveConfig({ policy: { onUnmapped: 'other' } }));
  for (const t of schema.properties.judge.properties.type.enum)
    assert.doesNotThrow(() =>
      resolveConfig({ judge: { type: t, url: 'https://example.com', command: './x' } }),
    );
});
