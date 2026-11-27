/**
 * Verbatim-evidence matching. Quotes and document text are normalized the same way
 * (NFKC, typographic quotes/dashes folded, whitespace runs collapsed) and every
 * normalized char keeps the span of the original char it came from, so a match can be
 * reported as offsets into the ORIGINAL text.
 */

const SINGLE_QUOTES = /[‘’‚‛]/u;
const DOUBLE_QUOTES = /[“”„‟]/u;
const DASHES = /[‐‑‒–—―]/u;
const WHITESPACE = /\s/u; // includes NBSP and other Unicode spaces

interface Normalized {
  text: string;
  starts: number[]; // original start index of normalized char i
  ends: number[]; // original end index (exclusive) of normalized char i
}

function foldChar(ch: string): string {
  if (SINGLE_QUOTES.test(ch)) return "'";
  if (DOUBLE_QUOTES.test(ch)) return '"';
  if (DASHES.test(ch)) return '-';
  if (WHITESPACE.test(ch)) return ' ';
  return ch;
}

function normalize(input: string): Normalized {
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const cp of input) {
    const start = i;
    i += cp.length;
    // NFKC per code point, so each output char traces back to exactly one source span.
    for (const raw of cp.normalize('NFKC')) {
      const ch = foldChar(raw);
      if (ch === ' ' && (out.length === 0 || out[out.length - 1] === ' ')) continue;
      out.push(ch);
      starts.push(start);
      ends.push(i);
    }
  }
  if (out[out.length - 1] === ' ') {
    out.pop();
    starts.pop();
    ends.pop();
  }
  return { text: out.join(''), starts, ends };
}

/**
 * `map[i]` is the index in the original string of normalized char `i`;
 * `map[text.length]` is the original end of the last kept char.
 */
export function normalizeForMatch(text: string): { text: string; map: number[] } {
  const n = normalize(text);
  const end = n.ends.length > 0 ? n.ends[n.ends.length - 1]! : 0;
  return { text: n.text, map: [...n.starts, end] };
}

/** First occurrence of `quote` in `haystack`, as offsets into the original haystack. */
export function findQuote(quote: string, haystack: string): { start: number; end: number } | null {
  const q = normalize(quote).text;
  if (q.length === 0) return null;
  const h = normalize(haystack);
  const at = h.text.indexOf(q);
  if (at < 0) return null;
  return { start: h.starts[at]!, end: h.ends[at + q.length - 1]! };
}
