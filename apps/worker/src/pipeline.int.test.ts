import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimVersion,
  createDb,
  createDocumentWithV1,
  retryCurrentVersion,
  type Db,
} from '@lomi/db';
import { truncateAll } from '@lomi/db/testing';
import { LocalFileStore } from '@lomi/files';
import { createLogger } from '@lomi/logger';
import type { DocumentType } from '@lomi/shared';
import { loadExpectedFields } from '@lomi/shared/node';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeExtractor, MissingKeyExtractor, type Extractor } from './extractors/index.js';
import { processVersion, type PipelineDeps } from './pipeline.js';
import { startReconciler } from './reconciler.js';

// Integration tests run from apps/worker; fixtures live at the repo root.
const fixturesDir = fileURLToPath(new URL('../../../fixtures', import.meta.url));
const pdf = (name: string) => readFileSync(join(fixturesDir, 'documents', name));
const fields = loadExpectedFields(fixturesDir);
const log = createLogger('worker-test', { level: process.env.DBG ? 'info' : 'silent' });
// Short chunks: the 1-page invoice becomes several chunks (fake token count = chars / 4).
const SMALL_CHUNKS = { targetTokens: 40, maxTokens: 80, overlapTokens: 5 };

let db: Db;
let dir: string;
let files: LocalFileStore;

beforeAll(async () => {
  db = createDb(process.env.TEST_DATABASE_URL ?? 'postgres://lomi:lomi@localhost:5432/lomi_test');
  dir = await mkdtemp(join(tmpdir(), 'lomi-worker-'));
  files = new LocalFileStore(dir);
});
afterAll(async () => {
  await db.$disconnect();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await truncateAll(db);
});

async function seed(type: DocumentType, bytes: Uint8Array, title = 'doc') {
  const { key, sha256 } = await files.put(bytes);
  return createDocumentWithV1(db, { type, title, fileKey: key, sha256 });
}

function deps(extractor: Extractor, over: Partial<PipelineDeps> = {}): PipelineDeps {
  return { db, files, extractor, fields, log, ...over };
}

const version = (id: string) => db.documentVersion.findUniqueOrThrow({ where: { id } });
const valueCount = (id: string) => db.extractedValue.count({ where: { versionId: id } });

/** Wraps a FakeExtractor to record calls and concurrency, and optionally to fail on one chunk. */
class SpyExtractor implements Extractor {
  readonly model = 'fake';
  readonly inner: FakeExtractor;
  readonly calls: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(
    delayMs = 0,
    private readonly failOnPart?: number,
  ) {
    this.inner = new FakeExtractor({ delayMs });
  }
  countTokens(text: string) {
    return this.inner.countTokens(text);
  }
  async extract(req: Parameters<Extractor['extract']>[0], opts?: { signal?: AbortSignal }) {
    this.calls.push(req.chunkText);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.failOnPart !== undefined && req.prompt.user.includes(`part ${this.failOnPart} of`)) {
        throw new Error('model exploded');
      }
      return await this.inner.extract(req, opts);
    } finally {
      this.inFlight--;
    }
  }
}

