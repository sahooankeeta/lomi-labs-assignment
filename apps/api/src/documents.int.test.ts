import { existsSync, readFileSync } from 'node:fs';
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

// Integration tests run from apps/api; fixtures live at the repo root.
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

interface UploadOpts {
  /** `null` leaves the field out. */
  type?: string | null;
  title?: string;
  file?: Buffer;
  filename?: string;
}

function upload(app: ReturnType<typeof makeApp>, opts: UploadOpts = {}) {
  const form = new FormData();
  if (opts.type !== null) form.append('type', opts.type ?? 'invoice');
  if (opts.title !== undefined) form.append('title', opts.title);
  form.append('file', opts.file ?? invoicePdf, {
    filename: opts.filename ?? 'invoice-001.pdf',
    contentType: 'application/pdf',
  });
  return app.inject({
    method: 'POST',
    url: '/documents',
    headers: form.getHeaders(),
    payload: form.getBuffer(),
  });
}

beforeAll(async () => {
  db = createDb(TEST_DATABASE_URL);
  dir = await mkdtemp(join(tmpdir(), 'lomi-api-'));
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

describe('POST /documents', () => {
  it('creates a queued v1, stores the file and enqueues once after commit', async () => {
    const res = await upload(makeApp());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ type: 'invoice', versionNo: 1, status: 'queued' });
    const doc = await db.document.findUniqueOrThrow({ where: { id: body.id } });
    const version = await db.documentVersion.findUniqueOrThrow({
      where: { id: doc.currentVersionId! },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(version.id, 0);
    expect(existsSync(join(dir, `${version.sha256}.pdf`))).toBe(true);
  });

  it('answers 200 with the same document for an identical upload and does not enqueue again', async () => {
    const app = makeApp();
    const first = await upload(app);
    const second = await upload(app);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('defaults the title to the filename without .pdf', async () => {
    const res = await upload(makeApp());
    expect(res.json().title).toBe('invoice-001');
  });

  it('uses the given title', async () => {
    const res = await upload(makeApp(), { title: 'March invoice' });
    expect(res.json().title).toBe('March invoice');
  });

  it('rejects an unknown type with 400 bad_request', async () => {
    const res = await upload(makeApp(), { type: 'receipt' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a missing type with 400', async () => {
    const res = await upload(makeApp(), { type: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });

  it('rejects a non-PDF with 400 "file is not a PDF"', async () => {
    const res = await upload(makeApp(), { file: Buffer.from('hello world'), filename: 'a.pdf' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request', message: 'file is not a PDF' });
    expect(await db.document.count()).toBe(0);
  });

  it('rejects a request without a file with 400', async () => {
    const form = new FormData();
    form.append('type', 'invoice');
    const res = await makeApp().inject({
      method: 'POST',
      url: '/documents',
      headers: form.getHeaders(),
      payload: form.getBuffer(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a file over 20 MB with 413 payload_too_large', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(21 * 1024 * 1024, 0x20)]);
    const res = await upload(makeApp(), { file: big });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('payload_too_large');
  });

  it('still answers 201 and leaves the version queued when enqueue rejects (reconciler repairs it)', async () => {
    enqueue.mockRejectedValue(new Error('redis down'));
    const res = await upload(makeApp());
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('queued');
    expect(await db.documentVersion.count({ where: { status: 'queued' } })).toBe(1);
  });
});

describe('enqueue is fire-and-forget', () => {
  it('upload returns 201 promptly even if enqueue never settles', async () => {
    enqueue.mockReturnValue(new Promise(() => {}));
    const res = await upload(makeApp());
    expect(res.statusCode).toBe(201);
    expect(await db.documentVersion.count({ where: { status: 'queued' } })).toBe(1);
  }, 5000);

  it('retry returns 202 promptly even if enqueue never settles', async () => {
    const app = makeApp();
    const { id } = (await upload(app)).json();
    const doc = await db.document.findUniqueOrThrow({ where: { id } });
    await db.documentVersion.update({
      where: { id: doc.currentVersionId! },
      data: { status: 'failed' },
    });
    enqueue.mockReturnValue(new Promise(() => {}));
    const res = await app.inject({ method: 'POST', url: `/documents/${id}/retry` });
    expect(res.statusCode).toBe(202);
    expect(await db.documentVersion.count({ where: { status: 'queued' } })).toBe(1);
  }, 5000);

  it('logs a rejected enqueue at warn', async () => {
    enqueue.mockRejectedValue(new Error('redis down'));
    const warn = vi.fn();
    const log = createLogger('api-test', { level: 'silent' });
    log.warn = warn as never;
    const app = buildApp(
      {
        pingDb: async () => {},
        pingRedis: async () => {},
        close: async () => {},
        db,
        files,
        fields: loadExpectedFields(fixturesDir),
        enqueue,
      },
      log,
    );
    expect((await upload(app)).statusCode).toBe(201);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });
});

describe('unknown routes', () => {
  it('404s in the { error, message } shape', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', message: 'Route GET /nope not found' });
  });

  it('leaves /health alone', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /documents/:id', () => {
  it('returns the current version with no values before extraction', async () => {
    const app = makeApp();
    const { id } = (await upload(app)).json();
    const res = await app.inject({ method: 'GET', url: `/documents/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, status: 'queued', values: [] });
  });

  it('returns 404 for an unknown id and 400 for a malformed one', async () => {
    const app = makeApp();
    const missing = await app.inject({ method: 'GET', url: `/documents/${UNKNOWN_ID}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('not_found');
    const bad = await app.inject({ method: 'GET', url: '/documents/not-a-uuid' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('bad_request');
  });

  it('honours ?version=N, 404s a missing version and 400s a bad one', async () => {
    const app = makeApp();
    const { id } = (await upload(app)).json();
    const ok = await app.inject({ method: 'GET', url: `/documents/${id}?version=1` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().version.versionNo).toBe(1);
    const none = await app.inject({ method: 'GET', url: `/documents/${id}?version=2` });
    expect(none.statusCode).toBe(404);
    for (const v of ['0', '-1', 'x', '1.5']) {
      const bad = await app.inject({ method: 'GET', url: `/documents/${id}?version=${v}` });
      expect(bad.statusCode).toBe(400);
    }
  });
});

describe('POST /documents/:id/retry', () => {
  it('409s a version that is not failed', async () => {
    const app = makeApp();
    const { id } = (await upload(app)).json();
    const res = await app.inject({ method: 'POST', url: `/documents/${id}/retry` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('conflict');
  });

  it('404s an unknown document and 400s a malformed id', async () => {
    const app = makeApp();
    const missing = await app.inject({ method: 'POST', url: `/documents/${UNKNOWN_ID}/retry` });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({ method: 'POST', url: '/documents/nope/retry' });
    expect(bad.statusCode).toBe(400);
  });

  it('requeues a failed version, answers 202 and enqueues attempt 0', async () => {
    const app = makeApp();
    const { id } = (await upload(app)).json();
    const doc = await db.document.findUniqueOrThrow({ where: { id } });
    await db.documentVersion.update({
      where: { id: doc.currentVersionId! },
      data: { status: 'failed', error: 'boom', attempts: 3 },
    });
    enqueue.mockClear();

    const res = await app.inject({ method: 'POST', url: `/documents/${id}/retry` });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id, versionNo: 1, status: 'queued' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(doc.currentVersionId, 0);
  });
});
