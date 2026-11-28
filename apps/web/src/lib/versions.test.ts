import { describe, expect, it } from 'vitest';
import { deleteSummary, versionOptions, versionPage } from './versions';

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

describe('versionPage', () => {
  // 12 versions, deliberately out of order: the helper sorts newest first itself.
  const twelve = Array.from({ length: 12 }, (_, i) => ({ versionNo: ((i * 5) % 12) + 1 }));
  const nos = (r: { items: { versionNo: number }[] }) => r.items.map((v) => v.versionNo);

  it('null page shows the page holding the newest shown version', () => {
    const r = versionPage(twelve, 12, null, 6);
    expect(r.page).toBe(0);
    expect(r.pageCount).toBe(2);
    expect(nos(r)).toEqual([12, 11, 10, 9, 8, 7]);
  });

  it('null page follows an older shown version to page 1', () => {
    const r = versionPage(twelve, 3, null, 6);
    expect(r.page).toBe(1);
    expect(nos(r)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('clamps an explicit page beyond the range', () => {
    expect(versionPage(twelve, 12, 9, 6).page).toBe(1);
    expect(versionPage(twelve, 12, -3, 6).page).toBe(0);
  });

  it('empty list has one empty page', () => {
    expect(versionPage([], 1, null, 6)).toEqual({ items: [], page: 0, pageCount: 1 });
  });

  it('a shown version not in the list falls back to page 0', () => {
    expect(versionPage(twelve, 99, null, 6).page).toBe(0);
  });
});
