import { describe, expect, it } from 'vitest';
import { versionOptions } from './versions';

describe('versionOptions', () => {
  it('labels each version with its status and marks the current one', () => {
    expect(
      versionOptions(
        [
          { versionNo: 2, status: 'queued' },
          { versionNo: 1, status: 'superseded' },
        ],
        2,
      ),
    ).toEqual([
      { value: '2', label: 'v2 · queued (current)' },
      { value: '1', label: 'v1 · superseded' },
    ]);
  });
});
