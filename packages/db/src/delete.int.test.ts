import type { ExpectedFields, FieldDef, FinalValue } from '@lomi/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { claimVersion, finishVersion, saveParsedText } from './coordination.js';
import { deleteDocument } from './delete.js';
import { createDocumentWithV1 } from './documents.js';
import { reviewValue } from './reviews.js';
import { TEST_DATABASE_URL, truncateAll } from './testing.js';
import { createVersion } from './versions.js';

/**
 * `deleteDocument` against real rows built through the production path (claim, parse,
 * finish, review, new version), plus the races it must survive: a review, a new-version
 * upload and a worker finish landing at the same moment as the delete.
 */

const FIELDS: FieldDef[] = [
  { field: 'total', type: 'money' },
  { field: 'vendor', type: 'string' },
];
const fields: ExpectedFields = { invoice: FIELDS, lease: [], market_report: [] };
const TEXT = 'Vendor: Acme Corp\nTotal Due: $5,230.29\n';

let db: Db;
let n = 0;
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

function val(field: string, value: string): FinalValue {
  return {
    field,
    value,
    evidence: value,
    gapReason: null,
    candidates: null,
    evidencePage: 1,
    evidenceStart: 0,
    evidenceEnd: 1,
  };
}
const VALUES = [val('total', '$5,230.29'), val('vendor', 'Acme Corp')];

/** Claims a queued version and stores its text; returns the run id. */
async function claim(versionId: string): Promise<string> {
  const c = await claimVersion(db, versionId, { model: 'm' });
  if (c.kind !== 'claimed') throw new Error(`expected claimed, got ${c.kind}`);
  await saveParsedText(db, versionId, c.runId, { parsedText: TEXT, pageOffsets: [0] });
  return c.runId;
}

async function extract(versionId: string): Promise<void> {
  const runId = await claim(versionId);
  expect(await finishVersion(db, versionId, runId, VALUES, { fields: FIELDS })).toBe('finished');
}

async function newDoc(opts: { type?: 'invoice' | 'lease'; fileKey?: string } = {}) {
  n += 1;
  return createDocumentWithV1(db, {
    type: opts.type ?? 'invoice',
    title: `Doc ${n}`,
    fileKey: opts.fileKey ?? `${n}.pdf`,
    sha256: opts.fileKey ?? `sha-${n}`,
  });
}

/** v1 extracted with an approved value, v2 extracted carrying that review, plus chunk rows. */
async function docWithTwoVersions() {
  const d = await newDoc();
  await extract(d.versionId);
  await db.versionChunk.create({
    data: { versionId: d.versionId, chunkIndex: 0, start: 0, end: 10, tokens: 3, firstPage: 1, lastPage: 1 },
  });
  const run = await db.extractionRun.findFirstOrThrow({ where: { versionId: d.versionId } });
  await db.chunkResult.create({
    data: {
      versionId: d.versionId,
      chunkIndex: 0,
      promptVersion: 'p1',
      runId: run.id,
      prompt: 'p',
      rawResponse: {},
      candidates: [],
    },
  });
  const total = await db.extractedValue.findUniqueOrThrow({
    where: { versionId_field: { versionId: d.versionId, field: 'total' } },
  });
  const reviewed = await reviewValue(db, total.id, { action: 'approve' }, { fields });
  expect(reviewed.kind).toBe('reviewed');

  n += 1;
  const v2 = await createVersion(db, d.documentId, { fileKey: `${n}.pdf`, sha256: `sha-${n}` });
  if (v2.kind !== 'created') throw new Error(v2.kind);
  await extract(v2.versionId);
  const carried = await db.extractedValue.findUniqueOrThrow({
    where: { versionId_field: { versionId: v2.versionId, field: 'total' } },
  });
  expect(carried.carriedReviewId).not.toBeNull();
  return { documentId: d.documentId, versionIds: [d.versionId, v2.versionId] };
}

