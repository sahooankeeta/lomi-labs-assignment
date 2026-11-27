import { describe, expect, it } from 'vitest';
import { highlightSegments } from './highlight';

describe('highlightSegments', () => {
  it('splits around the range', () => {
    expect(highlightSegments('abcdef', 2, 4)).toEqual({ before: 'ab', match: 'cd', after: 'ef' });
  });
  it('returns everything as before when there is no range', () => {
    expect(highlightSegments('abc', null, null)).toEqual({ before: 'abc', match: '', after: '' });
    expect(highlightSegments('abc', 1, 1)).toEqual({ before: 'abc', match: '', after: '' });
  });
  it('clamps to the text', () => {
    expect(highlightSegments('abc', 1, 99)).toEqual({ before: 'a', match: 'bc', after: '' });
    expect(highlightSegments('abc', 5, 9)).toEqual({ before: 'abc', match: '', after: '' });
  });
});
