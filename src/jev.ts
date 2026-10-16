import type { Question } from './types.js';

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const CHUNK_SIZE = 80;

/** Closed set of error codes. Response bodies and transport error messages are never carried. */
export class JevError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'JevError';
  }
}

export interface AskNoulsOptions {
  state: Record<string, unknown>;
  questions: Record<string, Question>;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface AskNoulsResult {
  model: string;
  answers: Record<string, number>;
}

function redactDeep(value: unknown, key: string): unknown {
  if (typeof value === 'string') return value.replaceAll(key, '[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        redactDeep(name, key) as string,
        redactDeep(item, key),
      ])
    );
  }
  return value;
}

function normalize(error: unknown): JevError {
  if (error instanceof JevError) return error;
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return new JevError('jev-timeout');
  return new JevError('jev-error');
}

async function askChunk(
  chunk: [string, Question][],
  state: Record<string, unknown>,
  { apiKey, model, fetchImpl, signal }: { apiKey: string; model: string; fetchImpl: typeof fetch; signal: AbortSignal }
): Promise<AskNoulsResult> {
  const questions = Object.fromEntries(
    chunk.map(([id, question]) => [
      id,
      { type: 'noul', instructions: question.instructions, criteria: question.criteria },
    ])
  );
  const response = await fetchImpl(JEV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model, questions }),
    signal,
  });
  if (!response.ok) throw new JevError(`jev-http-${response.status}`);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new JevError('jev-parse-error');
  }
  const body = json as { model?: unknown; answers?: Record<string, { type?: unknown; noul?: unknown }> } | null;
  if (!body || typeof body !== 'object' || typeof body.answers !== 'object' || !body.answers) {
    throw new JevError('jev-parse-error');
  }
  const answers: Record<string, number> = {};
  for (const [id] of chunk) {
    const answer = body.answers[id];
    const noul = answer?.noul;
    if (
      answer?.type !== 'noul' ||
      typeof noul !== 'number' ||
      !Number.isFinite(noul) ||
      noul < 0 ||
      noul > 1
    ) {
      throw new JevError('jev-invalid-answer');
    }
    answers[id] = noul;
  }
  return { model: typeof body.model === 'string' ? body.model : model, answers };
}

/**
 * One Noul question per id, chunked (<=80 per request) and sent concurrently with identical state
 * under one shared deadline. Throws JevError with a code from the closed set.
 */
export async function askNouls(options: AskNoulsOptions): Promise<AskNoulsResult> {
  const { questions, apiKey, model, timeoutMs, fetchImpl = fetch } = options;
  if (!apiKey) throw new JevError('jev-missing-key');
  const state = redactDeep(options.state, apiKey) as Record<string, unknown>;
  const entries = Object.entries(questions);
  const chunks: [string, Question][][] = [];
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) chunks.push(entries.slice(i, i + CHUNK_SIZE));
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new JevError('jev-timeout')), timeoutMs);
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const results = await Promise.race([
      Promise.all(chunks.map((chunk) => askChunk(chunk, state, { apiKey, model, fetchImpl, signal }))),
      deadline.promise,
    ]);
    const answers: Record<string, number> = {};
    for (const result of results) Object.assign(answers, result.answers);
    return { model: results[0]?.model ?? model, answers };
  } catch (error) {
    throw normalize(error);
  } finally {
    clearTimeout(timer);
  }
}
