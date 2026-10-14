import assert from 'node:assert/strict';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { resolveConfig } from '../src/config.ts';
import { buildRequest, judgeErrorCode } from '../src/judge.ts';
import { CommandJudge, HttpJudge, createJudge } from '../src/judges/index.ts';
import { manifest } from './helpers.ts';

const specs = Object.keys(manifest);
const req = buildRequest(manifest, ['web/src/a.ts'], 'diff --git a b');
let server: Server;
let url = '';
let last: { auth?: string; body?: Record<string, unknown> } = {};
let reply: (body: Record<string, unknown>) => [number, unknown] = () => [200, {}];

before(async () => {
  server = createServer((r, w) => {
    let data = '';
    r.on('data', (c) => {
      data += c;
    });
    r.on('end', () => {
      last = { auth: r.headers.authorization, body: JSON.parse(data) };
      const [status, body] = reply(last.body ?? {});
      if (status === 0) return; // hang
      w.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/score`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test('generic http contract posts the request and reads scores', async () => {
  reply = (b) => [
    200,
    { scores: Object.fromEntries(Object.keys(b.specs as object).map((s) => [s, 0.5])) },
  ];
  const j = new HttpJudge({ url, apiKey: 'k-123', model: 'm1' });
  const scores = await j.score(req, { timeoutMs: 2000 });
  assert.equal(Object.keys(scores).length, specs.length);
  assert.equal(last.auth, 'Bearer k-123');
  assert.equal(last.body?.model, 'm1');
  assert.deepEqual(last.body?.changedFiles, ['web/src/a.ts']);
});

test('http errors, bad answers and timeouts map to safe codes', async () => {
  const j = new HttpJudge({ url });
  reply = () => [500, { error: 'secret detail' }];
  await assert.rejects(j.score(req, { timeoutMs: 2000 }), /^JudgeError: judge-http-error$/);
  reply = () => [200, { scores: { [specs[0] as string]: 2 } }];
  await assert.rejects(j.score(req, { timeoutMs: 2000 }), /judge-invalid-answer/);
  reply = () => [0, null];
  await assert.rejects(j.score(req, { timeoutMs: 100 }), /judge-timeout/);
});

test('jev preset builds noul questions and parses answers', async () => {
  reply = (b) => [
    200,
    {
      answers: Object.fromEntries(
        Object.keys(b.questions as object).map((q, i) => [q, { type: 'noul', noul: i / 10 }]),
      ),
    },
  ];
  const j = new HttpJudge({ url, preset: 'jev', apiKey: 'k' });
  const scores = await j.score(req, { timeoutMs: 2000 });
  assert.equal(last.body?.model, 'jev-latest');
  assert.equal((last.body?.questions as Record<string, { type: string }>).spec_0?.type, 'noul');
  assert.equal(scores[specs.sort()[1] as string], 0.1);
  await assert.rejects(
    new HttpJudge({ url, preset: 'jev' }).score(req, { timeoutMs: 100 }),
    /judge-missing-api-key/,
  );
});

test('requests redact the active secret', () => {
  const r = buildRequest(manifest, ['a-SECRET.ts'], 'token=SECRET', { secret: 'SECRET' });
  assert.deepEqual(r.changedFiles, ['a-[REDACTED].ts']);
  assert.equal(r.diffSummary, 'token=[REDACTED]');
});

test('command judge reads scores from a local script', async () => {
  const script = `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(JSON.stringify({scores:Object.fromEntries(Object.keys(r.specs).map(s=>[s,0.3]))}))})"`;
  const scores = await new CommandJudge(script, process.cwd()).score(req, { timeoutMs: 5000 });
  assert.equal(scores[specs[0] as string], 0.3);
  await assert.rejects(
    new CommandJudge('exit 3', process.cwd()).score(req, { timeoutMs: 5000 }),
    /judge-command-error/,
  );
  await assert.rejects(
    new CommandJudge('echo nope', process.cwd()).score(req, { timeoutMs: 5000 }),
    /judge-invalid-answer/,
  );
  await assert.rejects(
    new CommandJudge('sleep 5', process.cwd()).score(req, { timeoutMs: 100 }),
    /judge-timeout/,
  );
});

test('createJudge reads the key from the named env var and supports none', () => {
  assert.equal(createJudge(resolveConfig({}).judge, '.'), undefined);
  const j = createJudge(resolveConfig({ judge: { type: 'http', preset: 'jev' } }).judge, '.', {
    TYPESAFE_API_KEY: 'x',
  });
  assert.equal(j?.name, 'http:jev');
  assert.equal(
    createJudge(resolveConfig({ judge: { type: 'command', command: 'x' } }).judge, '.')?.name,
    'command',
  );
  assert.equal(judgeErrorCode(new Error('raw upstream text')), 'judge-error');
});
