import { type Judge, JudgeError, type JudgeRequest, checkScores } from '../judge.ts';
import { type HttpPreset, PRESETS } from './presets.ts';

export interface HttpJudgeOptions {
  url?: string;
  apiKey?: string;
  model?: string;
  preset?: 'generic' | 'jev';
  fetchImpl?: typeof fetch;
}

/**
 * Generic contract: POST the JudgeRequest as JSON with `Authorization: Bearer <key>`;
 * the response is `{ "scores": { "<spec>": 0..1 } }` covering every requested spec.
 */
export const GENERIC: HttpPreset = {
  body: (req) => req,
  parse: (res, specs) => checkScores((res as { scores?: unknown })?.scores, specs),
};

export class HttpJudge implements Judge {
  readonly name: string;
  private readonly opts: HttpJudgeOptions;
  private readonly preset: HttpPreset;
  constructor(opts: HttpJudgeOptions) {
    this.preset = opts.preset === 'jev' ? PRESETS.jev : GENERIC;
    this.name = `http:${opts.preset ?? 'generic'}`;
    this.opts = {
      ...opts,
      url: opts.url ?? this.preset.url,
      model: opts.model ?? this.preset.model,
    };
    if (!this.opts.url) throw new Error('http judge needs a url');
  }

  async score(request: JudgeRequest, { timeoutMs }: { timeoutMs: number }) {
    const key = this.opts.apiKey?.trim();
    if (this.preset.requiresKey && !key) throw new JudgeError('judge-missing-api-key');
    const specs = Object.keys(request.specs);
    const req = this.opts.model ? { ...request, model: this.opts.model } : request;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(this.opts.url as string, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(this.preset.body(req)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new JudgeError(
        (e as Error)?.name === 'TimeoutError' ? 'judge-timeout' : 'judge-http-error',
      );
    }
    if (!response.ok) throw new JudgeError('judge-http-error');
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new JudgeError('judge-invalid-answer');
    }
    return this.preset.parse(json, specs);
  }
}
