/**
 * Live check of a Google Gemini API key and of `GeminiExtractor` (the worker's EXTRACTOR=gemini).
 * Run: pnpm --filter @lomi/worker smoke:gemini   (needs GEMINI_API_KEY in .env)
 *
 * 1. Lists the models the key can call (proves the key works).
 * 2. Counts tokens for invoice v1 (fixtures/documents/invoice-001.pdf), locally like the worker.
 * 3. Runs one structured-output extraction through `GeminiExtractor` with the same prompt the worker uses
 *    (`buildPrompt`) and prints the candidates after the same strict evidence check
 *    (`validateChunkOutput`): a value only survives if its quote is really in the PDF.
 *
 * Uses the REST API through fetch, so it adds no dependency. The key goes in the
 * `x-goog-api-key` header (never in the URL, so it can't leak into logs) and is never printed.
 * The extraction itself (retry, fallback to the next listed model) is `GeminiExtractor`; this script
 * only lists models and picks the order.
 * Optional: GEMINI_MODEL to pick a model; otherwise it tries every `gemini-X.Y-flash` the
 * key lists, newest first, then the `gemini-flash-latest` alias; the first is the primary model and
 * the rest are its fallbacks.
 * Not part of the build (tsconfig.build.json only compiles src/).
 */
import { readFile } from 'node:fs/promises';
import { buildPrompt, joinPages, PROMPT_VERSION, validateChunkOutput } from '@lomi/extraction';
import type { FieldDef } from '@lomi/shared';
import { extractText, getDocumentProxy } from 'unpdf';
import { GeminiExtractor } from '../src/extractors/gemini.js';

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

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set (add it to .env, then re-run)');

  const models = await modelsToTry(apiKey);
  const file = new URL('../../../fixtures/documents/invoice-001.pdf', import.meta.url);
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(file)));
  const { text } = joinPages((await extractText(pdf, { mergePages: false })).text);

  const prompt = buildPrompt('invoice', FIELDS, text, { chunkIndex: 0, chunkCount: 1 });

  // The extractor retries a busy model once, then falls back to the next one; a 404 skips
  // straight on; any other error (bad key, bad request) stops at once.
  const [model = FALLBACK_MODEL, ...fallbackModels] = models;
  console.log(`models: ${models.join(' -> ')}, prompt ${PROMPT_VERSION}`);
  const extractor = new GeminiExtractor({ apiKey, model, fallbackModels });
  console.log(`countTokens (local estimate): ${await extractor.countTokens(text)}`);
  const started = Date.now();
  const { output, raw } = await extractor.extract({
    type: 'invoice',
    fields: FIELDS,
    chunkText: text,
    prompt,
  });
  const used = raw as {
    model: string;
    response: { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
  };
  const u = used.response.usageMetadata;
  console.log(
    `generateContent via ${used.model}: ${Date.now() - started} ms, tokens in ${u?.promptTokenCount ?? '?'} / out ${u?.candidatesTokenCount ?? '?'}`,
  );

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
