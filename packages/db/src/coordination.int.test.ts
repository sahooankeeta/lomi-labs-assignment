import type { Candidate, FinalValue } from '@lomi/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import {
  LEASE_MS,
  MAX_ATTEMPTS,
  claimVersion,
  failVersion,
  findReconcilable,
  finishVersion,
  getChunkState,
  handOffVersion,
  renewLease,
  saveChunkPlan,
  saveChunkResult,
  saveParsedText,
} from './coordination.js';
import { createDocumentWithV1 } from './documents.js';
import { TEST_DATABASE_URL, truncateAll } from './testing.js';

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

const opts = { model: 'test-model' };

async function makeVersion(): Promise<string> {
  n += 1;
  const r = await createDocumentWithV1(db, {
    type: 'invoice',
    title: `Inv ${n}`,
    fileKey: `${n}.pdf`,
    sha256: `sha${n}`,
  });
  return r.versionId;
}

function value(field: string, v: string | null = 'x'): FinalValue {
  return {
    field,
    value: v,
    evidence: v === null ? null : 'ev',
    gapReason: v === null ? 'not found' : null,
    candidates: null,
    evidencePage: v === null ? null : 1,
    evidenceStart: v === null ? null : 0,
    evidenceEnd: v === null ? null : 2,
  };
}
const fields = ['vendor', 'total', 'due_date'];
const allValues = fields.map((f) => value(f));

async function claimed(id: string, o: { now?: Date } = {}) {
  const r = await claimVersion(db, id, { ...opts, ...o });
  if (r.kind !== 'claimed') throw new Error(`expected claimed, got ${r.kind}`);
  return r;
}

describe('claimVersion', () => {
  it('claims a queued version and records one running run', async () => {
    const id = await makeVersion();
    const r = await claimed(id);
    expect(r.version).toMatchObject({ id, attempts: 1, type: 'invoice' });
    const row = await db.documentVersion.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'extracting', attempts: 1, activeRunId: r.runId });
    expect(row.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    const runs = await db.extractionRun.findMany({ where: { versionId: id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: r.runId, status: 'running', model: 'test-model' });
  });

  it('skips while the lease is live', async () => {
    const id = await makeVersion();
    await claimed(id);
    expect(await claimVersion(db, id, opts)).toEqual({ kind: 'skipped' });
    expect(await db.extractionRun.count()).toBe(1);
  });

  it('two simultaneous claims give exactly one claimed', async () => {
    const id = await makeVersion();
    const results = await Promise.all([claimVersion(db, id, opts), claimVersion(db, id, opts)]);
    expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'skipped')).toHaveLength(1);
    expect(await db.extractionRun.count()).toBe(1);
    expect((await db.documentVersion.findUniqueOrThrow({ where: { id } })).attempts).toBe(1);
  });

  it('re-claims an expired lease with a new run and attempts 2', async () => {
    const id = await makeVersion();
    const first = await claimed(id);
    const later = new Date(Date.now() + LEASE_MS + 1000);
    const second = await claimed(id, { now: later });
    expect(second.runId).not.toBe(first.runId);
    expect(second.version.attempts).toBe(2);
  });

  it('caps at MAX_ATTEMPTS with the exact error', async () => {
    const id = await makeVersion();
    await db.documentVersion.update({
      where: { id },
      data: {
        status: 'extracting',
        attempts: MAX_ATTEMPTS,
        activeRunId: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 1000),
      },
    });
    expect(await claimVersion(db, id, opts)).toEqual({ kind: 'capped' });
    const row = await db.documentVersion.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      status: 'failed',
      error: 'extraction was interrupted 3 times',
      activeRunId: null,
    });
    expect(await db.extractionRun.count()).toBe(0);
  });

  it('skips extracted, failed and superseded versions', async () => {
    for (const status of ['extracted', 'failed', 'superseded'] as const) {
      const id = await makeVersion();
      await db.documentVersion.update({ where: { id }, data: { status } });
      expect(await claimVersion(db, id, opts)).toEqual({ kind: 'skipped' });
    }
  });
});

