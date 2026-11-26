import { describe, expect, it } from 'vitest';
import { extractionJobId } from './index.js';

describe('extractionJobId', () => {
  it('carries the attempt number and has exactly 3 colon-separated parts', () => {
    const id = '0b9f3a52-6a1c-4c53-9a53-5d2d0b6d2f11';
    expect(extractionJobId(id, 2)).toBe(`extract:${id}:2`);
    // BullMQ rejects custom job ids containing ':' unless there are exactly 3 parts.
    expect(extractionJobId(id, 2).split(':')).toHaveLength(3);
  });
});
