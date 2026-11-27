import { effectiveValue, type ExpectedFields } from '@lomi/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import {
  createDocumentWithV1,
  getDocumentDetail,
  getValueHistory,
  retryCurrentVersion,
} from './documents.js';
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

/**
 * Builds an invoice with a superseded v1 (parsedText `text1`) and an extracted, current v2
 * (parsedText `text2`). Values are added by hand, as the carry-over would write them.
 */
async function twoVersions(text1: string, text2: string) {
  const r = await createDocumentWithV1(db, input);
  await db.documentVersion.update({
    where: { id: r.versionId },
    data: { status: 'superseded', parsedText: text1 },
  });
  const v2 = await db.documentVersion.create({
    data: {
      documentId: r.documentId,
      versionNo: 2,
      fileKey: 'b.pdf',
      sha256: 'b',
      status: 'extracted',
      parsedText: text2,
    },
  });
  await db.document.update({ where: { id: r.documentId }, data: { currentVersionId: v2.id } });
  return { documentId: r.documentId, v1: r.versionId, v2: v2.id };
}

const TOTAL_TEXT = 'Total Due: $5,230.29';

describe('getDocumentDetail previous and carried data', () => {
  it('shows the previous value and its review for a changed value', async () => {
    const t = await twoVersions(TOTAL_TEXT, 'Total Due: $6,126.45');
    const old = await db.extractedValue.create({
      data: { versionId: t.v1, field: 'total', value: '$5,230.29', evidence: TOTAL_TEXT },
    });
    await db.review.create({ data: { valueId: old.id, action: 'approve' } });
    await db.extractedValue.create({
      data: {
        versionId: t.v2,
        field: 'total',
        value: '$6,126.45',
        evidence: 'Total Due: $6,126.45',
        previousValueId: old.id,
      },
    });
    const d = await getDocumentDetail(db, t.documentId, { fields });
    const v = d!.values[0]!;
    expect(v).toMatchObject({ reviewState: 'pending', carriedReview: null });
    expect(v.previous).toMatchObject({
      versionNo: 1,
      value: '$5,230.29',
      effectiveValue: '$5,230.29',
      evidence: TOTAL_TEXT,
      reviewState: 'approved',
      change: 'value',
    });
    expect(v.previous!.review!.action).toBe('approve');
  });

  it('only the quote changed gives change evidence', async () => {
    const t = await twoVersions(TOTAL_TEXT, 'Amount payable 5230.29');
    const old = await db.extractedValue.create({
      data: { versionId: t.v1, field: 'total', value: '$5,230.29', evidence: TOTAL_TEXT },
    });
    await db.extractedValue.create({
      data: {
        versionId: t.v2,
        field: 'total',
        value: '$5,230.29',
        evidence: 'Amount payable 5230.29',
        previousValueId: old.id,
      },
    });
    const d = await getDocumentDetail(db, t.documentId, { fields });
    expect(d!.values[0]!.previous!.change).toBe('evidence');
  });

  it('an unchanged carried value gives change null', async () => {
    const t = await twoVersions(TOTAL_TEXT, `Invoice\n${TOTAL_TEXT}`);
    const old = await db.extractedValue.create({
      data: { versionId: t.v1, field: 'total', value: '$5,230.29', evidence: TOTAL_TEXT },
    });
    const rev = await db.review.create({ data: { valueId: old.id, action: 'approve' } });
    await db.extractedValue.create({
      data: {
        versionId: t.v2,
        field: 'total',
        value: '$5,230.29',
        evidence: TOTAL_TEXT,
        previousValueId: old.id,
        carriedReviewId: rev.id,
      },
    });
    const d = await getDocumentDetail(db, t.documentId, { fields });
    expect(d!.values[0]!.previous!.change).toBeNull();
    expect(d!.values[0]!.reviewState).toBe('carried_over');
  });

  it('a gap in both versions gives change gap', async () => {
    const t = await twoVersions('x', 'y');
    const old = await db.extractedValue.create({
      data: { versionId: t.v1, field: 'total', gapReason: 'not found' },
    });
    await db.review.create({ data: { valueId: old.id, action: 'approve' } });
    await db.extractedValue.create({
      data: { versionId: t.v2, field: 'total', gapReason: 'not found', previousValueId: old.id },
    });
    const d = await getDocumentDetail(db, t.documentId, { fields });
    const v = d!.values[0]!;
    expect(v).toMatchObject({ reviewState: 'pending', carriedReview: null });
    expect(v.previous!.change).toBe('gap');
    expect(v.previous!.reviewState).toBe('approved');
  });

  it('a one-sided gap gives change value, in either direction', async () => {
    for (const [oldGap, newGap] of [
      [false, true],
      [true, false],
    ] as const) {
      const t = await twoVersions('x', 'y');
      const old = await db.extractedValue.create({
        data: oldGap
          ? { versionId: t.v1, field: 'total', gapReason: 'not found' }
          : { versionId: t.v1, field: 'total', value: '5', evidence: 'x' },
      });
      await db.extractedValue.create({
        data: {
          versionId: t.v2,
          field: 'total',
          previousValueId: old.id,
          ...(newGap ? { gapReason: 'not found' } : { value: '5', evidence: 'y' }),
        },
      });
      const d = await getDocumentDetail(db, t.documentId, { fields });
      expect(d!.values[0]!.previous!.change).toBe('value');
      await truncateAll(db);
    }
  });

  it('returns the previous review note', async () => {
    const t = await twoVersions(TOTAL_TEXT, 'z');
    const old = await db.extractedValue.create({
      data: { versionId: t.v1, field: 'total', value: '$5,230.29', evidence: TOTAL_TEXT },
    });
    await db.review.create({
      data: { valueId: old.id, action: 'correct', correctedValue: '5000', note: 'per PO' },
    });
    await db.extractedValue.create({
      data: { versionId: t.v2, field: 'total', value: '1', evidence: 'z', previousValueId: old.id },
    });
    const d = await getDocumentDetail(db, t.documentId, { fields });
    expect(d!.values[0]!.previous!.review!.note).toBe('per PO');
    expect(d!.values[0]!.previous!.effectiveValue).toBe('5000');
  });

  it('a carried correction is the effective value', async () => {
    const t = await twoVersions(TOTAL_TEXT, TOTAL_TEXT);
    const old = await db.extractedValue.create({
      data: { versionId: t.v1, field: 'total', value: '$5,230.29', evidence: TOTAL_TEXT },
    });
    const rev = await db.review.create({
      data: { valueId: old.id, action: 'correct', correctedValue: '5000' },
    });
    await db.extractedValue.create({
      data: {
        versionId: t.v2,
        field: 'total',
        value: '$5,230.29',
        evidence: TOTAL_TEXT,
        previousValueId: old.id,
        carriedReviewId: rev.id,
      },
    });
    const d = await getDocumentDetail(db, t.documentId, { fields });
    const v = d!.values[0]!;
    expect(v.reviewState).toBe('carried_over');
    expect(v.carriedReview!.correctedValue).toBe('5000');
    expect(effectiveValue(v)).toBe('5000');
  });

  it('currentVersionNo is the current version even when viewing version 1', async () => {
    const t = await twoVersions('a', 'b');
    const d = await getDocumentDetail(db, t.documentId, { fields, versionNo: 1 });
    expect(d!.version.versionNo).toBe(1);
    expect(d!.currentVersionNo).toBe(2);
  });

  it('values with no previous version have no previous data', async () => {
    const r = await createDocumentWithV1(db, input);
    await db.extractedValue.create({
      data: { versionId: r.versionId, field: 'vendor', value: 'A', evidence: 'A' },
    });
    const d = await getDocumentDetail(db, r.documentId, { fields });
    expect(d!.values[0]).toMatchObject({ previous: null, carriedReview: null, earlierCount: 0 });
    expect(d!.currentVersionNo).toBe(1);
  });

  it('never throws when the shown version has no parsedText', async () => {
    const t = await twoVersions('a', 'b');
    await db.documentVersion.update({ where: { id: t.v2 }, data: { parsedText: null } });
    const old = await db.extractedValue.create({
      data: { versionId: t.v1, field: 'total', value: '1', evidence: '1' },
    });
    await db.extractedValue.create({
      data: { versionId: t.v2, field: 'total', value: '1', evidence: '1', previousValueId: old.id },
    });
    const d = await getDocumentDetail(db, t.documentId, { fields });
    expect(d!.values[0]!.previous!.change).toBe('value');
  });
});

