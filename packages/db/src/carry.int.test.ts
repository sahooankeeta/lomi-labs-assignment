import type { ExpectedFields, FieldDef, FinalValue } from '@lomi/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { claimVersion, finishVersion, saveParsedText } from './coordination.js';
import { createDocumentWithV1, getDocumentDetail } from './documents.js';
import { TEST_DATABASE_URL, truncateAll } from './testing.js';
import { createVersion } from './versions.js';

/**
 * Carry-over inside `finishVersion` (the Carry-over table of the Phase 3 plan). Versions
 * are built through the real claim/parse/finish path so the transaction under test is the
 * one production runs; reviews are written straight through Prisma because the previous
 * version is no longer reviewable through `reviewValue`.
 */

const FIELDS: FieldDef[] = [
  { field: 'total', type: 'money' },
  { field: 'vendor', type: 'string' },
];
const expectedFields: ExpectedFields = { invoice: FIELDS, lease: [], market_report: [] };

const TEXT_V1 = 'Vendor: Acme Corp\nTotal Due: $5,230.29\n';

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

function val(field: string, value: string | null, evidence: string | null = value): FinalValue {
  return {
    field,
    value,
    evidence: value === null ? null : evidence,
    gapReason: value === null ? 'not found' : null,
    candidates: null,
    evidencePage: value === null ? null : 1,
    evidenceStart: value === null ? null : 0,
    evidenceEnd: value === null ? null : 1,
  };
}

/** Claims a queued version, stores its text and finishes it with `values`. */
async function run(
  versionId: string,
  text: string,
  values: FinalValue[],
  fields: FieldDef[] = FIELDS,
) {
  const claim = await claimVersion(db, versionId, { model: 'm' });
  if (claim.kind !== 'claimed') throw new Error(`expected claimed, got ${claim.kind}`);
  await saveParsedText(db, versionId, claim.runId, { parsedText: text, pageOffsets: [0] });
  const outcome = await finishVersion(db, versionId, claim.runId, values, { fields });
  expect(outcome).toBe('finished');
}

async function newDoc() {
  n += 1;
  const r = await createDocumentWithV1(db, {
    type: 'invoice',
    title: 'Doc',
    fileKey: `${n}.pdf`,
    sha256: `sha-${n}`,
  });
  return { documentId: r.documentId, v1: r.versionId };
}

async function addVersion(documentId: string): Promise<string> {
  n += 1;
  const r = await createVersion(db, documentId, { fileKey: `${n}.pdf`, sha256: `sha-${n}` });
  if (r.kind !== 'created') throw new Error(`expected created, got ${r.kind}`);
  return r.versionId;
}

const valueOf = (versionId: string, field: string) =>
  db.extractedValue.findUniqueOrThrow({ where: { versionId_field: { versionId, field } } });

async function review(
  versionId: string,
  field: string,
  action: 'approve' | 'correct',
  correctedValue: string | null = null,
) {
  const v = await valueOf(versionId, field);
  return db.review.create({ data: { valueId: v.id, action, correctedValue } });
}

