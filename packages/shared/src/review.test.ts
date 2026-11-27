import { describe, expect, it } from 'vitest';
import { ReviewInput, computeProgress, deriveReviewState } from './review.js';

describe('deriveReviewState', () => {
  it('maps an approve review to approved', () => {
    expect(deriveReviewState({ latestReviewAction: 'approve', carriedReviewId: null })).toBe(
      'approved',
    );
  });
  it('lets an own review beat a carried one', () => {
    expect(deriveReviewState({ latestReviewAction: 'correct', carriedReviewId: 'r1' })).toBe(
      'corrected',
    );
  });
  it('reports carried_over with only a carried review', () => {
    expect(deriveReviewState({ latestReviewAction: null, carriedReviewId: 'r1' })).toBe(
      'carried_over',
    );
  });
  it('is pending with no review at all', () => {
    expect(deriveReviewState({ latestReviewAction: null, carriedReviewId: null })).toBe('pending');
  });
});

describe('computeProgress', () => {
  it('counts each state and overlapping gaps', () => {
    expect(
      computeProgress([
        { reviewState: 'pending', isGap: true },
        { reviewState: 'approved', isGap: false },
        { reviewState: 'corrected', isGap: false },
        { reviewState: 'carried_over', isGap: false },
        { reviewState: 'approved', isGap: true },
      ]),
    ).toEqual({ pending: 1, approved: 2, corrected: 1, carried_over: 1, gaps: 2, total: 5 });
  });
  it('is all zeros for no values', () => {
    expect(computeProgress([])).toEqual({
      pending: 0,
      approved: 0,
      corrected: 0,
      carried_over: 0,
      gaps: 0,
      total: 0,
    });
  });
});

describe('ReviewInput', () => {
  it('trims the value and drops an empty note', () => {
    const out = ReviewInput.parse({ action: 'correct', value: '  12  ', note: '' });
    expect(out).toEqual({ action: 'correct', value: '12' });
    expect('note' in out).toBe(false);
  });
  it('rejects a blank corrected value', () => {
    expect(() => ReviewInput.parse({ action: 'correct', value: '   ' })).toThrow();
  });
  it('rejects an unknown action', () => {
    expect(() => ReviewInput.parse({ action: 'delete' })).toThrow();
  });
});
