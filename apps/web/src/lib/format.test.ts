import { describe, expect, it } from 'vitest';
import { progressLabel } from './format';

describe('progressLabel', () => {
  it('lists only non-zero parts in order', () => {
    expect(
      progressLabel({ pending: 3, approved: 2, corrected: 0, carried_over: 0, gaps: 1, total: 5 }),
    ).toBe('3 need review · 2 approved');
    expect(
      progressLabel({ pending: 0, approved: 1, corrected: 2, carried_over: 4, gaps: 0, total: 7 }),
    ).toBe('1 approved · 2 corrected · 4 carried over');
  });
  it('shows a dash when there are no values', () => {
    expect(
      progressLabel({ pending: 0, approved: 0, corrected: 0, carried_over: 0, gaps: 0, total: 0 }),
    ).toBe('—');
  });
});