/** v1 -> v2 -> v3 chain for the `vendor` field: v1 approved then corrected, v2 carries it. */
async function threeVersionChain() {
  const t = await twoVersions('a', 'b');
  const v3 = await db.documentVersion.create({
    data: {
      documentId: t.documentId,
      versionNo: 3,
      fileKey: 'c.pdf',
      sha256: 'c',
      status: 'extracted',
      parsedText: 'c',
    },
  });
  await db.documentVersion.update({ where: { id: t.v2 }, data: { status: 'superseded' } });
  await db.document.update({ where: { id: t.documentId }, data: { currentVersionId: v3.id } });
  const a = await db.extractedValue.create({
    data: { versionId: t.v1, field: 'vendor', value: 'A', evidence: 'A' },
  });
  await db.review.create({ data: { valueId: a.id, action: 'approve' } });
  const r2 = await db.review.create({
    data: {
      valueId: a.id,
      action: 'correct',
      correctedValue: 'AA',
      createdAt: new Date(Date.now() + 1000),
    },
  });
  const b = await db.extractedValue.create({
    data: {
      versionId: t.v2,
      field: 'vendor',
      value: 'A',
      evidence: 'A',
      previousValueId: a.id,
      carriedReviewId: r2.id,
    },
  });
  const c = await db.extractedValue.create({
    data: { versionId: v3.id, field: 'vendor', value: 'C', evidence: 'C', previousValueId: b.id },
  });
  return { documentId: t.documentId, a, b, c, r2 };
}

describe('earlierCount and getValueHistory', () => {
  it('earlierCount follows the chain', async () => {
    const t = await threeVersionChain();
    const cur = await getDocumentDetail(db, t.documentId, { fields });
    expect(cur!.values[0]!.earlierCount).toBe(2);
    const v2 = await getDocumentDetail(db, t.documentId, { fields, versionNo: 2 });
    expect(v2!.values[0]!.earlierCount).toBe(1);
    const v1 = await getDocumentDetail(db, t.documentId, { fields, versionNo: 1 });
    expect(v1!.values[0]!.earlierCount).toBe(0);
  });

  it('getValueHistory returns the chain newest first with every review', async () => {
    const t = await threeVersionChain();
    const h = await getValueHistory(db, t.c.id);
    expect(h!.field).toBe('vendor');
    expect(h!.entries.map((e) => e.versionNo)).toEqual([3, 2, 1]);
    expect(h!.entries[2]!.reviews.map((r) => r.action)).toEqual(['approve', 'correct']);
    expect(h!.entries[1]!.carriedReview!.id).toBe(t.r2.id);
    expect(h!.entries[1]!.reviewState).toBe('carried_over');
    expect(h!.entries[0]!.reviewState).toBe('pending');
    const fromV2 = await getValueHistory(db, t.b.id);
    expect(fromV2!.entries.map((e) => e.versionNo)).toEqual([2, 1]);
  });

  it('returns null for an unknown value', async () => {
    expect(await getValueHistory(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
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
