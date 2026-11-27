import { type Candidate, ExtractionOutput, type FieldDef } from '@lomi/shared';
import { findQuote } from './text.js';
import { valueInQuote } from './values.js';

export const NOT_RETURNED = 'not returned by model';
export const EVIDENCE_NOT_FOUND = 'evidence not found in document text';
export const VALUE_NOT_IN_QUOTE = 'value not found in its quote';

/**
 * Strict per-chunk check of one model answer. Returns one candidate per field in `fields`
 * order. The quote is searched inside the chunk the model saw, then shifted by
 * `chunk.start` so offsets index the whole version's text.
 */
export function validateChunkOutput(
  output: unknown,
  fields: FieldDef[],
  chunk: { text: string; start: number },
): Candidate[] {
  const parsed = ExtractionOutput.safeParse(output);
  const answers = new Map<string, ExtractionOutput['fields'][number]>();
  if (parsed.success) {
    for (const entry of parsed.data.fields) {
      if (!answers.has(entry.field)) answers.set(entry.field, entry); // first occurrence wins
    }
  }

  return fields.map(({ field, type }): Candidate => {
    const gap = (reason: string): Candidate => ({ field, kind: 'gap', reason });
    const answer = answers.get(field);
    if (!answer) return gap(NOT_RETURNED);

    const value = answer.value?.trim() ?? '';
    if (value === '') return gap(answer.gap_reason?.trim() || NOT_RETURNED);

    const evidence = answer.evidence ?? '';
    const match = findQuote(evidence, chunk.text);
    if (!match) return gap(EVIDENCE_NOT_FOUND);
    if (!valueInQuote(value, evidence, type)) return gap(VALUE_NOT_IN_QUOTE);

    return {
      field,
      kind: 'value',
      value,
      evidence,
      start: chunk.start + match.start,
      end: chunk.start + match.end,
    };
  });
}
