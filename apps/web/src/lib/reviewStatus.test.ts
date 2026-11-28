import { describe, expect, it } from 'vitest';
import { reviewStatus, REVIEW_STATUS_LABEL } from './reviewStatus';

describe('reviewStatus', () => {
  it('maps queued to queued', () => {
    expect(reviewStatus('queued', { pending: 3 })).toBe('queued');
  });
  it('maps extracting to extracting', () => {
    expect(reviewStatus('extracting', { pending: 0 })).toBe('extracting');
  });
  it('maps failed to failed', () => {
    expect(reviewStatus('failed', { pending: 0 })).toBe('failed');
  });
  it('maps extracted with pending values to in_review', () => {
    expect(reviewStatus('extracted', { pending: 2 })).toBe('in_review');
  });
  it('maps extracted with nothing pending to approved', () => {
    expect(reviewStatus('extracted', { pending: 0 })).toBe('approved');
  });
  it('returns null for superseded so the caller shows the raw status', () => {
    expect(reviewStatus('superseded', { pending: 0 })).toBeNull();
  });
  it('has a label for every review status', () => {
    expect(REVIEW_STATUS_LABEL).toEqual({
      queued: 'Queued',
      extracting: 'Extracting',
      failed: 'Failed',
      in_review: 'In review',
      approved: 'Approved',
    });
  });
});
