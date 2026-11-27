/**
 * Live check of a Google Gemini API key, before Gemini is wired in as an extractor.
 * Run: pnpm --filter @lomi/worker smoke:gemini   (needs GEMINI_API_KEY in .env)
 *
 * 1. Lists the models the key can call (proves the key works).
 * 2. Counts tokens for invoice v1 (fixtures/documents/invoice-001.pdf).
 * 3. Runs one structured-output extraction with the same prompt the worker uses
 *    (`buildPrompt`) and prints the candidates after the same strict evidence check
 *    (`validateChunkOutput`): a value only survives if its quote is really in the PDF.
 *
 * Uses the REST API through fetch, so it adds no dependency. The key goes in the
 * `x-goog-api-key` header (never in the URL, so it can't leak into logs) and is never printed.
 * Optional: GEMINI_MODEL to pick a model; otherwise it tries every `gemini-X.Y-flash` the
 * key lists, newest first, then the `gemini-flash-latest` alias. A busy model (503/429) is
 * retried once, then the next one is tried.
 * Not part of the build (tsconfig.build.json only compiles src/).
 */
import { readFile } from 'node:fs/promises';
import { buildPrompt, joinPages, PROMPT_VERSION, validateChunkOutput } from '@lomi/extraction';
import type { FieldDef } from '@lomi/shared';
import { extractText, getDocumentProxy } from 'unpdf';

const API = 'https://generativelanguage.googleapis.com/v1beta';
// Google's moving alias for its current flash model; used if no versioned flash model is listed.
const FALLBACK_MODEL = 'gemini-flash-latest';

const FIELDS: FieldDef[] = [
  { field: 'invoice_number', type: 'string' },
  { field: 'issue_date', type: 'date' },
  { field: 'due_date', type: 'date' },
  { field: 'vendor_name', type: 'string' },
  { field: 'total_amount', type: 'money' },
];

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

/** An HTTP error from the Gemini API; `busy` marks the temporary ones worth retrying. */
class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
  get busy(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gemini<T>(apiKey: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) {
    // Google's error message says what's wrong (invalid key, quota, unknown model).
    throw new GeminiError(
      `${path.split('?')[0]} → HTTP ${res.status}: ${json.error?.message ?? res.statusText}`,
      res.status,
    );
  }
  return json as T;
}

interface ModelList {
  models?: { name: string; supportedGenerationMethods?: string[] }[];
}

/** Models to try, in order: just GEMINI_MODEL if set, else every flash model newest first. */
async function modelsToTry(apiKey: string): Promise<string[]> {
  const { models = [] } = await gemini<ModelList>(apiKey, 'models?pageSize=1000');
  const usable = models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
  console.log(`key OK: ${usable.length} models support generateContent`);

  // Plain stable flash models (`gemini-3.8-flash`, not `-lite`/`-preview-tts`/...), newest first.
  // The list still shows retired versions (e.g. 2.5 is refused for new keys), so newest wins.
  const version = (m: string) => Number(/^gemini-(\d+(?:\.\d+)?)-flash$/.exec(m)?.[1] ?? NaN);
  const flash = usable
    .filter((m) => !Number.isNaN(version(m)))
    .sort((a, b) => version(b) - version(a));
  console.log(`  flash models: ${flash.join(', ') || '(none)'}`);

  const wanted = process.env.GEMINI_MODEL?.trim();
  if (wanted) {
    if (!usable.includes(wanted))
      throw new Error(`GEMINI_MODEL=${wanted} is not available to this key`);
    return [wanted];
  }
  const list = usable.includes(FALLBACK_MODEL) ? [...flash, FALLBACK_MODEL] : flash;
  if (list.length === 0)
    throw new Error('no flash model found; set GEMINI_MODEL to one from the list');
  return list;
}

interface GenerateResponse {
  candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set (add it to .env, then re-run)');

  const models = await modelsToTry(apiKey);
  const file = new URL('../../../fixtures/documents/invoice-001.pdf', import.meta.url);
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(file)));
  const { text } = joinPages((await extractText(pdf, { mergePages: false })).text);

  const prompt = buildPrompt('invoice', FIELDS, text, { chunkIndex: 0, chunkCount: 1 });

  // Free-tier models are often briefly overloaded (503), rate-limited (429) or slow (timeout):
  // retry once, then move on to the next model. A 404 (model retired for this key) skips
  // straight to the next one. Any other error (bad key, bad request) stops at once.
  let res: GenerateResponse | undefined;
  let started = 0;
  for (const model of models) {
    console.log(`model: ${model}, prompt ${PROMPT_VERSION}`);
    for (let attempt = 1; attempt <= 2 && !res; attempt++) {
      try {
        const { totalTokens } = await gemini<{ totalTokens: number }>(
          apiKey,
          `models/${model}:countTokens`,
          { contents: [{ role: 'user', parts: [{ text }] }] },
        );
        if (attempt === 1) console.log(`countTokens: ${totalTokens}`);
        started = Date.now();
        res = await gemini<GenerateResponse>(apiKey, `models/${model}:generateContent`, {
          systemInstruction: { parts: [{ text: prompt.system }] },
          contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
          },
        });
      } catch (err) {
        if (err instanceof GeminiError && err.status === 404 && models.length > 1) {
          console.log('  not available to this key, trying next model');
          break;
        }
        const timedOut = err instanceof Error && err.name === 'TimeoutError';
        if (!timedOut && !(err instanceof GeminiError && err.busy)) throw err;
        const why = timedOut ? 'timed out' : `busy (HTTP ${(err as GeminiError).status})`;
        console.log(`  ${why}${attempt === 1 ? ', retrying in 3 s' : ', trying next model'}`);
        if (attempt === 1) await sleep(3_000);
      }
    }
    if (res) break;
  }
  if (!res) throw new Error(`no model answered: ${models.join(', ')}; try again later`);

  const candidate = res.candidates?.[0];
  const raw = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  // Same rule as the Claude extractor: a blocked or truncated answer is an error, not a gap.
  if (!raw || (candidate?.finishReason && candidate.finishReason !== 'STOP')) {
    throw new Error(
      `model response unusable (finishReason: ${candidate?.finishReason ?? 'none'}, ` +
        `blockReason: ${res.promptFeedback?.blockReason ?? 'none'})`,
    );
  }
  const u = res.usageMetadata;
  console.log(
    `generateContent: ${Date.now() - started} ms, tokens in ${u?.promptTokenCount ?? '?'} / out ${u?.candidatesTokenCount ?? '?'}`,
  );

  const output: unknown = JSON.parse(raw);
  const results = validateChunkOutput(output, FIELDS, { text, start: 0 });
  for (const c of results) {
    console.log(
      c.kind === 'value'
        ? `${c.field}: ${c.value}  <- "${c.evidence}"`
        : `${c.field}: GAP (${c.reason})`,
    );
  }
  const kept = results.filter((c) => c.kind === 'value').length;
  console.log(`${kept}/${FIELDS.length} values passed the evidence check`);
}

main().catch((err: unknown) => {
  console.error(`smoke:gemini failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
