/**
 * Pure extraction logic: no I/O, so it can be unit-tested without Postgres,
 * Redis or an LLM. Prompt building and carry-over matching will live here too.
 */

/** Collapse whitespace so line breaks from PDF parsing don't break matching. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The hallucination check: evidence must appear verbatim (modulo whitespace)
 * in the parsed text of the version being extracted.
 */
export function evidenceAppearsIn(evidence: string, parsedText: string): boolean {
  const needle = normalizeText(evidence);
  return needle.length > 0 && normalizeText(parsedText).includes(needle);
}
