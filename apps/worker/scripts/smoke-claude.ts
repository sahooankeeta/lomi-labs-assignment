/**
 * Live smoke test against the real Claude API (costs a few cents).
 * Run: pnpm --filter @lomi/worker smoke:claude   (needs ANTHROPIC_API_KEY in .env)
 * Parses fixtures/documents/invoice-001.pdf, prints the token count, runs one extraction
 * and prints the candidates after evidence validation. Exits 1 with a message on failure.
 * Not part of the build (tsconfig.build.json only compiles src/).
 */
import { readFile } from 'node:fs/promises';
import { buildPrompt, joinPages, PROMPT_VERSION, validateChunkOutput } from '@lomi/extraction';
import type { FieldDef } from '@lomi/shared';
import { extractText, getDocumentProxy } from 'unpdf';
import { ClaudeExtractor } from '../src/extractors/index.js';

const FIELDS: FieldDef[] = [
  { field: 'invoice_number', type: 'string' },
  { field: 'issue_date', type: 'date' },
  { field: 'due_date', type: 'date' },
  { field: 'vendor_name', type: 'string' },
  { field: 'total_amount', type: 'money' },
];

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set (add it to .env, then re-run)');
  }
  const model = process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-5-5';
  const extractor = new ClaudeExtractor({ apiKey, model });

  const file = new URL('../../../fixtures/documents/invoice-001.pdf', import.meta.url);
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(file)));
  const { text } = joinPages((await extractText(pdf, { mergePages: false })).text);

  console.log(`model: ${model}, prompt ${PROMPT_VERSION}`);
  console.log(`countTokens: ${await extractor.countTokens(text)}`);

  const prompt = buildPrompt('invoice', FIELDS, text, { chunkIndex: 0, chunkCount: 1 });
  const { output } = await extractor.extract({
    type: 'invoice',
    fields: FIELDS,
    chunkText: text,
    prompt,
  });
  for (const c of validateChunkOutput(output, FIELDS, { text, start: 0 })) {
    console.log(
      c.kind === 'value'
        ? `${c.field}: ${c.value}  <- "${c.evidence}"`
        : `${c.field}: GAP (${c.reason})`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(`smoke:claude failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
