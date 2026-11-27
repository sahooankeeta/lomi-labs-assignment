import { describe, expect, it } from 'vitest';
import { findQuote, normalizeForMatch } from './text.js';

function slice(haystack: string, quote: string): string | null {
  const hit = findQuote(quote, haystack);
  return hit ? haystack.slice(hit.start, hit.end) : null;
}

describe('findQuote', () => {
  it('matches across collapsed whitespace and returns original offsets', () => {
    const doc = 'Subtotal: $5,000.00\nTotal Due:   $5,230.29\n';
    expect(slice(doc, 'Total Due: $5,230.29')).toBe('Total Due:   $5,230.29');
  });

  it('treats curly and straight quotes as equal', () => {
    const doc = 'between Harborview Residential LP (“Landlord”) and Dana Okafor';
    expect(slice(doc, 'Harborview Residential LP ("Landlord")')).toBe(
      'Harborview Residential LP (“Landlord”)',
    );
  });

  it('matches a quote spanning a line break', () => {
    const doc = 'for a term of twenty-four (24)\nmonths commencing';
    expect(slice(doc, 'twenty-four (24) months')).toBe('twenty-four (24)\nmonths');
  });

  it('treats dash variants as equal', () => {
    expect(slice('Period: Jan – Mar', 'Jan - Mar')).toBe('Jan – Mar');
  });

  it('rejects a hallucinated quote', () => {
    expect(findQuote('Total Due: $5,300.00', 'Total Due: $5,230.29')).toBeNull();
  });

  it('rejects an empty or whitespace quote', () => {
    expect(findQuote('   ', 'anything')).toBeNull();
    expect(findQuote('', 'anything')).toBeNull();
  });

  it('returns the first occurrence', () => {
    const doc = 'Rate: 4.2%. Later: Rate: 4.2%.';
    expect(findQuote('Rate: 4.2%', doc)).toEqual({ start: 0, end: 10 });
  });

  it('maps offsets correctly when NFKC changes length before the match', () => {
    // 'ﬁ' (U+FB01) normalizes to 'fi': two normalized chars from one original.
    const doc = 'ﬁle no. Total Due: $1';
    expect(slice(doc, 'Total Due: $1')).toBe('Total Due: $1');
  });
});

describe('normalizeForMatch', () => {
  it('collapses whitespace, trims, and keeps a map to original indices', () => {
    const { text, map } = normalizeForMatch('  a \n b ');
    expect(text).toBe('a b');
    expect(map).toEqual([2, 3, 6, 7]);
  });
});
