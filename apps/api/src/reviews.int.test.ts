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
const invoicePdf = readFileSync(join(fixturesDir, 'documents', 'invoice-001.pdf'));
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

async function upload(app: App, title?: string): Promise<{ id: string }> {
  const form = new FormData();
  form.append('type', 'invoice');
  if (title !== undefined) form.append('title', title);
  form.append('file', invoicePdf, { filename: 'invoice-001.pdf', contentType: 'application/pdf' });
  const res = await app.inject({
    method: 'POST',
    url: '/documents',
    headers: form.getHeaders(),
    payload: form.getBuffer(),
  });
  return res.json();
}

/** Uploads a document and returns its id and its current version id. */
async function uploaded(app: App, title?: string) {
  const { id } = await upload(app, title);
  const doc = await db.document.findUniqueOrThrow({ where: { id } });
  return { documentId: id, versionId: doc.currentVersionId! };
}

/** Marks the version extracted and gives it one `total_amount` value, as the worker would. */
async function withValue(versionId: string) {
  await db.documentVersion.update({ where: { id: versionId }, data: { status: 'extracted' } });
  return db.extractedValue.create({
    data: { versionId, field: 'total_amount', value: '100.00', evidence: '$100.00' },
  });
}

const review = (app: App, id: string, payload: object) =>
  app.inject({ method: 'POST', url: `/values/${id}/review`, payload });

beforeAll(async () => {
  db = createDb(TEST_DATABASE_URL);
  dir = await mkdtemp(join(tmpdir(), 'lomi-api-reviews-'));
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

describe('GET /documents', () => {
  it('lists an uploaded document with empty progress and status queued', async () => {
    const app = makeApp();
    const { documentId } = await uploaded(app);
    const res = await app.inject({ method: 'GET', url: '/documents' });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: documentId, status: 'queued', versionNo: 1 });
    expect(list[0].progress.total).toBe(0);
  });
});

describe('POST /values/:id/review', () => {
  it('approve answers 201 and shows up as latestReview in the document detail', async () => {
    const app = makeApp();
    const { documentId, versionId } = await uploaded(app);
    const value = await withValue(versionId);
    const res = await review(app, value.id, { action: 'approve' });
    expect(res.statusCode).toBe(201);
    expect(res.json().reviewState).toBe('approved');
    const detail = await app.inject({ method: 'GET', url: `/documents/${documentId}` });
    const shown = detail.json().values.find((v: { id: string }) => v.id === value.id);
    expect(shown.latestReview.action).toBe('approve');
  });

  it('rejects an invalid money correction with 400', async () => {
    const app = makeApp();
    const value = await withValue((await uploaded(app)).versionId);
    const res = await review(app, value.id, { action: 'correct', value: 'abc' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request', message: '"abc" is not a valid money' });
  });

  it('rejects a correction without a value with 400', async () => {
    const app = makeApp();
    const value = await withValue((await uploaded(app)).versionId);
    const res = await review(app, value.id, { action: 'correct' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });

  it('answers 409 conflict for a value of a queued version', async () => {
    const app = makeApp();
    const { versionId } = await uploaded(app);
    const value = await db.extractedValue.create({
      data: { versionId, field: 'total_amount', value: '1', evidence: '1' },
    });
    const res = await review(app, value.id, { action: 'approve' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('conflict');
  });

  it('answers 404 for an unknown value and 400 for a non-uuid id', async () => {
    const app = makeApp();
    const missing = await review(app, UNKNOWN_ID, { action: 'approve' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('not_found');
    const bad = await review(app, 'nope', { action: 'approve' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('bad_request');
  });
});

describe('GET /documents/:id/progress', () => {
  it('returns the counts of the current version', async () => {
    const app = makeApp();
    const { documentId, versionId } = await uploaded(app);
    const value = await withValue(versionId);
    await review(app, value.id, { action: 'approve' });
    const res = await app.inject({ method: 'GET', url: `/documents/${documentId}/progress` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ approved: 1, pending: 0, total: 1 });
  });

  it('answers 404 for an unknown document and 400 for a non-uuid', async () => {
    const app = makeApp();
    const missing = await app.inject({ method: 'GET', url: `/documents/${UNKNOWN_ID}/progress` });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({ method: 'GET', url: '/documents/nope/progress' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('GET /versions/:id/file', () => {
  it('returns the uploaded bytes with pdf, filename and immutable cache headers', async () => {
    const app = makeApp();
    const { versionId } = await uploaded(app, 'Invoice 001');
    const res = await app.inject({ method: 'GET', url: `/versions/${versionId}/file` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(invoicePdf)).toBe(true);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline; filename="Invoice_001-v1.pdf"');
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
  });

  it('answers 404 for an unknown version and 400 for a non-uuid', async () => {
    const app = makeApp();
    const missing = await app.inject({ method: 'GET', url: `/versions/${UNKNOWN_ID}/file` });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({ method: 'GET', url: '/versions/nope/file' });
    expect(bad.statusCode).toBe(400);
  });

  it('answers 404 not_found when the file was deleted from the store', async () => {
    const app = makeApp();
    const { versionId } = await uploaded(app);
    const version = await db.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
    await rm(join(dir, version.fileKey));
    const res = await app.inject({ method: 'GET', url: `/versions/${versionId}/file` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});
