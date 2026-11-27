import type { FieldType } from '@lomi/shared';
import { findQuote } from './text.js';
import { normalizeValue } from './values.js';

/**
 * Decides whether a field's review can carry over from a previous document version to a new one.
 *
 * "Unchanged" means all of: both sides are real values (gaps never carry), their normalized values
 * are equal, and the previous version's evidence quote still appears in the new version's text.
 * Offsets and pages are deliberately not compared: a quote that merely moved is still the same fact,
 * while a same-valued quote that vanished means the reviewer's evidence no longer backs the value.
 *
 * Comparing normalized values (not raw strings) keeps `$5,230.29` and `5230.29` equal, so
 * formatting-only differences between model runs do not discard a review. A next value that
 * does not parse as the type is treated as changed, never as equal.
 */
export function isUnchanged(
  prev: { value: string | null; evidence: string | null },
  next: { value: string | null },
  newText: string,
  type: FieldType,
): boolean {
  if (prev.value === null || prev.evidence === null || next.value === null) return false;
  const a = normalizeValue(prev.value, type);
  const b = normalizeValue(next.value, type);
  if (a === null || b === null || a !== b) return false;
  return findQuote(prev.evidence, newText) !== null;
}
