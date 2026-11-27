import type { ExpectedFields } from '@lomi/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createDocumentWithV1 } from './documents.js';
import { getProgress, listDocuments, reviewValue } from './reviews.js';
import { TEST_DATABASE_URL, truncateAll } from './testing.js';

const fields: ExpectedFields = {
  invoice: [
    { field: 'vendor', type: 'string' },
    { field: 'total', type: 'money' },
    { field: 'due_date', type: 'date' },
  ],
  lease: [],
  market_report: [],
};
const opts = { fields };
const zeros = { pending: 0, approved: 0, corrected: 0, carried_over: 0, gaps: 0, total: 0 };

let db: Db;
beforeAll(() => {
  db = createDb(TEST_DATABASE_URL);
});
beforeEach(async () => {
  await truncateAll(db);
});
afterAll(async () => {
  await truncateAll(db);
  await db.$disconnect();
});

/** A document whose current v1 is already `extracted`, with the given values (null = gap). */
async function extractedDoc(vals: Record<string, string | null>, sha = 'a') {
  const r = await createDocumentWithV1(db, {
    type: 'invoice',
    title: `Doc ${sha}`,
    fileKey: `${sha}.pdf`,
    sha256: sha,
  });
  await db.documentVersion.update({ where: { id: r.versionId }, data: { status: 'extracted' } });
  const ids: Record<string, string> = {};
  for (const [field, value] of Object.entries(vals)) {
    const row = await db.extractedValue.create({
      data: {
        versionId: r.versionId,
        field,
        value,
        evidence: value,
        gapReason: value === null ? 'not found' : null,
      },
    });
    ids[field] = row.id;
  }
  return { ...r, ids };
}

describe('reviewValue', () => {
  it('approve appends a row and returns approved with progress', async () => {
    const d = await extractedDoc({ vendor: 'Acme', total: '10' });
    const r = await reviewValue(db, d.ids.vendor!, { action: 'approve' }, opts);
    expect(r.kind).toBe('reviewed');
    if (r.kind !== 'reviewed') return;
    expect(r.result.reviewState).toBe('approved');
    expect(r.result.review).toMatchObject({ action: 'approve', correctedValue: null, note: null });
    expect(r.result.progress).toEqual({ ...zeros, pending: 1, approved: 1, total: 2 });
    expect(await db.review.count()).toBe(1);
  });

  it('correct stores the trimmed value and note; state corrected', async () => {
    const d = await extractedDoc({ total: '10' });
    const r = await reviewValue(
      db,
      d.ids.total!,
      { action: 'correct', value: '  $11.50 ', note: 'typo' },
      opts,
    );
    if (r.kind !== 'reviewed') throw new Error(r.kind);
    expect(r.result.reviewState).toBe('corrected');
    expect(r.result.review).toMatchObject({
      action: 'correct',
      correctedValue: '$11.50',
      note: 'typo',
    });
    expect(r.result.progress.corrected).toBe(1);
  });

  it('double approve keeps two rows and counts the value once', async () => {
    const d = await extractedDoc({ vendor: 'Acme' });
    await reviewValue(db, d.ids.vendor!, { action: 'approve' }, opts);
    const r = await reviewValue(db, d.ids.vendor!, { action: 'approve' }, opts);
    if (r.kind !== 'reviewed') throw new Error(r.kind);
    expect(r.result.progress.approved).toBe(1);
    expect(r.result.progress.total).toBe(1);
    expect(await db.review.count()).toBe(2);
  });

  it('approve on a gap is allowed (confirmed absent)', async () => {
    const d = await extractedDoc({ due_date: null });
    const r = await reviewValue(db, d.ids.due_date!, { action: 'approve' }, opts);
    if (r.kind !== 'reviewed') throw new Error(r.kind);
    expect(r.result.reviewState).toBe('approved');
    expect(r.result.progress).toMatchObject({ approved: 1, gaps: 1, total: 1 });
  });

  it('correct on a gap supplies the value', async () => {
    const d = await extractedDoc({ due_date: null });
    const r = await reviewValue(
      db,
      d.ids.due_date!,
      { action: 'correct', value: '2025-03-01' },
      opts,
    );
    if (r.kind !== 'reviewed') throw new Error(r.kind);
    expect(r.result.reviewState).toBe('corrected');
    expect(r.result.review.correctedValue).toBe('2025-03-01');
  });

  it('rejects a value of a non-current version', async () => {
    const d = await extractedDoc({ vendor: 'Acme' });
    const v2 = await db.documentVersion.create({
      data: {
        documentId: d.documentId,
        versionNo: 2,
        fileKey: 'b.pdf',
        sha256: 'b',
        status: 'extracted',
      },
    });
    await db.document.update({ where: { id: d.documentId }, data: { currentVersionId: v2.id } });
    const r = await reviewValue(db, d.ids.vendor!, { action: 'approve' }, opts);
    expect(r).toEqual({
      kind: 'not_reviewable',
      reason: 'value belongs to version 1, not the current version',
    });
    expect(await db.review.count()).toBe(0);
  });

  it('rejects a value whose version is not extracted', async () => {
    const d = await extractedDoc({ vendor: 'Acme' });
    await db.documentVersion.update({ where: { id: d.versionId }, data: { status: 'queued' } });
    const r = await reviewValue(db, d.ids.vendor!, { action: 'approve' }, opts);
    expect(r).toEqual({ kind: 'not_reviewable', reason: 'version is queued, not extracted' });
    expect(await db.review.count()).toBe(0);
  });

  it('rejects an invalid correction', async () => {
    const d = await extractedDoc({ total: '10', due_date: '2025-01-01' });
    const money = await reviewValue(db, d.ids.total!, { action: 'correct', value: 'abc' }, opts);
    expect(money).toEqual({ kind: 'invalid_value', message: '"abc" is not a valid money' });
    const date = await reviewValue(
      db,
      d.ids.due_date!,
      { action: 'correct', value: '2025-02-30' },
      opts,
    );
    expect(date.kind).toBe('invalid_value');
    expect(await db.review.count()).toBe(0);
  });

  it('not_found for an unknown value id', async () => {
    const r = await reviewValue(
      db,
      '00000000-0000-4000-8000-000000000000',
      { action: 'approve' },
      opts,
    );
    expect(r).toEqual({ kind: 'not_found' });
  });
});

describe('listDocuments / getProgress', () => {
  it('listDocuments orders newest first and carries progress', async () => {
    const a = await extractedDoc({ vendor: 'Acme', total: '10' }, 'a');
    const b = await extractedDoc({ vendor: 'Beta' }, 'b');
    await db.document.update({
      where: { id: a.documentId },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    await reviewValue(db, a.ids.vendor!, { action: 'approve' }, opts);

    const list = await listDocuments(db);
    expect(list.map((d) => d.id)).toEqual([b.documentId, a.documentId]);
    expect(list[1]).toMatchObject({
      title: 'Doc a',
      type: 'invoice',
      versionNo: 1,
      status: 'extracted',
      progress: { ...zeros, pending: 1, approved: 1, total: 2 },
    });
    expect(list[0]!.progress).toEqual({ ...zeros, pending: 1, total: 1 });
    expect(typeof list[0]!.createdAt).toBe('string');
  });

  it('getProgress returns zeros for a queued version and null for an unknown document', async () => {
    const r = await createDocumentWithV1(db, {
      type: 'invoice',
      title: 'Q',
      fileKey: 'q.pdf',
      sha256: 'q',
    });
    expect(await getProgress(db, r.documentId)).toEqual(zeros);
    expect(await getProgress(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