describe('processVersion', () => {
  it('extracts the invoice into 5 values with evidence', async () => {
    const { versionId } = await seed('invoice', pdf('invoice-001.pdf'));
    expect(await processVersion(deps(new FakeExtractor()), versionId)).toBe('finished');
    const v = await version(versionId);
    expect(v.status).toBe('extracted');
    expect(v.parsedText).toContain('Total Due: $5,230.29');
    const values = await db.extractedValue.findMany({ where: { versionId } });
    expect(values).toHaveLength(5);
    const total = values.find((x) => x.field === 'total_amount');
    expect(total).toMatchObject({ value: '$5,230.29', evidencePage: 1 });
    const run = await db.extractionRun.findFirstOrThrow({ where: { versionId } });
    expect(run.status).toBe('succeeded');
  });

  it('records a gap for a field the report does not state', async () => {
    const { versionId } = await seed('market_report', pdf('market-report-excerpt-001.pdf'));
    expect(await processVersion(deps(new FakeExtractor()), versionId)).toBe('finished');
    const income = await db.extractedValue.findFirstOrThrow({
      where: { versionId, field: 'median_household_income' },
    });
    expect(income.value).toBeNull();
    expect(income.gapReason).toBeTruthy();
  });

  it('runs once when two workers race: one finished, one skipped', async () => {
    const { versionId } = await seed('invoice', pdf('invoice-001.pdf'));
    const results = await Promise.all([
      processVersion(deps(new FakeExtractor({ delayMs: 50 })), versionId),
      processVersion(deps(new FakeExtractor({ delayMs: 50 })), versionId),
    ]);
    expect([...results].sort()).toEqual(['finished', 'skipped']);
    expect(await valueCount(versionId)).toBe(5);
  });

  it('fails a PDF with no text layer', async () => {
    const blank = await PDFDocument.create();
    blank.addPage();
    const { versionId } = await seed('invoice', await blank.save());
    expect(await processVersion(deps(new FakeExtractor()), versionId)).toBe('failed');
    const v = await version(versionId);
    expect(v.status).toBe('failed');
    expect(v.error).toBe('No text layer found (scanned PDF?); OCR is not supported');
    expect(await valueCount(versionId)).toBe(0);
  });

  it('fails with the missing-key message, then succeeds after retry', async () => {
    const { documentId, versionId } = await seed('invoice', pdf('invoice-001.pdf'));
    expect(await processVersion(deps(new MissingKeyExtractor()), versionId)).toBe('failed');
    expect((await version(versionId)).error).toBe('GEMINI_API_KEY is not set');

    expect(await retryCurrentVersion(db, documentId)).toMatchObject({ kind: 'retried' });
    expect(await processVersion(deps(new FakeExtractor()), versionId)).toBe('finished');
    expect(await valueCount(versionId)).toBe(5);
  });

  it('resumes after a failure without re-extracting stored chunks', async () => {
    const { documentId, versionId } = await seed('invoice', pdf('invoice-001.pdf'));
    // Chunk index 1 is "part 2 of N". One at a time, so chunk 0 is stored before 1 throws.
    const failing = new SpyExtractor(0, 2);
    const first = await processVersion(
      deps(failing, { chunkOptions: SMALL_CHUNKS, chunkConcurrency: 1 }),
      versionId,
    );
    expect(first).toBe('failed');
    expect((await version(versionId)).error).toBe('model exploded');
    const stored = await db.chunkResult.findMany({ where: { versionId } });
    expect(stored.map((r) => r.chunkIndex)).toEqual([0]);
    const chunkCount = await db.versionChunk.count({ where: { versionId } });
    expect(chunkCount).toBeGreaterThan(2);

    await retryCurrentVersion(db, documentId);
    const counting = new SpyExtractor();
    const second = await processVersion(deps(counting, { chunkOptions: SMALL_CHUNKS }), versionId);
    expect(second).toBe('finished');
    expect(counting.calls).toHaveLength(chunkCount - 1);
    const chunk0 = await db.versionChunk.findFirstOrThrow({ where: { versionId, chunkIndex: 0 } });
    const text = (await version(versionId)).parsedText!;
    expect(counting.calls).not.toContain(text.slice(chunk0.start, chunk0.end));
    expect(await valueCount(versionId)).toBe(5);
  });

  it('keeps at most chunkConcurrency extract calls in flight', async () => {
    const { versionId } = await seed('invoice', pdf('invoice-001.pdf'));
    const spy = new SpyExtractor(50);
    const result = await processVersion(
      deps(spy, { chunkOptions: { ...SMALL_CHUNKS, targetTokens: 30, maxTokens: 60 } }),
      versionId,
    );
    expect(result).toBe('finished');
    expect(spy.calls.length).toBeGreaterThanOrEqual(5);
    expect(spy.maxInFlight).toBeGreaterThan(1);
    expect(spy.maxInFlight).toBeLessThanOrEqual(3);
  });

  it('fails a document that needs more chunks than the limit', async () => {
    const { versionId } = await seed('invoice', pdf('invoice-001.pdf'));
    const result = await processVersion(
      deps(new FakeExtractor(), { chunkOptions: { ...SMALL_CHUNKS, maxChunks: 1 } }),
      versionId,
    );
    expect(result).toBe('failed');
    expect((await version(versionId)).error).toMatch(/^Document too long \(\d+ chunks; limit 1\)$/);
  });

  it('hands off on SIGTERM: queued again, attempt not spent, no values', async () => {
    const { versionId } = await seed('invoice', pdf('invoice-001.pdf'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await processVersion(
      deps(new FakeExtractor({ delayMs: 2000 }), { signal: controller.signal }),
      versionId,
    );
    expect(result).toBe('handed_off');
    const v = await version(versionId);
    expect(v).toMatchObject({ status: 'queued', attempts: 0, activeRunId: null });
    expect(await valueCount(versionId)).toBe(0);
    const run = await db.extractionRun.findFirstOrThrow({ where: { versionId } });
    expect(run.status).toBe('abandoned');
    // The version is immediately claimable by the next worker.
    expect(await processVersion(deps(new FakeExtractor()), versionId)).toBe('finished');
  });

  it('is stale when another worker took over after the lease expired', async () => {
    const { versionId } = await seed('invoice', pdf('invoice-001.pdf'));
    // First run: 300 ms lease, never renewed (renewMs far away), slow extract.
    const first = processVersion(
      deps(new FakeExtractor({ delayMs: 1500 }), { leaseMs: 300, renewMs: 60_000 }),
      versionId,
    );
    await new Promise((r) => setTimeout(r, 800));
    const second = await processVersion(deps(new FakeExtractor()), versionId);
    expect(second).toBe('finished');
    expect(await first).toBe('stale');
    expect(await valueCount(versionId)).toBe(5);
    expect((await version(versionId)).status).toBe('extracted');
  });

  it('stops as soon as renewal reports the lease is gone', async () => {
    const { versionId } = await seed('invoice', pdf('invoice-001.pdf'));
    const spy = new SpyExtractor(5000);
    const run = processVersion(deps(spy, { leaseMs: 5000, renewMs: 50 }), versionId);
    await new Promise((r) => setTimeout(r, 300));
    // Simulate a takeover: someone else is now the active run.
    await db.documentVersion.update({
      where: { id: versionId },
      data: { activeRunId: crypto.randomUUID() },
    });
    const started = Date.now();
    expect(await run).toBe('stale');
    expect(Date.now() - started).toBeLessThan(2000);
    // The run that lost the lease wrote nothing: the row is as the "other worker" left it.
    const v = await version(versionId);
    expect(v.status).toBe('extracting');
    expect(await valueCount(versionId)).toBe(0);
  });

  it('keeps the lease alive across a long extract call', async () => {
    const { versionId } = await seed('invoice', pdf('invoice-001.pdf'));
    const run = processVersion(
      deps(new FakeExtractor({ delayMs: 1200 }), { leaseMs: 400, renewMs: 100 }),
      versionId,
    );
    await new Promise((r) => setTimeout(r, 900));
    // Lease is 400 ms and the call takes 1200 ms: only renewal keeps another claim out.
    const other = await claimVersion(db, versionId, { model: 'fake' });
    expect(other.kind).toBe('skipped');
    expect(await run).toBe('finished');
  });
});

describe('startReconciler', () => {
  it('enqueues queued and expired-lease versions with their attempts, every time', async () => {
    const queued = await seed('invoice', pdf('invoice-001.pdf'));
    const expired = await seed('lease', pdf('lease-excerpt-001.pdf'));
    const live = await seed('market_report', pdf('market-report-excerpt-001.pdf'));
    await claimVersion(db, expired.versionId, { model: 'fake', leaseMs: 1 });
    await claimVersion(db, live.versionId, { model: 'fake', leaseMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50));

    const enqueue = vi.fn<(versionId: string, attempts: number) => Promise<void>>(async () => {});
    const reconciler = startReconciler({ db, enqueue, log, intervalMs: 3_600_000 });
    try {
      expect(await reconciler.runOnce()).toBe(2);
      expect(enqueue.mock.calls.map((c) => [...c]).sort()).toEqual(
        [
          [queued.versionId, 0],
          [expired.versionId, 1],
        ].sort(),
      );
      // The queue was flushed (the spy forgets everything): the next pass re-adds them.
      enqueue.mockClear();
      expect(await reconciler.runOnce()).toBe(2);
      expect(enqueue).toHaveBeenCalledTimes(2);
    } finally {
      reconciler.stop();
    }
  });

  it('keeps going when one enqueue fails', async () => {
    await seed('invoice', pdf('invoice-001.pdf'));
    await seed('lease', pdf('lease-excerpt-001.pdf'));
    const enqueue = vi
      .fn<(versionId: string, attempts: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValue(undefined);
    const reconciler = startReconciler({ db, enqueue, log, intervalMs: 3_600_000 });
    try {
      await reconciler.runOnce();
      expect(enqueue).toHaveBeenCalledTimes(2);
    } finally {
      reconciler.stop();
    }
  });

  describe('with a hung enqueue (Redis outage)', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('runs one pass at a time, retries after the timeout, and stops on stop()', async () => {
      await seed('invoice', pdf('invoice-001.pdf'));
      await seed('lease', pdf('lease-excerpt-001.pdf'));
      const enqueue = vi
        .fn<(versionId: string, attempts: number) => Promise<void>>()
        .mockImplementation(() => new Promise<void>(() => {}));
      const reconciler = startReconciler({ db, enqueue, log, intervalMs: 40, timeoutMs: 400 });
      try {
        await sleep(250); // several ticks while the first pass is hung
        expect(enqueue).toHaveBeenCalledTimes(2); // once per version, not once per tick
        expect(await reconciler.runOnce()).toBe(0); // direct call is guarded too

        await sleep(600); // first pass timed out at ~440 ms; a later tick runs again
        expect(enqueue.mock.calls.length).toBeGreaterThanOrEqual(4);
      } finally {
        reconciler.stop();
      }
      const calls = enqueue.mock.calls.length;
      await sleep(600);
      expect(enqueue).toHaveBeenCalledTimes(calls);
      expect(await reconciler.runOnce()).toBe(0);
    });
  });
});
