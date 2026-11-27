import { describe, expect, it } from 'vitest';
import { joinPages, pageOf } from './pages.js';

describe('joinPages', () => {
  it('joins with a blank line and records page starts', () => {
    expect(joinPages(['a', 'bb'])).toEqual({ text: 'a\n\nbb', pageOffsets: [0, 3] });
  });

  it('returns no offsets for no pages', () => {
    expect(joinPages([])).toEqual({ text: '', pageOffsets: [] });
  });
});

describe('pageOf', () => {
  it('maps an offset to its 1-based page', () => {
    expect(pageOf(0, [0, 3])).toBe(1);
    expect(pageOf(2, [0, 3])).toBe(1);
    expect(pageOf(3, [0, 3])).toBe(2);
    expect(pageOf(4, [0, 3])).toBe(2);
  });

  it('skips an empty page', () => {
    const { text, pageOffsets } = joinPages(['a', '', 'c']);
    expect(pageOf(text.indexOf('c'), pageOffsets)).toBe(3);
  });

  it('picks the later page when consecutive offsets are equal', () => {
    expect(pageOf(3, [0, 3, 3, 7])).toBe(3);
    expect(pageOf(6, [0, 3, 3, 7])).toBe(3);
  });

  it('returns page 1 for a document without offsets', () => {
    expect(pageOf(10, [])).toBe(1);
  });
});
