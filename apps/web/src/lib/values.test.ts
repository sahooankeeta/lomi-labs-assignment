import type { ValueDto } from '@lomi/shared';
import { describe, expect, it } from 'vitest';
import { effectiveValue, groupValues } from './values';

function v(field: string, over: Partial<ValueDto> = {}): ValueDto {
  return {
    id: field,
    field,
    fieldType: 'string',
    value: field.toUpperCase(),
    evidence: null,
    gapReason: null,
    candidates: null,
    evidencePage: null,
    evidenceStart: null,
    evidenceEnd: null,
    reviewState: 'pending',
    latestReview: null,
    carriedReview: null,
    previous: null,
    earlierCount: 0,
    ...over,
  };
}

describe('groupValues', () => {
  it('splits by review state and keeps field order inside each group', () => {
    const a = v('a', { reviewState: 'approved' });
    const b = v('b', { value: null, gapReason: 'not found' });
    const c = v('c', { reviewState: 'carried_over' });
    const d = v('d');
    expect(groupValues([a, b, c, d])).toEqual({ attention: [b, d], carried: [c], done: [a] });
  });
  it('puts corrected values in done', () => {
    const e = v('e', { reviewState: 'corrected' });
    expect(groupValues([e]).done).toEqual([e]);
  });
});

describe('effectiveValue', () => {
  it('returns the correction, the extracted value, or null for a pending gap', () => {
    const review = {
      id: 'r',
      action: 'correct' as const,
      correctedValue: 'FIXED',
      note: null,
      createdAt: '',
    };
    expect(effectiveValue(v('a', { reviewState: 'corrected', latestReview: review }))).toBe(
      'FIXED',
    );
    expect(effectiveValue(v('b', { reviewState: 'approved' }))).toBe('B');
    expect(effectiveValue(v('c', { value: null }))).toBeNull();
  });
});
