import { describe, expect, it } from 'vitest';
import { deleteSummary, versionOptions } from './versions';

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

describe('deleteSummary', () => {
  const v = (versionNo: number, status: 'extracted' | 'superseded') => ({
    id: `id${versionNo}`,
    versionNo,
    status,
    error: null,
    createdAt: `2026-01-0${versionNo}T00:00:00.000Z`,
  });

  it('counts and lists versions newest first', () => {
    expect(deleteSummary([v(1, 'superseded'), v(2, 'extracted')], 2)).toMatchObject({
      heading: '2 versions will be deleted:',
      lines: [
        { label: 'v2', status: 'extracted', current: true, createdAt: '2026-01-02T00:00:00.000Z' },
        {
          label: 'v1',
          status: 'superseded',
          current: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('singular for one version', () => {
    expect(deleteSummary([v(1, 'extracted')], 1).heading).toBe('1 version will be deleted:');
  });

  it('empty list', () => {
    expect(deleteSummary([], 1)).toEqual({ heading: 'All versions will be deleted.', lines: [] });
  });
});
