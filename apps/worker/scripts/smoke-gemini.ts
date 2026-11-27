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
 * Optional: GEMINI_MODEL to pick a model; otherwise `gemini-2.5-flash`, or the first
 * available "flash" model if that one isn't offered to this key.
 * Not part of the build (tsconfig.build.json only compiles src/).
 */
import { readFile } from 'node:fs/promises';
import { buildPrompt, joinPages, PROMPT_VERSION, validateChunkOutput } from '@lomi/extraction';
import type { FieldDef } from '@lomi/shared';
import { extractText, getDocumentProxy } from 'unpdf';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.5-flash';

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
    throw new Error(
      `${path.split('?')[0]} → HTTP ${res.status}: ${json.error?.message ?? res.statusText}`,
    );
  }
  return json as T;
}

interface ModelList {
  models?: { name: string; supportedGenerationMethods?: string[] }[];
}

async function pickModel(apiKey: string): Promise<string> {
  const { models = [] } = await gemini<ModelList>(apiKey, 'models?pageSize=1000');
  const usable = models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
  console.log(`key OK: ${usable.length} models support generateContent`);
  console.log(
    `  e.g. ${usable
      .filter((m) => m.startsWith('gemini'))
      .slice(0, 8)
      .join(', ')}`,
  );

  const wanted = process.env.GEMINI_MODEL?.trim();
  if (wanted) {
    if (!usable.includes(wanted))
      throw new Error(`GEMINI_MODEL=${wanted} is not available to this key`);
    return wanted;
  }
  if (usable.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;
  const flash = usable.find((m) => m.includes('flash') && !/image|tts|live|audio/.test(m));
  if (!flash) throw new Error('no "flash" model available; set GEMINI_MODEL to one listed above');
  return flash;
}

interface GenerateResponse {
  candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set (add it to .env, then re-run)');

  const model = await pickModel(apiKey);
  console.log(`model: ${model}, prompt ${PROMPT_VERSION}`);

  const file = new URL('../../../fixtures/documents/invoice-001.pdf', import.meta.url);
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(file)));
  const { text } = joinPages((await extractText(pdf, { mergePages: false })).text);

  const { totalTokens } = await gemini<{ totalTokens: number }>(
    apiKey,
    `models/${model}:countTokens`,
    { contents: [{ role: 'user', parts: [{ text }] }] },
  );
  console.log(`countTokens: ${totalTokens}`);

  const prompt = buildPrompt('invoice', FIELDS, text, { chunkIndex: 0, chunkCount: 1 });
  const started = Date.now();
  const res = await gemini<GenerateResponse>(apiKey, `models/${model}:generateContent`, {
    systemInstruction: { parts: [{ text: prompt.system }] },
    contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  });

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
