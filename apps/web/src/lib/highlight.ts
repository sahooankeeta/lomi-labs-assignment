/**
 * Splits `text` around the `[start, end)` range so the match can be wrapped in a `Mark`.
 * Offsets are clamped to the text; a null or empty range yields no match.
 */
export function highlightSegments(
  text: string,
  start: number | null,
  end: number | null,
): { before: string; match: string; after: string } {
  if (start === null || end === null) return { before: text, match: '', after: '' };
  const s = Math.min(Math.max(start, 0), text.length);
  const e = Math.min(Math.max(end, 0), text.length);
  if (e <= s) return { before: text, match: '', after: '' };
  return { before: text.slice(0, s), match: text.slice(s, e), after: text.slice(e) };
}
