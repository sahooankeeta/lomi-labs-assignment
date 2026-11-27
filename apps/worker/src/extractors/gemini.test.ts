import { describe, expect, it } from 'vitest';
import { GeminiExtractor } from './gemini.js';
import type { ExtractRequest } from './types.js';

const KEY = 'secret-key-123';
const OUTPUT = { fields: [{ field: 'a', value: '1', evidence: 'a: 1', gap_reason: null }] };

const req: ExtractRequest = {
  type: 'invoice',
  fields: [{ field: 'a', type: 'string' }],
  chunkText: 'a: 1',
  prompt: { system: 'SYS', user: 'USR' },
};

const okBody = (text: string, finishReason = 'STOP') => ({
  candidates: [{ finishReason, content: { parts: [{ text }] } }],
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = (status: number, message: string) => json(status, { error: { message } });

interface Call {
  url: string;
  init: RequestInit;
}
type Step = Response | Error | ((c: Call) => Promise<Response>);

/** A fake fetch answering from a script, one entry per call; records every call. */
function fakeFetch(script: Step[]) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const step = script[calls.length - 1];
    if (!step) throw new Error('unexpected extra fetch call');
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(call);
    return step;
  }) as typeof fetch;
  return { fn, calls };
}

const make = (script: Step[]) => {
  const f = fakeFetch(script);
  const ex = new GeminiExtractor({
    apiKey: KEY,
    model: 'gemini-3.6-flash',
    fallbackModels: ['fallback-1'],
    retryDelayMs: 0,
    fetch: f.fn,
  });
  return { ex, calls: f.calls };
};
const modelOf = (c: Call) => /models\/([^:]+):generateContent/.exec(c.url)?.[1];

describe('GeminiExtractor', () => {
  it('sends the request to the primary model and returns parsed output', async () => {
    const { ex, calls } = make([json(200, okBody(JSON.stringify(OUTPUT)))]);
    const res = await ex.extract(req);
    expect(ex.model).toBe('gemini-3.6-flash');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
    );
    expect(calls[0]!.url).not.toContain(KEY);
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe('SYS');
    expect(body.contents[0].parts[0].text).toBe('USR');
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema.required).toEqual(['fields']);
    expect(res.output).toEqual(OUTPUT);
    expect(res.raw).toMatchObject({
      model: 'gemini-3.6-flash',
      response: okBody(JSON.stringify(OUTPUT)),
    });
  });

  it('retries a 503 once on the same model', async () => {
    const { ex, calls } = make([err(503, 'busy'), json(200, okBody(JSON.stringify(OUTPUT)))]);
    await expect(ex.extract(req)).resolves.toMatchObject({ output: OUTPUT });
    expect(calls.map(modelOf)).toEqual(['gemini-3.6-flash', 'gemini-3.6-flash']);
  });

  it('treats 429 like 503', async () => {
    const { ex, calls } = make([err(429, 'quota'), json(200, okBody(JSON.stringify(OUTPUT)))]);
    await ex.extract(req);
    expect(calls).toHaveLength(2);
  });

  it('treats a per-request timeout as busy', async () => {
    const timeout = new DOMException('timed out', 'TimeoutError');
    const { ex, calls } = make([timeout, json(200, okBody(JSON.stringify(OUTPUT)))]);
    await ex.extract(req);
    expect(calls).toHaveLength(2);
  });

  it('falls back after two busy answers and records the model that answered', async () => {
    const { ex, calls } = make([
      err(503, 'busy'),
      err(503, 'busy'),
      json(200, okBody(JSON.stringify(OUTPUT))),
    ]);
    const res = await ex.extract(req);
    expect(calls.map(modelOf)).toEqual(['gemini-3.6-flash', 'gemini-3.6-flash', 'fallback-1']);
    expect(res.raw).toMatchObject({ model: 'fallback-1' });
  });

  it('moves to the fallback immediately on 404', async () => {
    const { ex, calls } = make([err(404, 'gone'), json(200, okBody(JSON.stringify(OUTPUT)))]);
    const res = await ex.extract(req);
    expect(calls.map(modelOf)).toEqual(['gemini-3.6-flash', 'fallback-1']);
    expect(res.raw).toMatchObject({ model: 'fallback-1' });
  });

  it('rejects at once on 401 with the Google message, never leaking the key', async () => {
    const { ex, calls } = make([err(401, 'API key not valid')]);
    const e = await ex.extract(req).catch((x: Error) => x);
    expect((e as Error).message).toBe('Gemini gemini-3.6-flash: HTTP 401: API key not valid');
    expect((e as Error).message).not.toContain(KEY);
    expect(calls).toHaveLength(1);
  });

  it('rejects when every model is busy', async () => {
    const { ex } = make([err(503, 'b'), err(503, 'b'), err(429, 'x'), err(429, 'last one')]);
    await expect(ex.extract(req)).rejects.toThrow(
      /^Gemini: no model answered \(gemini-3\.6-flash, fallback-1\): .*last one/,
    );
  });

  it('rejects an unfinished or empty response as unusable', async () => {
    const { ex } = make([json(200, okBody('{"fields":[', 'MAX_TOKENS'))]);
    await expect(ex.extract(req)).rejects.toThrow(
      /^model response unusable \(finishReason: MAX_TOKENS, blockReason: none\)/,
    );
    const blocked = make([json(200, { promptFeedback: { blockReason: 'SAFETY' } })]);
    await expect(blocked.ex.extract(req)).rejects.toThrow(/blockReason: SAFETY/);
  });

  it('rejects non-JSON text', async () => {
    const { ex } = make([json(200, okBody('not json'))]);
    await expect(ex.extract(req)).rejects.toThrow('model response unusable (invalid JSON)');
  });

  it('stops without retry or fallback when the caller aborts', async () => {
    const ctrl = new AbortController();
    const { ex, calls } = make([
      (c) =>
        new Promise<Response>((_, reject) => {
          const s = c.init.signal as AbortSignal;
          s.addEventListener('abort', () => reject(s.reason));
          setTimeout(() => ctrl.abort(), 5);
        }),
    ]);
    await expect(ex.extract(req, { signal: ctrl.signal })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
  });

  it('countTokens estimates locally without any fetch', async () => {
    const { ex, calls } = make([]);
    expect(await ex.countTokens('abcdefgh')).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