async function rowCounts(documentId: string, versionIds: string[]) {
  const byVersion = { versionId: { in: versionIds } };
  return {
    documents: await db.document.count({ where: { id: documentId } }),
    versions: await db.documentVersion.count({ where: { documentId } }),
    runs: await db.extractionRun.count({ where: byVersion }),
    chunks: await db.versionChunk.count({ where: byVersion }),
    chunkResults: await db.chunkResult.count({ where: byVersion }),
    values: await db.extractedValue.count({ where: byVersion }),
    reviews: await db.review.count({ where: { value: byVersion } }),
  };
}
const NONE = { documents: 0, versions: 0, runs: 0, chunks: 0, chunkResults: 0, values: 0, reviews: 0 };

describe('deleteDocument', () => {
  it('deletes the document, both versions, runs, chunks, chunk results, values and reviews', async () => {
    const d = await docWithTwoVersions();
    expect((await rowCounts(d.documentId, d.versionIds)).reviews).toBe(1);

    const r = await deleteDocument(db, d.documentId);
    expect(r).toMatchObject({ kind: 'deleted', versionCount: 2 });
    expect(await rowCounts(d.documentId, d.versionIds)).toEqual(NONE);
  });

  it('leaves other documents untouched', async () => {
    const keep = await docWithTwoVersions();
    const before = await rowCounts(keep.documentId, keep.versionIds);
    const gone = await docWithTwoVersions();

    await deleteDocument(db, gone.documentId);
    expect(await rowCounts(keep.documentId, keep.versionIds)).toEqual(before);
  });

  it('returns not_found for an unknown id, and on a second delete', async () => {
    expect(await deleteDocument(db, '7b0f6a3e-1c1d-4a55-9c3e-2f1d7f0f6a11')).toEqual({
      kind: 'not_found',
    });
    const d = await newDoc();
    expect((await deleteDocument(db, d.documentId)).kind).toBe('deleted');
    expect(await deleteDocument(db, d.documentId)).toEqual({ kind: 'not_found' });
  });

  it('reports a file key as orphaned only when no other version uses it', async () => {
    const a = await newDoc({ type: 'invoice', fileKey: 'k1.pdf' });
    const b = await newDoc({ type: 'lease', fileKey: 'k1.pdf' });

    expect(await deleteDocument(db, a.documentId)).toMatchObject({ orphanedFileKeys: [] });
    expect(await deleteDocument(db, b.documentId)).toMatchObject({ orphanedFileKeys: ['k1.pdf'] });
  });

  it('a review racing a delete answers not_found, never throws', async () => {
    for (let i = 0; i < 10; i++) {
      const d = await newDoc();
      await extract(d.versionId);
      const v = await db.extractedValue.findFirstOrThrow({ where: { versionId: d.versionId } });
      const [del, rev] = await Promise.all([
        deleteDocument(db, d.documentId),
        reviewValue(db, v.id, { action: 'approve' }, { fields }),
      ]);
      expect(del.kind).toBe('deleted');
      expect(['not_found', 'reviewed']).toContain(rev.kind);
    }
  });

  it('a new version racing a delete never leaves a version without its document', async () => {
    for (let i = 0; i < 10; i++) {
      const d = await newDoc();
      await Promise.all([
        deleteDocument(db, d.documentId),
        createVersion(db, d.documentId, { fileKey: `race-${i}.pdf`, sha256: `race-${i}` }),
      ]);
      expect(await db.documentVersion.count({ where: { documentId: d.documentId } })).toBe(0);
    }
  });

  it('a finish racing a delete never fails with a foreign-key error', async () => {
    for (let i = 0; i < 10; i++) {
      const d = await newDoc();
      const runId = await claim(d.versionId);
      await Promise.all([
        deleteDocument(db, d.documentId),
        finishVersion(db, d.versionId, runId, VALUES, { fields: FIELDS }),
      ]);
      expect(await db.extractedValue.count({ where: { versionId: d.versionId } })).toBe(0);
    }
  });
});