describe('renewLease', () => {
  it('extends only for the active run', async () => {
    const id = await makeVersion();
    const r = await claimed(id);
    const before = (await db.documentVersion.findUniqueOrThrow({ where: { id } })).leaseExpiresAt!;
    expect(await renewLease(db, id, r.runId, LEASE_MS * 2)).toBe(true);
    const after = (await db.documentVersion.findUniqueOrThrow({ where: { id } })).leaseExpiresAt!;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    expect(await renewLease(db, id, crypto.randomUUID())).toBe(false);
  });
});

describe('saveParsedText', () => {
  it('writes once, only for the active run', async () => {
    const id = await makeVersion();
    const r = await claimed(id);
    await saveParsedText(db, id, crypto.randomUUID(), { parsedText: 'stale', pageOffsets: [0] });
    expect((await db.documentVersion.findUniqueOrThrow({ where: { id } })).parsedText).toBeNull();
    await saveParsedText(db, id, r.runId, { parsedText: 'hello', pageOffsets: [0, 3] });
    await saveParsedText(db, id, r.runId, { parsedText: 'other', pageOffsets: [0] });
    expect(await db.documentVersion.findUniqueOrThrow({ where: { id } })).toMatchObject({
      parsedText: 'hello',
      pageOffsets: [0, 3],
    });
  });
});

describe('finishVersion', () => {
  it('a stale run cannot write; the re-claimed run finishes', async () => {
    const id = await makeVersion();
    const oldRun = await claimed(id);
    const newRun = await claimed(id, { now: new Date(Date.now() + LEASE_MS + 1000) });

    expect(await finishVersion(db, id, oldRun.runId, allValues)).toBe('stale');
    expect(await db.extractedValue.count()).toBe(0);
    expect((await db.extractionRun.findUniqueOrThrow({ where: { id: oldRun.runId } })).status).toBe(
      'abandoned',
    );

    expect(await finishVersion(db, id, newRun.runId, allValues)).toBe('finished');
    expect(await db.extractedValue.count()).toBe(fields.length);
    const row = await db.documentVersion.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'extracted', leaseExpiresAt: null });
    const run = await db.extractionRun.findUniqueOrThrow({ where: { id: newRun.runId } });
    expect(run.status).toBe('succeeded');
    expect(run.finishedAt).not.toBeNull();
  });

  it('with two runs holding valid ids, only the active one writes', async () => {
    const id = await makeVersion();
    const a = await claimed(id);
    const b = await claimed(id, { now: new Date(Date.now() + LEASE_MS + 1000) });
    const results = await Promise.all([
      finishVersion(db, id, a.runId, allValues),
      finishVersion(db, id, b.runId, allValues),
    ]);
    expect([...results].sort()).toEqual(['finished', 'stale']);
    expect(await db.extractedValue.count()).toBe(fields.length);
  });

  it('second finish by the active run is stale and writes nothing more', async () => {
    const id = await makeVersion();
    const r = await claimed(id);
    expect(await finishVersion(db, id, r.runId, allValues)).toBe('finished');
    expect(await finishVersion(db, id, r.runId, allValues)).toBe('stale');
    expect(await db.extractedValue.count()).toBe(fields.length);
    // a late duplicate must not rewrite the succeeded run as abandoned
    expect((await db.extractionRun.findUniqueOrThrow({ where: { id: r.runId } })).status).toBe(
      'succeeded',
    );
  });

  it('stores a gap value; the DB CHECK rejects value + gap reason together', async () => {
    const id = await makeVersion();
    const r = await claimed(id);
    expect(await finishVersion(db, id, r.runId, [value('vendor', null)])).toBe('finished');
    expect(await db.extractedValue.findFirstOrThrow({ where: { versionId: id } })).toMatchObject({
      value: null,
      gapReason: 'not found',
    });
    await expect(
      db.extractedValue.create({
        data: { versionId: id, field: 'bad', value: 'v', gapReason: 'also gap' },
      }),
    ).rejects.toThrow();
  });
});

