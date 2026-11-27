import type { FieldType } from '@lomi/shared';
import { normalizeForMatch } from './text.js';

/**
 * Per-type value comparison. Values compare by canonical form, so `$1,985.00` and `1985`
 * are the same money value and `March 1, 2025` equals `2025-03-01`.
 *
 * Numeric types (money, number, percent) also accept a value written with surrounding words, because
 * models copy "as written" (`twenty-four (24)`, `24 months`, `USD 1,985.00`). The value's canonical
 * form is its one distinct number; a value with no number, or with two or more different numbers
 * (`24 or 25`), does not parse. Values are stored as returned; only the comparison is lenient.
 */

const NUMERIC = /^(-)?[$€£]?(\d[\d,]*)(?:\.(\d+))?%?$/u;
// A number token inside free text; a leading '-' counts as a sign only after start, space or '('.
const NUMBER_TOKEN = /(?:(?<=^|[\s(])-)?[$€£]?\d[\d,]*(?:\.\d+)?%?/gu;

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const MONTH_NAME =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const ISO_DATE = /(\d{4})-(\d{2})-(\d{2})/gu;
const MDY_DATE = new RegExp(`\\b${MONTH_NAME}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'giu');
const DMY_DATE = new RegExp(`\\b(\\d{1,2})\\s+${MONTH_NAME},?\\s+(\\d{4})\\b`, 'giu');

function canonicalNumber(raw: string): string | null {
  const m = NUMERIC.exec(raw.replace(/\s+/gu, ''));
  if (!m) return null;
  const [, sign, intPart, frac] = m;
  const int = intPart!.replace(/,/gu, '').replace(/^0+(?=\d)/u, '');
  const fraction = (frac ?? '').replace(/0+$/u, '');
  const body = fraction ? `${int}.${fraction}` : int;
  return sign && body !== '0' ? `-${body}` : body;
}

function isoDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

function monthNumber(name: string): number {
  const key = name.toLowerCase().replace(/\.$/u, '');
  return MONTHS[key] ?? MONTHS[key.slice(0, 3)]!;
}

/** Every date found in `text`, as `YYYY-MM-DD`. */
function datesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ISO_DATE)) {
    const d = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) out.push(d);
  }
  for (const m of text.matchAll(MDY_DATE)) {
    const d = isoDate(Number(m[3]), monthNumber(m[1]!), Number(m[2]));
    if (d) out.push(d);
  }
  for (const m of text.matchAll(DMY_DATE)) {
    const d = isoDate(Number(m[3]), monthNumber(m[2]!), Number(m[1]));
    if (d) out.push(d);
  }
  return out;
}

function canonicalDate(raw: string): string | null {
  const trimmed = raw.trim();
  const found = datesIn(trimmed);
  // The whole value must be one date, not a sentence that happens to contain one.
  if (found.length !== 1) return null;
  const rest = trimmed.replace(ISO_DATE, '').replace(MDY_DATE, '').replace(DMY_DATE, '').trim();
  return rest === '' ? found[0]! : null;
}

function canonicalString(raw: string): string {
  return normalizeForMatch(raw).text.toLowerCase();
}

/**
 * Canonical number of a numeric value: the bare number if the whole value is one, otherwise the single
 * distinct number found among its number tokens. `null` for zero or several distinct numbers.
 */
function canonicalNumericValue(raw: string): string | null {
  const bare = canonicalNumber(raw);
  if (bare !== null) return bare;
  const distinct = new Set<string>();
  for (const m of raw.matchAll(NUMBER_TOKEN)) {
    const n = canonicalNumber(m[0]);
    if (n !== null) distinct.add(n);
  }
  return distinct.size === 1 ? [...distinct][0]! : null;
}

/**
 * Canonical form of `value` for its field type; `null` when it doesn't parse. Numeric types may carry
 * words around exactly one number (see the file comment).
 */
export function normalizeValue(value: string, type: FieldType): string | null {
  switch (type) {
    case 'money':
    case 'number':
    case 'percent':
      return canonicalNumericValue(value);
    case 'date':
      return canonicalDate(value);
    case 'string': {
      const s = canonicalString(value);
      return s === '' ? null : s;
    }
  }
}

/**
 * True when `value` (of `type`) is literally stated somewhere in `quote`. For numeric types the value's
 * canonical number must equal some number token in the quote, so words around the number in `value`
 * (`twenty-four (24)`) never count as evidence by themselves: the digits must be in the quote.
 */
export function valueInQuote(value: string, quote: string, type: FieldType): boolean {
  const want = normalizeValue(value, type);
  if (want === null) return false;
  switch (type) {
    case 'money':
    case 'number':
    case 'percent':
      return [...quote.matchAll(NUMBER_TOKEN)].some((m) => canonicalNumber(m[0]) === want);
    case 'date':
      return datesIn(quote).includes(want);
    case 'string':
      return canonicalString(quote).includes(want);
  }
}
