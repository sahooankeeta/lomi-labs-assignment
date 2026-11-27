import type { PreviousValueDto, ReviewDto, ValueDto } from '@lomi/shared';
import { describe, expect, it } from 'vitest';
import { effectiveValue, groupValues, previousLabel } from './values';

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

const approve: ReviewDto = { id: 'r1', action: 'approve', correctedValue: null, note: null, createdAt: '' };
const correct = (value: string): ReviewDto => ({
  id: 'r2',
  action: 'correct',
  correctedValue: value,
  note: null,
  createdAt: '',
});

function prev(over: Partial<PreviousValueDto> = {}): PreviousValueDto {
  return {
    id: 'p',
    versionNo: 1,
    value: '$5,230.29',
    effectiveValue: '$5,230.29',
    evidence: 'Total $5,230.29',
    evidencePage: 1,
    reviewState: 'pending',
    review: null,
    change: 'value',
    ...over,
  };
}

describe('previousLabel', () => {
  it('is null without a previous value', () => {
    expect(previousLabel(v('a'))).toBeNull();
  });
  it('names the previous value and its effective review when the value changed', () => {
    const label = (review: ReviewDto | null) =>
      previousLabel(v('a', { previous: prev({ review }) }));
    expect(label(approve)).toBe('was $5,230.29 in v1 (approved)');
    expect(label(correct('X'))).toBe('was $5,230.29 in v1 (corrected)');
    expect(label(null)).toBe('was $5,230.29 in v1 (not reviewed)');
  });
  it('describes a previous gap', () => {
    const gap = { value: null, effectiveValue: null, evidence: null, evidencePage: null };
    expect(previousLabel(v('a', { previous: prev({ ...gap }) }))).toBe(
      'was a gap in v1 (not reviewed)',
    );
    // On a gap an approve means "confirmed absent", never "approved".
    expect(previousLabel(v('a', { previous: prev({ ...gap, review: approve }) }))).toBe(
      'was a gap in v1 (confirmed absent)',
    );
  });
  it('describes a gap that stays a gap', () => {
    const gap = { value: null, effectiveValue: null, change: 'gap' as const };
    expect(previousLabel(v('a', { previous: prev({ ...gap, review: approve }) }))).toBe(
      'also a gap in v1 (confirmed absent)',
    );
    expect(
      previousLabel(
        v('a', { previous: prev({ ...gap, effectiveValue: '52000', review: correct('52000') }) }),
      ),
    ).toBe('also a gap in v1, corrected to 52000');
    expect(previousLabel(v('a', { previous: prev({ ...gap }) }))).toBe(
      'also a gap in v1 (not reviewed)',
    );
  });
  it('says when only the quote changed', () => {
    expect(
      previousLabel(v('a', { previous: prev({ change: 'evidence', review: approve }) })),
    ).toBe('same value as v1 (approved), but its quote changed');
  });
  it('labels unchanged values by whether a review was carried', () => {
    expect(
      previousLabel(
        v('a', {
          previous: prev({ change: null, reviewState: 'corrected', review: correct('X') }),
          carriedReview: correct('X'),
        }),
      ),
    ).toBe('carried over from v1 (corrected)');
    expect(previousLabel(v('a', { previous: prev({ change: null }) }))).toBe(
      'unchanged from v1 (not reviewed there)',
    );
  });
  it('names the previous review, not its state, for a value v1 itself carried', () => {
    expect(
      previousLabel(
        v('a', {
          previous: prev({ versionNo: 2, change: null, reviewState: 'carried_over', review: approve }),
          carriedReview: approve,
        }),
      ),
    ).toBe('carried over from v2 (approved)');
  });
});