describe('carry-over in finishVersion', () => {
  it('carries the review of an unchanged value; a changed value is pending with its previous link', async () => {
    const d = await newDoc();
    await run(d.v1, TEXT_V1, [val('vendor', 'Acme Corp'), val('total', '$5,230.29')]);
    const approved = await review(d.v1, 'vendor', 'approve');
    await review(d.v1, 'total', 'approve');

    const v2 = await addVersion(d.documentId);
    await run(v2, 'Vendor: Acme Corp\nTotal Due: $9,999.00\n', [
      val('vendor', 'Acme Corp'),
      val('total', '$9,999.00'),
    ]);

    const vendor = await valueOf(v2, 'vendor');
    const prevVendor = await valueOf(d.v1, 'vendor');
    expect(vendor).toMatchObject({ previousValueId: prevVendor.id, carriedReviewId: approved.id });
    const total = await valueOf(v2, 'total');
    expect(total.previousValueId).toBe((await valueOf(d.v1, 'total')).id);
    expect(total.carriedReviewId).toBeNull();
  });

  it('same value but its quote is gone from the new text → pending, previousValueId set', async () => {
    const d = await newDoc();
    await run(d.v1, TEXT_V1, [val('total', '$5,230.29', 'Total Due: $5,230.29')]);
    await review(d.v1, 'total', 'approve');

    const v2 = await addVersion(d.documentId);
    await run(v2, 'Amount payable: $5,230.29\n', [
      val('total', '$5,230.29', 'Amount payable: $5,230.29'),
    ]);

    const total = await valueOf(v2, 'total');
    expect(total.previousValueId).toBe((await valueOf(d.v1, 'total')).id);
    expect(total.carriedReviewId).toBeNull();
  });

  it('an unreviewed previous value → previousValueId set, carriedReviewId null, pending', async () => {
    const d = await newDoc();
    await run(d.v1, TEXT_V1, [val('vendor', 'Acme Corp')]);
    const v2 = await addVersion(d.documentId);
    await run(v2, TEXT_V1, [val('vendor', 'Acme Corp')]);

    const vendor = await valueOf(v2, 'vendor');
    expect(vendor.previousValueId).toBe((await valueOf(d.v1, 'vendor')).id);
    expect(vendor.carriedReviewId).toBeNull();
    const detail = await getDocumentDetail(db, d.documentId, { fields: expectedFields });
    expect(detail!.values.find((v) => v.field === 'vendor')!.reviewState).toBe('pending');
  });

  it('a confirmed-absent gap never carries', async () => {
    const d = await newDoc();
    await run(d.v1, TEXT_V1, [val('vendor', null)]);
    await review(d.v1, 'vendor', 'approve');
    const v2 = await addVersion(d.documentId);
    await run(v2, TEXT_V1, [val('vendor', null)]);

    const vendor = await valueOf(v2, 'vendor');
    expect(vendor.previousValueId).toBe((await valueOf(d.v1, 'vendor')).id);
    expect(vendor.carriedReviewId).toBeNull();
  });

  it('carries a correction', async () => {
    const d = await newDoc();
    await run(d.v1, TEXT_V1, [val('vendor', 'Acme Corp')]);
    const fix = await review(d.v1, 'vendor', 'correct', 'Acme Corporation');
    const v2 = await addVersion(d.documentId);
    await run(v2, TEXT_V1, [val('vendor', 'Acme Corp')]);

    expect((await valueOf(v2, 'vendor')).carriedReviewId).toBe(fix.id);
    const detail = await getDocumentDetail(db, d.documentId, { fields: expectedFields });
    const vendor = detail!.values.find((v) => v.field === 'vendor')!;
    expect(vendor.reviewState).toBe('carried_over');
    expect(vendor.carriedReview?.action).toBe('correct');
  });

  it('carries what the previous value itself carried (v1 → v2 → v3)', async () => {
    const d = await newDoc();
    await run(d.v1, TEXT_V1, [val('vendor', 'Acme Corp')]);
    const approved = await review(d.v1, 'vendor', 'approve');
    const v2 = await addVersion(d.documentId);
    await run(v2, TEXT_V1, [val('vendor', 'Acme Corp')]);
    expect((await valueOf(v2, 'vendor')).carriedReviewId).toBe(approved.id);
    const v3 = await addVersion(d.documentId);
    await run(v3, TEXT_V1, [val('vendor', 'Acme Corp')]);

    const vendor = await valueOf(v3, 'vendor');
    expect(vendor.carriedReviewId).toBe(approved.id);
    expect(vendor.previousValueId).toBe((await valueOf(v2, 'vendor')).id);
  });

  it('skips superseded and failed versions', async () => {
    const d = await newDoc();
    await run(d.v1, TEXT_V1, [val('vendor', 'Acme Corp')]);
    const approved = await review(d.v1, 'vendor', 'approve');
    const v2 = await addVersion(d.documentId);
    const v3 = await addVersion(d.documentId); // supersedes the queued v2
    await db.documentVersion.update({ where: { id: v3 }, data: { status: 'failed' } });
    const v4 = await addVersion(d.documentId);
    expect((await db.documentVersion.findUniqueOrThrow({ where: { id: v2 } })).status).toBe(
      'superseded',
    );
    await run(v4, TEXT_V1, [val('vendor', 'Acme Corp')]);

    const vendor = await valueOf(v4, 'vendor');
    expect(vendor.previousValueId).toBe((await valueOf(d.v1, 'vendor')).id);
    expect(vendor.carriedReviewId).toBe(approved.id);
  });

  it('a field missing from opts.fields never carries', async () => {
    const d = await newDoc();
    await run(d.v1, TEXT_V1, [val('vendor', 'Acme Corp')]);
    await review(d.v1, 'vendor', 'approve');
    const v2 = await addVersion(d.documentId);
    await run(v2, TEXT_V1, [val('vendor', 'Acme Corp')], [{ field: 'total', type: 'money' }]);

    const vendor = await valueOf(v2, 'vendor');
    expect(vendor.previousValueId).toBe((await valueOf(d.v1, 'vendor')).id);
    expect(vendor.carriedReviewId).toBeNull();
  });

  it('first version: every link null', async () => {
    const d = await newDoc();
    await run(d.v1, TEXT_V1, [val('vendor', 'Acme Corp'), val('total', '$5,230.29')]);
    const rows = await db.extractedValue.findMany({ where: { versionId: d.v1 } });
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ previousValueId: null, carriedReviewId: null });
  });
});
