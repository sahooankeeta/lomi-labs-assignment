import type { ExpectedFields, FinalValue } from '@lomi/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { claimVersion, finishVersion, renewLease } from './coordination.js';
import { createDocumentWithV1 } from './documents.js';
import { reviewValue } from './reviews.js';
import { TEST_DATABASE_URL, truncateAll } from './testing.js';
import { createVersion, listVersions } from './versions.js';

const fields: ExpectedFields = {
  invoice: [{ field: 'vendor', type: 'string' }],
  lease: [],
  market_report: [],
};

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

async function makeDoc(sha = 'a') {
  const r = await createDocumentWithV1(db, {
    type: 'invoice',
    title: 'Doc',
    fileKey: `${sha}.pdf`,
    sha256: sha,
  });
  return { documentId: r.documentId, v1: r.versionId };
}

const up = (sha: string) => ({ fileKey: `${sha}.pdf`, sha256: sha });

function created(r: Awaited<ReturnType<typeof createVersion>>) {
  if (r.kind !== 'created') throw new Error(`expected created, got ${r.kind}`);
  return r;
}

describe('createVersion', () => {
  it('creates v2 as the current queued version; an extracted v1 is untouched', async () => {
    const d = await makeDoc();
    await db.documentVersion.update({ where: { id: d.v1 }, data: { status: 'extracted' } });
    const r = created(await createVersion(db, d.documentId, up('b')));
    expect(r).toMatchObject({ versionNo: 2, attempts: 0, superseded: [] });
    const doc = await db.document.findUniqueOrThrow({ where: { id: d.documentId } });
    expect(doc.currentVersionId).toBe(r.versionId);
    const v2 = await db.documentVersion.findUniqueOrThrow({ where: { id: r.versionId } });
    expect(v2).toMatchObject({ status: 'queued', versionNo: 2, sha256: 'b', fileKey: 'b.pdf' });
    expect((await db.documentVersion.findUniqueOrThrow({ where: { id: d.v1 } })).status).toBe(
      'extracted',
    );
  });

  it('supersedes a queued v1', async () => {
    const d = await makeDoc();
    const r = created(await createVersion(db, d.documentId, up('b')));
    expect(r.superseded).toEqual([d.v1]);
    expect((await db.documentVersion.findUniqueOrThrow({ where: { id: d.v1 } })).status).toBe(
      'superseded',
    );
  });

  it('supersedes an extracting v1 and abandons its run', async () => {
    const d = await makeDoc();
    const claim = await claimVersion(db, d.v1, { model: 'm' });
    if (claim.kind !== 'claimed') throw new Error('not claimed');
    await createVersion(db, d.documentId, up('b'));

    const v1 = await db.documentVersion.findUniqueOrThrow({ where: { id: d.v1 } });
    expect(v1).toMatchObject({ status: 'superseded', leaseExpiresAt: null });
    const run = await db.extractionRun.findUniqueOrThrow({ where: { id: claim.runId } });
    expect(run.status).toBe('abandoned');
    expect(run.finishedAt).not.toBeNull();

    expect(await renewLease(db, d.v1, claim.runId)).toBe(false);
    const values: FinalValue[] = [
      {
        field: 'vendor',
        value: 'x',
        evidence: 'x',
        gapReason: null,
        candidates: null,
        evidencePage: 1,
        evidenceStart: 0,
        evidenceEnd: 1,
      },
    ];
    expect(await finishVersion(db, d.v1, claim.runId, values)).toBe('stale');
    expect(await db.extractedValue.count()).toBe(0);
  });

  it('a failed v1 stays failed', async () => {
    const d = await makeDoc();
    await db.documentVersion.update({ where: { id: d.v1 }, data: { status: 'failed' } });
    const r = created(await createVersion(db, d.documentId, up('b')));
    expect(r.superseded).toEqual([]);
    expect((await db.documentVersion.findUniqueOrThrow({ where: { id: d.v1 } })).status).toBe(
      'failed',
    );
  });

  it('same file as the current version is unchanged; no row, no supersede', async () => {
    const d = await makeDoc('a');
    const r = await createVersion(db, d.documentId, up('a'));
    expect(r).toEqual({ kind: 'unchanged', versionId: d.v1 });
    expect(await db.documentVersion.count()).toBe(1);
    expect((await db.documentVersion.findUniqueOrThrow({ where: { id: d.v1 } })).status).toBe(
      'queued',
    );
  });

  it('concurrent identical uploads create one new version', async () => {
    const d = await makeDoc();
    const [a, b] = await Promise.all([
      createVersion(db, d.documentId, up('b')),
      createVersion(db, d.documentId, up('b')),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['created', 'unchanged']);
    const c = created(a.kind === 'created' ? a : b);
    const u = a.kind === 'unchanged' ? a : b;
    expect(c.versionNo).toBe(2);
    expect(u).toEqual({ kind: 'unchanged', versionId: c.versionId });
    expect(await db.documentVersion.count()).toBe(2);
  });

  it('concurrent different uploads get versions 2 and 3', async () => {
    const d = await makeDoc();
    const rs = await Promise.all([
      createVersion(db, d.documentId, up('b')),
      createVersion(db, d.documentId, up('c')),
    ]);
    expect(rs.map((r) => created(r).versionNo).sort()).toEqual([2, 3]);
    const v3 = await db.documentVersion.findUniqueOrThrow({
      where: { documentId_versionNo: { documentId: d.documentId, versionNo: 3 } },
    });
    const doc = await db.document.findUniqueOrThrow({ where: { id: d.documentId } });
    expect(doc.currentVersionId).toBe(v3.id);
  });

  it("re-uploading v1's file while v2 is current creates v3", async () => {
    const d = await makeDoc('a');
    created(await createVersion(db, d.documentId, up('b')));
    const r = created(await createVersion(db, d.documentId, up('a')));
    expect(r.versionNo).toBe(3);
  });

  it('not_found for an unknown document', async () => {
    const r = await createVersion(db, '00000000-0000-4000-8000-000000000000', up('b'));
    expect(r).toEqual({ kind: 'not_found' });
  });

  it('a v1 value is not reviewable once v2 exists', async () => {
    const d = await makeDoc();
    await db.documentVersion.update({ where: { id: d.v1 }, data: { status: 'extracted' } });
    const val = await db.extractedValue.create({
      data: { versionId: d.v1, field: 'vendor', value: 'Acme', evidence: 'Acme' },
    });
    await createVersion(db, d.documentId, up('b'));
    const r = await reviewValue(db, val.id, { action: 'approve' }, { fields });
    expect(r.kind).toBe('not_reviewable');
    expect(await db.review.count()).toBe(0);
  });
});

describe('listVersions', () => {
  it('lists newest first; unknown document is null', async () => {
    const d = await makeDoc();
    const r = created(await createVersion(db, d.documentId, up('b')));
    const list = await listVersions(db, d.documentId);
    expect(list).toMatchObject([
      { id: r.versionId, versionNo: 2, status: 'queued', error: null },
      { id: d.v1, versionNo: 1, status: 'superseded', error: null },
    ]);
    expect(typeof list![0]!.createdAt).toBe('string');
    expect(await listVersions(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
