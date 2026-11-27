import { describe, expect, it } from 'vitest';
import { pollInterval } from './poll';

describe('pollInterval', () => {
  it('stops when nothing is in flight', () => {
    expect(pollInterval(['extracted', 'failed'])).toBe(false);
    expect(pollInterval([])).toBe(false);
  });
  it('polls while any version is queued or extracting', () => {
    expect(pollInterval(['extracted', 'queued'])).toBe(2000);
    expect(pollInterval(['extracting'])).toBe(2000);
  });
});
