import type { ExpectedFields } from '@lomi/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createDocumentWithV1, getDocumentDetail, retryCurrentVersion } from './documents.js';
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
const input = { type: 'invoice' as const, title: 'Inv', fileKey: 'a.pdf', sha256: 'a' };

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

describe('createDocumentWithV1', () => {
  it('creates a document with a queued v1 as current version', async () => {
    const r = await createDocumentWithV1(db, input);
    expect(r.created).toBe(true);
    expect(r.attempts).toBe(0);
    const doc = await db.document.findUniqueOrThrow({
      where: { id: r.documentId },
      include: { versions: true },
    });
    expect(doc.currentVersionId).toBe(r.versionId);
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0]).toMatchObject({ status: 'queued', versionNo: 1 });
  });

  it('returns the existing ids for the same type and sha', async () => {
    const a = await createDocumentWithV1(db, input);
    const b = await createDocumentWithV1(db, { ...input, title: 'Other' });
    expect(b).toMatchObject({ created: false, documentId: a.documentId, versionId: a.versionId });
    expect(await db.document.count()).toBe(1);
  });

  it('creates a new document for the same sha under a different type', async () => {
    const a = await createDocumentWithV1(db, input);
    const b = await createDocumentWithV1(db, { ...input, type: 'lease' });
    expect(b.created).toBe(true);
    expect(b.documentId).not.toBe(a.documentId);
  });

  it('concurrent identical creates produce exactly one document', async () => {
    const results = await Promise.all([
      createDocumentWithV1(db, input),
      createDocumentWithV1(db, input),
    ]);
    expect(await db.document.count()).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0]!.documentId).toBe(results[1]!.documentId);
  });
});

describe('getDocumentDetail', () => {
  it('shows a fresh document as queued with no values', async () => {
    const r = await createDocumentWithV1(db, input);
    const d = await getDocumentDetail(db, r.documentId, { fields });
    expect(d).toMatchObject({
      id: r.documentId,
      title: 'Inv',
      type: 'invoice',
      status: 'queued',
      values: [],
    });
    expect(d!.version).toMatchObject({ id: r.versionId, versionNo: 1, status: 'queued' });
  });

  it('orders values by field order and derives review state', async () => {
    const r = await createDocumentWithV1(db, input);
    const mk = (field: string, value: string) =>
      db.extractedValue.create({ data: { versionId: r.versionId, field, value, evidence: value } });
    const due = await mk('due_date', '2026-01-01');
    const total = await mk('total', '10');
    const vendor = await mk('vendor', 'Acme');
    await db.review.create({ data: { valueId: vendor.id, action: 'approve' } });
    await db.review.create({ data: { valueId: total.id, action: 'approve' } });
    await db.review.create({
      data: {
        valueId: total.id,
        action: 'correct',
        correctedValue: '11',
        createdAt: new Date(Date.now() + 1000),
      },
    });
    const d = await getDocumentDetail(db, r.documentId, { fields });
    expect(d!.values.map((v) => [v.field, v.fieldType, v.reviewState])).toEqual([
      ['vendor', 'string', 'approved'],
      ['total', 'money', 'corrected'],
      ['due_date', 'date', 'pending'],
    ]);
    expect(d!.values[1]!.latestReview).toMatchObject({ action: 'correct', correctedValue: '11' });
    expect(d!.values[2]!.id).toBe(due.id);
    expect(d!.progress).toEqual({
      pending: 1,
      approved: 1,
      corrected: 1,
      carried_over: 0,
      gaps: 0,
      total: 3,
    });
  });

  it('reports carried_over when a carried review is set and no own review exists', async () => {
    const r = await createDocumentWithV1(db, input);
    const old = await db.extractedValue.create({
      data: { versionId: r.versionId, field: 'vendor', value: 'A', evidence: 'A' },
    });
    const rev = await db.review.create({ data: { valueId: old.id, action: 'approve' } });
    const v2 = await db.documentVersion.create({
      data: {
        documentId: r.documentId,
        versionNo: 2,
        fileKey: 'b.pdf',
        sha256: 'b',
        status: 'extracted',
      },
    });
    await db.extractedValue.create({
      data: {
        versionId: v2.id,
        field: 'vendor',
        value: 'A',
        evidence: 'A',
        previousValueId: old.id,
        carriedReviewId: rev.id,
      },
    });
    await db.documentVersion.update({ where: { id: r.versionId }, data: { status: 'superseded' } });
    await db.document.update({ where: { id: r.documentId }, data: { currentVersionId: v2.id } });
    const cur = await getDocumentDetail(db, r.documentId, { fields });
    expect(cur!.version.versionNo).toBe(2);
    expect(cur!.status).toBe('extracted');
    expect(cur!.values[0]!.reviewState).toBe('carried_over');
    const old1 = await getDocumentDetail(db, r.documentId, { fields, versionNo: 1 });
    expect(old1!.status).toBe('superseded');
  });

  it('returns null for unknown document or absent version', async () => {
    const r = await createDocumentWithV1(db, input);
    expect(
      await getDocumentDetail(db, '00000000-0000-4000-8000-000000000000', { fields }),
    ).toBeNull();
    expect(await getDocumentDetail(db, r.documentId, { fields, versionNo: 2 })).toBeNull();
  });
});

describe('retryCurrentVersion', () => {
  it('refuses a non-failed version', async () => {
    const r = await createDocumentWithV1(db, input);
    expect(await retryCurrentVersion(db, r.documentId)).toEqual({
      kind: 'not_failed',
      status: 'queued',
    });
  });

  it('returns not_found for an unknown document', async () => {
    expect(await retryCurrentVersion(db, '00000000-0000-4000-8000-000000000000')).toEqual({
      kind: 'not_found',
    });
  });

  it('requeues a failed version', async () => {
    const r = await createDocumentWithV1(db, input);
    await db.documentVersion.update({
      where: { id: r.versionId },
      data: {
        status: 'failed',
        error: 'boom',
        attempts: 3,
        activeRunId: '00000000-0000-4000-8000-000000000001',
        leaseExpiresAt: new Date(),
      },
    });
    expect(await retryCurrentVersion(db, r.documentId)).toEqual({
      kind: 'retried',
      versionId: r.versionId,
      attempts: 0,
    });
    const v = await db.documentVersion.findUniqueOrThrow({ where: { id: r.versionId } });
    expect(v).toMatchObject({
      status: 'queued',
      attempts: 0,
      error: null,
      activeRunId: null,
      leaseExpiresAt: null,
    });
  });
});
