import { describe, expect, it, vi } from 'vitest';
import { askNouls, JevError } from '../src/jev.js';
import type { Question } from '../src/types.js';

const question: Question = { instructions: 'q', criteria: { true: 't', false: 'f' } };

function questions(count: number): Record<string, Question> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`q_${i}`, question]));
}

function okFetch(value = 0.5) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: value }])
    );
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers }), { status: 200 });
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as JevError).code;
  }
  return 'no-error';
}

const base = { apiKey: 'sk-secret-key', model: 'jev-1.13.0', timeoutMs: 1000 };

describe('askNouls', () => {
  it('splits 200 questions into 3 chunks of <=80 with identical state', async () => {
    const fetchImpl = okFetch(0.4);
    const result = await askNouls({ ...base, state: { patch: 'x' }, questions: questions(200), fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { state: unknown; questions: object });
    expect(bodies.map((body) => Object.keys(body.questions).length).sort((a, b) => a - b)).toEqual([40, 80, 80]);
    expect(new Set(bodies.map((body) => JSON.stringify(body.state))).size).toBe(1);
    expect(Object.keys(result.answers)).toHaveLength(200);
    expect(result.answers.q_199).toBe(0.4);
  });

  it('sends bearer auth and the model to the Jev endpoint', async () => {
    const fetchImpl = okFetch();
    await askNouls({ ...base, state: {}, questions: questions(1), fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret-key');
    expect(JSON.parse(String(init?.body)).model).toBe('jev-1.13.0');
  });

  it('maps a hung request to jev-timeout', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    expect(await codeOf(askNouls({ ...base, timeoutMs: 20, state: {}, questions: questions(1), fetchImpl }))).toBe('jev-timeout');
  });

  it('maps an aborted fetch to jev-timeout', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
      return new Response('{}');
    });
    expect(await codeOf(askNouls({ ...base, timeoutMs: 20, state: {}, questions: questions(1), fetchImpl }))).toBe('jev-timeout');
  });

  it.each([401, 529])('maps HTTP %i to jev-http-%i without leaking the body', async (status) => {
    const fetchImpl = vi.fn(async () => new Response('secret response body sk-secret-key', { status }));
    const promise = askNouls({ ...base, state: {}, questions: questions(1), fetchImpl });
    const error = (await promise.catch((e: unknown) => e)) as JevError;
    expect(error.code).toBe(`jev-http-${status}`);
    expect(error.message).not.toContain('secret');
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it('maps malformed JSON to jev-parse-error', async () => {
    const fetchImpl = vi.fn(async () => new Response('{not json', { status: 200 }));
    expect(await codeOf(askNouls({ ...base, state: {}, questions: questions(1), fetchImpl }))).toBe('jev-parse-error');
  });

  it.each([1.5, -0.1, Number.NaN])('rejects out-of-range noul %s', async (value) => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ answers: { q_0: { type: 'noul', noul: value } } }), { status: 200 })
    );
    expect(await codeOf(askNouls({ ...base, state: {}, questions: questions(1), fetchImpl }))).toBe('jev-invalid-answer');
  });

  it('rejects a missing answer and a non-noul answer', async () => {
    const missing = vi.fn(async () => new Response(JSON.stringify({ answers: {} }), { status: 200 }));
    expect(await codeOf(askNouls({ ...base, state: {}, questions: questions(1), fetchImpl: missing }))).toBe('jev-invalid-answer');
    const wrong = vi.fn(async () => new Response(JSON.stringify({ answers: { q_0: { type: 'bool', noul: 1 } } }), { status: 200 }));
    expect(await codeOf(askNouls({ ...base, state: {}, questions: questions(1), fetchImpl: wrong }))).toBe('jev-invalid-answer');
  });

  it('maps unexpected transport failures to jev-error without the message', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED with Authorization Bearer sk-secret-key');
    });
    const error = (await askNouls({ ...base, state: {}, questions: questions(1), fetchImpl }).catch((e: unknown) => e)) as JevError;
    expect(error.code).toBe('jev-error');
    expect(error.message).toBe('jev-error');
  });

  it('requires a key', async () => {
    expect(await codeOf(askNouls({ ...base, apiKey: '', state: {}, questions: questions(1), fetchImpl: okFetch() }))).toBe('jev-missing-key');
  });

  it('redacts the key from every state string', async () => {
    const fetchImpl = okFetch();
    await askNouls({
      ...base,
      state: { patch: 'token=sk-secret-key', nested: { files: ['a-sk-secret-key.ts'], 'sk-secret-key': 1 } },
      questions: questions(1),
      fetchImpl,
    });
    const body = String(fetchImpl.mock.calls[0]![1]?.body);
    expect(body).not.toContain('sk-secret-key');
    expect(body).toContain('[REDACTED]');
  });
});
