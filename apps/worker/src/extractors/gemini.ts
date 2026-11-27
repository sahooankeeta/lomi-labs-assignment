import { createLimiter, type Limiter } from '../limit.js';
import type { ExtractRequest, Extractor } from './types.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_INFLIGHT = 4;
const DEFAULT_RETRY_DELAY_MS = 2_000;

/** Gemini's OpenAPI-style schema for the same shape as `ExtractionOutput`. */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    fields: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          field: { type: 'STRING' },
          value: { type: 'STRING', nullable: true },
          evidence: { type: 'STRING', nullable: true },
          gap_reason: { type: 'STRING', nullable: true },
        },
        required: ['field', 'value', 'evidence', 'gap_reason'],
      },
    },
  },
  required: ['fields'],
};

interface GenerateResponse {
  candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
  promptFeedback?: { blockReason?: string };
}

/** A temporary failure (429, 503, timeout): worth one retry, then the next model. */
class BusyError extends Error {}
/** The model is not available to this key (404): skip to the next model at once. */
class GoneError extends Error {}

/**
 * Extractor backed by the Google Gemini REST API (free tier friendly), selected with
 * `EXTRACTOR=gemini`. Uses `fetch`, so no SDK dependency. The API key travels only in the
 * `x-goog-api-key` header and never appears in URLs or error messages.
 *
 * Guarantees: output is JSON-schema constrained and parsed, but NOT shape-validated here;
 * callers pass it to `validateChunkOutput`. `raw` is `{ model, response }` where `model` is
 * the model that actually answered (it may be a fallback).
 *
 * Failure modes (all reject): caller abort (no retry, no fallback); a non-busy HTTP error
 * (`Gemini <model>: HTTP <status>: <message>`); every model busy or retired
 * (`Gemini: no model answered (...)`); an empty, blocked or truncated answer or invalid JSON
 * (`model response unusable (...)`).
 *
 * Factory env vars: `GEMINI_API_KEY` (required), `GEMINI_MODEL` (default `gemini-3.6-flash`),
 * `GEMINI_FALLBACK_MODELS` (comma separated, default `gemini-flash-lite-latest`),
 * `LLM_MAX_INFLIGHT` (default 4).
 */
export class GeminiExtractor implements Extractor {
  /** The primary model; fallbacks are only tried when it is busy or retired. */
  readonly model: string;
  /** Primary model followed by the fallbacks, in the order they are tried. */
  readonly models: string[];
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly limiter: Limiter;

  /**
   * @param opts.fallbackModels tried in order when the primary is busy (429/503/timeout twice) or retired (404).
   * @param opts.timeoutMs per HTTP request (default 60000); a timeout counts as "busy".
   * @param opts.maxInflight max concurrent extractions (default 4).
   * @param opts.fetch injectable for tests; defaults to global fetch.
   * @param opts.retryDelayMs wait before the single retry on the same model (default 2000).
   */
  constructor(opts: {
    apiKey: string;
    model: string;
    fallbackModels?: string[];
    timeoutMs?: number;
    maxInflight?: number;
    fetch?: typeof fetch;
    retryDelayMs?: number;
  }) {
    this.model = opts.model;
    this.models = [opts.model, ...(opts.fallbackModels ?? []).filter((m) => m !== opts.model)];
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.limiter = createLimiter(opts.maxInflight ?? DEFAULT_MAX_INFLIGHT);
  }

  /**
   * Local estimate `ceil(length / 4)`; makes no API call. Why: the free tier is rate
   * limited, and the token count only sizes chunks, where a rough figure is enough.
   */
  countTokens(text: string): Promise<number> {
    return Promise.resolve(Math.ceil(text.length / 4));
  }

  /**
   * Tries each model in order. Busy (429, 503, timeout): one retry after `retryDelayMs`,
   * then the next model. 404: next model at once. Other HTTP errors reject immediately.
   * An abort of `opts.signal` rejects immediately: aborting means the caller gave up, so
   * retrying or falling back would only waste quota.
   */
  extract(
    req: ExtractRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<{ output: unknown; raw: unknown }> {
    // The whole retry loop (including backoff sleeps) holds one limiter slot. Chosen over
    // releasing during backoff because a busy model means the API is struggling: keeping
    // the slot held also throttles new work instead of piling more calls onto it.
    return this.limiter.run(async () => {
      const signal = opts?.signal;
      let lastError = 'no attempt made';
      for (const model of this.models) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          signal?.throwIfAborted();
          try {
            const response = await this.generate(model, req, signal);
            return { output: parseResponse(response), raw: { model, response } };
          } catch (err) {
            if (signal?.aborted) throw signal.reason ?? err;
            if (err instanceof GoneError) {
              lastError = err.message;
              break;
            }
            if (!(err instanceof BusyError)) throw err;
            lastError = err.message;
            if (attempt === 1) await sleep(this.retryDelayMs, signal);
          }
        }
      }
      throw new Error(`Gemini: no model answered (${this.models.join(', ')}): ${lastError}`);
    });
  }

  /** One HTTP call, aborted by the caller's signal or this request's own timeout. */
  private async generate(
    model: string,
    req: ExtractRequest,
    callerSignal?: AbortSignal,
  ): Promise<GenerateResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchFn(`${API}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.prompt.system }] },
          contents: [{ role: 'user', parts: [{ text: req.prompt.user }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
          },
        }),
        signal,
      });
    } catch (err) {
      // The caller's abort is handled by the caller of this method; our own timeout is "busy".
      if (!callerSignal?.aborted && (timeout.aborted || (err as Error)?.name === 'TimeoutError')) {
        throw new BusyError(`${model}: timed out after ${this.timeoutMs} ms`);
      }
      throw err;
    }
    const body = (await res.json().catch(() => ({}))) as GenerateResponse & {
      error?: { message?: string };
    };
    if (res.ok) return body;
    const message = `Gemini ${model}: HTTP ${res.status}: ${body.error?.message ?? res.statusText}`;
    if (res.status === 429 || res.status === 503) throw new BusyError(message);
    if (res.status === 404) throw new GoneError(message);
    throw new Error(message);
  }
}

/** Extracts the JSON the model produced; throws `model response unusable (...)` otherwise. */
function parseResponse(res: GenerateResponse): unknown {
  const candidate = res.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text || (candidate?.finishReason && candidate.finishReason !== 'STOP')) {
    throw new Error(
      `model response unusable (finishReason: ${candidate?.finishReason ?? 'none'}, ` +
        `blockReason: ${res.promptFeedback?.blockReason ?? 'none'})`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('model response unusable (invalid JSON)');
  }
}

/** Waits `ms`, rejecting early if `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
