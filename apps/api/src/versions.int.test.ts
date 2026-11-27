import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, type Db } from '@lomi/db';
import { TEST_DATABASE_URL, truncateAll } from '@lomi/db/testing';
import { LocalFileStore } from '@lomi/files';
import { createLogger } from '@lomi/logger';
import { loadExpectedFields } from '@lomi/shared/node';
import FormData from 'form-data';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

const fixturesDir = fileURLToPath(new URL('../../../fixtures', import.meta.url));
const v1Pdf = readFileSync(join(fixturesDir, 'documents', 'invoice-001.pdf'));
const v2Pdf = readFileSync(join(fixturesDir, 'documents', 'invoice-001.v2.pdf'));
const UNKNOWN_ID = '7b0f6a3e-1c1d-4a55-9c3e-2f1d7f0f6a11';

let db: Db;
let dir: string;
let files: LocalFileStore;
const enqueue = vi.fn<(versionId: string, attempts: number) => Promise<void>>();

function makeApp() {
  return buildApp(
    {
      pingDb: async () => {},
      pingRedis: async () => {},
      close: async () => {},
      db,
      files,
      fields: loadExpectedFields(fixturesDir),
      enqueue,
    },
    createLogger('api-test', { level: 'silent' }),
  );
}
type App = ReturnType<typeof makeApp>;

async function uploadDoc(app: App): Promise<string> {
  const form = new FormData();
  form.append('type', 'invoice');
  form.append('file', v1Pdf, { filename: 'invoice-001.pdf', contentType: 'application/pdf' });
  const res = await app.inject({
    method: 'POST',
    url: '/documents',
    headers: form.getHeaders(),
    payload: form.getBuffer(),
  });
  return res.json().id;
}

/** `file: null` leaves the file part out. */
function uploadVersion(app: App, id: string, file: Buffer | null = v2Pdf) {
  const form = new FormData();
  form.append('note', 'x');
  if (file) form.append('file', file, { filename: 'v.pdf', contentType: 'application/pdf' });
  return app.inject({
    method: 'POST',
    url: `/documents/${id}/versions`,
    headers: form.getHeaders(),
    payload: form.getBuffer(),
  });
}

beforeAll(async () => {
  db = createDb(TEST_DATABASE_URL);
  dir = await mkdtemp(join(tmpdir(), 'lomi-api-versions-'));
  files = new LocalFileStore(dir);
});
beforeEach(async () => {
  await truncateAll(db);
  enqueue.mockReset();
  enqueue.mockResolvedValue(undefined);
});
afterAll(async () => {
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});

describe('POST /documents/:id/versions', () => {
  it('creates v2, answers 201 and enqueues once with (v2 id, 0)', async () => {
    const app = makeApp();
    const id = await uploadDoc(app);
    enqueue.mockClear();
    const res = await uploadVersion(app, id);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id, versionNo: 2, status: 'queued' });
    const doc = await db.document.findUniqueOrThrow({ where: { id } });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(doc.currentVersionId, 0);
  });

  it('answers 200 with the current versionNo for the same bytes and does not enqueue', async () => {
    const app = makeApp();
    const id = await uploadDoc(app);
    enqueue.mockClear();
    const res = await uploadVersion(app, id, v1Pdf);
    expect(res.statusCode).toBe(200);
    expect(res.json().versionNo).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('answers 200 with versionNo 2 when v2 is uploaded twice', async () => {
    const app = makeApp();
    const id = await uploadDoc(app);
    await uploadVersion(app, id);
    enqueue.mockClear();
    const res = await uploadVersion(app, id);
    expect(res.statusCode).toBe(200);
    expect(res.json().versionNo).toBe(2);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a non-PDF with 400 "file is not a PDF"', async () => {
    const app = makeApp();
    const id = await uploadDoc(app);
    const res = await uploadVersion(app, id, Buffer.from('hello world'));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request', message: 'file is not a PDF' });
  });

  it('rejects a request without a file with 400 "file is required"', async () => {
    const app = makeApp();
    const id = await uploadDoc(app);
    const res = await uploadVersion(app, id, null);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request', message: 'file is required' });
  });

  it('rejects a file over 20 MB with 413', async () => {
    const app = makeApp();
    const id = await uploadDoc(app);
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(21 * 1024 * 1024, 0x20)]);
    const res = await uploadVersion(app, id, big);
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('payload_too_large');
  });

  it('404s an unknown document and 400s a non-uuid id', async () => {
    const app = makeApp();
    expect((await uploadVersion(app, UNKNOWN_ID)).statusCode).toBe(404);
    expect((await uploadVersion(app, 'nope')).statusCode).toBe(400);
  });
});

describe('GET /documents/:id/versions', () => {
  it('lists versions newest first', async () => {
    const app = makeApp();
    const id = await uploadDoc(app);
    await uploadVersion(app, id);
    const res = await app.inject({ method: 'GET', url: `/documents/${id}/versions` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([
      { versionNo: 2, status: 'queued' },
      { versionNo: 1, status: 'superseded' },
    ]);
  });

  it('404s an unknown document and 400s a non-uuid id', async () => {
    const app = makeApp();
    const missing = await app.inject({ method: 'GET', url: `/documents/${UNKNOWN_ID}/versions` });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({ method: 'GET', url: '/documents/nope/versions' });
    expect(bad.statusCode).toBe(400);
  });

  it('GET /documents/:id?version=1 after v2 is superseded and reports currentVersionNo 2', async () => {
    const app = makeApp();
    const id = await uploadDoc(app);
    await uploadVersion(app, id);
    const res = await app.inject({ method: 'GET', url: `/documents/${id}?version=1` });
    expect(res.statusCode).toBe(200);
    expect(res.json().version.status).toBe('superseded');
    expect(res.json().currentVersionNo).toBe(2);
  });
});

describe('GET /values/:id/history', () => {
  it('returns entries newest first', async () => {
    const app = makeApp();
    const id = await uploadDoc(app);
    const doc1 = await db.document.findUniqueOrThrow({ where: { id } });
    const v1 = await db.extractedValue.create({
      data: {
        versionId: doc1.currentVersionId!,
        field: 'total_amount',
        value: '100.00',
        evidence: '$100',
      },
    });
    await db.review.create({ data: { valueId: v1.id, action: 'approve' } });
    await db.review.create({
      data: { valueId: v1.id, action: 'correct', correctedValue: '101.00' },
    });
    await uploadVersion(app, id);
    const doc2 = await db.document.findUniqueOrThrow({ where: { id } });
    const v2 = await db.extractedValue.create({
      data: {
        versionId: doc2.currentVersionId!,
        field: 'total_amount',
        value: '120.00',
        evidence: '$120',
        previousValueId: v1.id,
      },
    });
    const res = await app.inject({ method: 'GET', url: `/values/${v2.id}/history` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.field).toBe('total_amount');
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].versionNo).toBe(2);
    expect(body.entries[1].versionNo).toBe(1);
    expect(body.entries[1].reviews.map((r: { action: string }) => r.action)).toEqual([
      'approve',
      'correct',
    ]);
  });

  it('404s an unknown value and 400s a non-uuid id', async () => {
    const app = makeApp();
    const missing = await app.inject({ method: 'GET', url: `/values/${UNKNOWN_ID}/history` });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({ method: 'GET', url: '/values/nope/history' });
    expect(bad.statusCode).toBe(400);
  });
});
