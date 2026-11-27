import type { Candidate, DocumentType, FinalValue } from '@lomi/shared';
import type { Db } from './client.js';
import type { ChunkResult, VersionChunk } from './generated/client.js';

/**
 * Worker coordination: how a worker claims a version, keeps it, and ends its run
 * exactly once.
 *
 * Postgres is the source of truth and BullMQ jobs are only hints, so a job may arrive
 * late, twice, or after another worker took over. Every write here is therefore guarded
 * by the version's `activeRunId` (the one run allowed to write) and `status`, inside the
 * UPDATE itself, never as a read followed by a write. A stale or duplicate run gets a
 * `false`/`'stale'`/`'skipped'` back and changes nothing.
 *
 * None of these functions touch Redis. The caller (the worker) decides what to enqueue
 * next, always after the call returns.
 */

/** How long a claim or renewal keeps the version before another worker may take it. */
export const LEASE_MS = 30_000;
/** A version whose lease expired this many times is failed instead of claimed again. */
export const MAX_ATTEMPTS = 3;

export interface ClaimedVersion {
  id: string;
  documentId: string;
  type: DocumentType;
  fileKey: string;
  /** Null until `saveParsedText` has run for this version. */
  parsedText: string | null;
  pageOffsets: number[];
  /** Includes this claim. */
  attempts: number;
}

export type ClaimResult =
  | { kind: 'claimed'; runId: string; version: ClaimedVersion }
  | { kind: 'skipped' }
  | { kind: 'capped' };

/**
 * Tries to take the version for one extraction run.
 *
 * Eligible = `queued`, or `extracting` with an expired lease (the previous worker died
 * or stalled).
 * - Eligible and `attempts < MAX_ATTEMPTS`: sets `extracting`, a fresh `activeRunId`, a
 *   lease of `leaseMs`, `attempts + 1`, and records a `running` ExtractionRun. -> `claimed`.
 * - Eligible and `attempts >= MAX_ATTEMPTS`: marks the version `failed` with
 *   "extraction was interrupted 3 times". -> `capped`. The caller does nothing further.
 * - Anything else (live lease, extracted, failed, superseded, missing): -> `skipped`.
 *
 * Eligibility is checked inside a single conditional UPDATE, so two workers racing for
 * the same version get exactly one `claimed`; the loser sees count 0 and `skipped`.
 * Re-claiming over an expired lease replaces `activeRunId`, which is what locks the old
 * run out of every later write.
 */
export async function claimVersion(
  db: Db,
  versionId: string,
  opts: { model: string; leaseMs?: number; now?: Date },
): Promise<ClaimResult> {
  const now = opts.now ?? new Date();
  const leaseMs = opts.leaseMs ?? LEASE_MS;
  // Same predicate for claim and cap: "nobody currently holds a live lease".
  const eligible = {
    id: versionId,
    OR: [
      { status: 'queued' as const },
      { status: 'extracting' as const, leaseExpiresAt: { lt: now } },
    ],
  };

  // The run id is chosen up front so the UPDATE can store it as activeRunId before the
  // run row exists; both happen in one transaction.
  const runId = crypto.randomUUID();
  const claimed = await db.$transaction(async (tx) => {
    const { count } = await tx.documentVersion.updateMany({
      where: { ...eligible, attempts: { lt: MAX_ATTEMPTS } },
      data: {
        status: 'extracting',
        activeRunId: runId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        attempts: { increment: 1 },
      },
    });
    if (count === 0) return null;
    await tx.extractionRun.create({ data: { id: runId, versionId, model: opts.model } });
    return tx.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
  });
  if (claimed) {
    return {
      kind: 'claimed',
      runId,
      version: {
        id: claimed.id,
        documentId: claimed.documentId,
        type: (await db.document.findUniqueOrThrow({ where: { id: claimed.documentId } })).type,
        fileKey: claimed.fileKey,
        parsedText: claimed.parsedText,
        pageOffsets: claimed.pageOffsets,
        attempts: claimed.attempts,
      },
    };
  }

  const capped = await db.documentVersion.updateMany({
    where: { ...eligible, attempts: { gte: MAX_ATTEMPTS } },
    data: {
      status: 'failed',
      error: `extraction was interrupted ${MAX_ATTEMPTS} times`,
      activeRunId: null,
      leaseExpiresAt: null,
    },
  });
  return capped.count === 1 ? { kind: 'capped' } : { kind: 'skipped' };
}