describe('failVersion', () => {
  it('fails the active run', async () => {
    const id = await makeVersion();
    const r = await claimed(id);
    expect(await failVersion(db, id, r.runId, 'boom')).toBe(true);
    expect(await db.documentVersion.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'failed',
      error: 'boom',
      activeRunId: null,
      leaseExpiresAt: null,
    });
    const run = await db.extractionRun.findUniqueOrThrow({ where: { id: r.runId } });
    expect(run).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('a stale run returns false and leaves the row unchanged', async () => {
    const id = await makeVersion();
    const r = await claimed(id);
    const before = await db.documentVersion.findUniqueOrThrow({ where: { id } });
    expect(await failVersion(db, id, crypto.randomUUID(), 'nope')).toBe(false);
    expect(await db.documentVersion.findUniqueOrThrow({ where: { id } })).toEqual(before);
    expect((await db.extractionRun.findUniqueOrThrow({ where: { id: r.runId } })).status).toBe(
      'running',
    );
  });
});

describe('handOffVersion', () => {
  it('requeues without burning an attempt and can be claimed at once', async () => {
    const id = await makeVersion();
    const r = await claimed(id);
    expect(await handOffVersion(db, id, r.runId)).toBe(true);
    expect(await db.documentVersion.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'queued',
      attempts: 0,
      activeRunId: null,
      leaseExpiresAt: null,
    });
    expect((await db.extractionRun.findUniqueOrThrow({ where: { id: r.runId } })).status).toBe(
      'abandoned',
    );
    const again = await claimVersion(db, id, opts);
    expect(again.kind).toBe('claimed');
  });

  it('a stale run cannot hand off', async () => {
    const id = await makeVersion();
    await claimed(id);
    expect(await handOffVersion(db, id, crypto.randomUUID())).toBe(false);
    expect((await db.documentVersion.findUniqueOrThrow({ where: { id } })).attempts).toBe(1);
  });
});

describe('findReconcilable', () => {
  it('returns queued and expired-lease versions only', async () => {
    const queued = await makeVersion();
    const live = await makeVersion();
    const expired = await makeVersion();
    const done = await makeVersion();
    const failed = await makeVersion();
    const superseded = await makeVersion();
    await claimed(live);
    await claimed(expired);
    await db.documentVersion.update({
      where: { id: expired },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    for (const [id, status] of [
      [done, 'extracted'],
      [failed, 'failed'],
      [superseded, 'superseded'],
    ] as const) {
      await db.documentVersion.update({ where: { id }, data: { status } });
    }
    const found = await findReconcilable(db);
    expect(found.map((f) => f.id).sort()).toEqual([queued, expired].sort());
    expect(found.find((f) => f.id === expired)!.attempts).toBe(1);
  });
});

describe('chunk plan and results', () => {
  const plan = {
    chunks: [
      { index: 0, start: 0, end: 10, tokens: 3, firstPage: 1, lastPage: 1 },
      { index: 1, start: 10, end: 20, tokens: 4, firstPage: 1, lastPage: 2 },
    ],
    totalTokens: 7,
    charsPerToken: 2.5,
  };

  it('saveChunkPlan twice leaves the first plan unchanged', async () => {
    const id = await makeVersion();
    await saveChunkPlan(db, id, plan);
    await saveChunkPlan(db, id, {
      chunks: [
        { index: 0, start: 0, end: 99, tokens: 9, firstPage: 1, lastPage: 1 },
        ...plan.chunks.slice(1),
      ],
      totalTokens: 99,
      charsPerToken: 9,
    });
    const state = await getChunkState(db, id, 'p1');
    expect(state.chunks.map((c) => [c.chunkIndex, c.end])).toEqual([
      [0, 10],
      [1, 20],
    ]);
    expect(await db.documentVersion.findUniqueOrThrow({ where: { id } })).toMatchObject({
      totalTokens: 7,
      charsPerToken: 2.5,
    });
  });

  it('saveChunkResult twice with the same key keeps one row; getChunkState filters by prompt', async () => {
    const id = await makeVersion();
    const r = await claimed(id);
    const candidates: Candidate[] = [{ field: 'vendor', kind: 'gap', reason: 'none' }];
    const row = {
      versionId: id,
      chunkIndex: 0,
      promptVersion: 'p1',
      runId: r.runId,
      prompt: 'first',
      rawResponse: { a: 1 },
      candidates,
    };
    await saveChunkResult(db, row);
    await saveChunkResult(db, { ...row, prompt: 'second' });
    await saveChunkResult(db, { ...row, promptVersion: 'p2' });
    const state = await getChunkState(db, id, 'p1');
    expect(state.results.size).toBe(1);
    expect(state.results.get(0)!.prompt).toBe('first');
    expect(await db.chunkResult.count()).toBe(2);
  });
});