/**
 * Pushes the lease out to now + `leaseMs`. Returns `false` when `runId` is no longer
 * the active run of an `extracting` version (lease taken over, finished, failed): the
 * worker must stop and write nothing more.
 */
export async function renewLease(
  db: Db,
  versionId: string,
  runId: string,
  leaseMs: number = LEASE_MS,
): Promise<boolean> {
  const { count } = await db.documentVersion.updateMany({
    where: { id: versionId, activeRunId: runId, status: 'extracting' },
    data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
  });
  return count === 1;
}

/**
 * Stores the version's parsed text and page offsets, once. Written only when
 * `parsedText` is still null and `runId` is the active run, so text is never rewritten
 * (evidence offsets for this version always index into it) and a stale run can't set it.
 * A call that doesn't qualify is a silent no-op; the caller re-reads the version if it
 * needs to know.
 */
export async function saveParsedText(
  db: Db,
  versionId: string,
  runId: string,
  parsed: { parsedText: string; pageOffsets: number[] },
): Promise<void> {
  await db.documentVersion.updateMany({
    where: { id: versionId, activeRunId: runId, status: 'extracting', parsedText: null },
    data: { parsedText: parsed.parsedText, pageOffsets: parsed.pageOffsets },
  });
}

/**
 * Ends the active run with an error: version -> `failed`, run -> `failed`. Returns
 * `false` (and changes nothing) if `runId` isn't the active run of an `extracting`
 * version. The user can retry a failed version through the api (`retryCurrentVersion`).
 */
export async function failVersion(
  db: Db,
  versionId: string,
  runId: string,
  error: string,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const { count } = await tx.documentVersion.updateMany({
      where: { id: versionId, activeRunId: runId, status: 'extracting' },
      data: { status: 'failed', error, activeRunId: null, leaseExpiresAt: null },
    });
    if (count === 0) return false;
    await tx.extractionRun.updateMany({
      where: { id: runId, status: 'running' },
      data: { status: 'failed', error, finishedAt: new Date() },
    });
    return true;
  });
}

/**
 * Graceful shutdown (SIGTERM): returns the version to `queued` so another worker can
 * take it immediately, and marks the run `abandoned`. `attempts` is decremented so a
 * planned handoff doesn't use up the version's attempt budget. Returns `false` and
 * changes nothing for a stale run. The caller enqueues a new job
 * (`extract:<versionId>:<attempts>`) after `true`. Because `attempts` went back down, that
 * id can equal the job this worker is still running, and BullMQ drops an add whose id is
 * still active. That is fine: once the running job finishes and is removed, the reconciler
 * re-adds it within seconds, and a double delivery is harmless since `claimVersion`
 * returns `skipped` for a live lease.
 */
export async function handOffVersion(db: Db, versionId: string, runId: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const { count } = await tx.documentVersion.updateMany({
      where: { id: versionId, activeRunId: runId, status: 'extracting' },
      data: {
        status: 'queued',
        attempts: { decrement: 1 },
        activeRunId: null,
        leaseExpiresAt: null,
      },
    });
    if (count === 0) return false;
    await tx.extractionRun.updateMany({
      where: { id: runId, status: 'running' },
      data: { status: 'abandoned', finishedAt: new Date() },
    });
    return true;
  });
}

/**
 * Versions that need a (new) job: `queued`, or `extracting` with an expired lease. The
 * reconciler enqueues one `extract:<id>:<attempts>` job for each; `claimVersion` decides
 * whether the job actually runs, so over-reporting here is harmless.
 */
export async function findReconcilable(
  db: Db,
  now: Date = new Date(),
): Promise<{ id: string; attempts: number }[]> {
  return db.documentVersion.findMany({
    where: {
      OR: [{ status: 'queued' }, { status: 'extracting', leaseExpiresAt: { lt: now } }],
    },
    select: { id: true, attempts: true },
  });
}

export interface ChunkPlan {
  chunks: {
    index: number;
    start: number;
    end: number;
    tokens: number;
    firstPage: number;
    lastPage: number;
  }[];
  totalTokens: number;
  charsPerToken: number;
}

/**
 * Stores the chunk plan, written once per version, all or nothing. The guarded UPDATE
 * that sets the token totals (only while null) decides who wrote first: only that call
 * inserts chunk rows, so a later plan (even a longer one) can't add extra indexes next to
 * the first plan's rows. A resumed or duplicate run therefore always sees the first
 * run's plan, so cached chunk results still line up with their chunk indexes.
 */
export async function saveChunkPlan(db: Db, versionId: string, plan: ChunkPlan): Promise<void> {
  await db.$transaction(async (tx) => {
    const { count } = await tx.documentVersion.updateMany({
      where: { id: versionId, totalTokens: null },
      data: { totalTokens: plan.totalTokens, charsPerToken: plan.charsPerToken },
    });
    // A plan already exists: leave it untouched.
    if (count === 0) return;
    await tx.versionChunk.createMany({
      data: plan.chunks.map((c) => ({
        versionId,
        chunkIndex: c.index,
        start: c.start,
        end: c.end,
        tokens: c.tokens,
        firstPage: c.firstPage,
        lastPage: c.lastPage,
      })),
    });
  });
}

/**
 * The saved plan (ordered by index) and the stored results for `promptVersion`, keyed
 * by chunk index. A resumed run calls only the chunks missing from `results`; results
 * from another prompt version are ignored.
 */
export async function getChunkState(
  db: Db,
  versionId: string,
  promptVersion: string,
): Promise<{ chunks: VersionChunk[]; results: Map<number, ChunkResult> }> {
  const [chunks, rows] = await Promise.all([
    db.versionChunk.findMany({ where: { versionId }, orderBy: { chunkIndex: 'asc' } }),
    db.chunkResult.findMany({ where: { versionId, promptVersion } }),
  ]);
  return { chunks, results: new Map(rows.map((r) => [r.chunkIndex, r])) };
}

/**
 * Stores one chunk's LLM answer. Results are keyed by (version, chunk, promptVersion),
 * not by run, so a later run reuses them; if the key exists the first answer wins
 * (`skipDuplicates`) and the duplicate is dropped without error. Candidates are the
 * validated output; `rawResponse` is kept for debugging.
 */
export async function saveChunkResult(
  db: Db,
  row: {
    versionId: string;
    chunkIndex: number;
    promptVersion: string;
    runId: string;
    prompt: string;
    rawResponse: unknown;
    candidates: Candidate[];
  },
): Promise<void> {
  await db.chunkResult.createMany({
    data: [
      {
        versionId: row.versionId,
        chunkIndex: row.chunkIndex,
        promptVersion: row.promptVersion,
        runId: row.runId,
        prompt: row.prompt,
        rawResponse: row.rawResponse as object,
        candidates: row.candidates as object[],
      },
    ],
    skipDuplicates: true,
  });
}

/**
 * Writes the final values and completes the run, exactly once.
 *
 * In one transaction: a guarded UPDATE (id, `activeRunId = runId`, status `extracting`)
 * moves the version to `extracted` and clears the lease. Only if that matched a row are
 * the values inserted (unique per version+field, `skipDuplicates`) and the run marked
 * `succeeded`. Previous-version carry-over is Phase 3, so `previousValueId` and
 * `carriedReviewId` stay null.
 *
 * - `'finished'`: the caller may enqueue follow-up work.
 * - `'stale'`: another run owns the version, or it was already finished/failed. Nothing
 *   was written; the run is marked `abandoned` (if still running) and the caller stops.
 */
export async function finishVersion(
  db: Db,
  versionId: string,
  runId: string,
  values: FinalValue[],
): Promise<'finished' | 'stale'> {
  const finished = await db.$transaction(async (tx) => {
    const { count } = await tx.documentVersion.updateMany({
      where: { id: versionId, activeRunId: runId, status: 'extracting' },
      data: { status: 'extracted', leaseExpiresAt: null },
    });
    // Nothing was written yet, so leaving the transaction here is the rollback.
    if (count === 0) return false;

    await tx.extractedValue.createMany({
      data: values.map((v) => ({
        versionId,
        field: v.field,
        value: v.value,
        evidence: v.evidence,
        gapReason: v.gapReason,
        candidates: v.candidates ?? undefined,
        evidencePage: v.evidencePage,
        evidenceStart: v.evidenceStart,
        evidenceEnd: v.evidenceEnd,
      })),
      skipDuplicates: true,
    });
    await tx.extractionRun.updateMany({
      where: { id: runId },
      data: { status: 'succeeded', finishedAt: new Date() },
    });
    return true;
  });
  if (finished) return 'finished';

  // Outside the transaction on purpose: only a run still `running` is abandoned, so a
  // duplicate finish can't overwrite an earlier `succeeded`.
  await db.extractionRun.updateMany({
    where: { id: runId, status: 'running' },
    data: { status: 'abandoned', finishedAt: new Date() },
  });
  return 'stale';
}
