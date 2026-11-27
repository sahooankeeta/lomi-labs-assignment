import type { DocumentType } from '@lomi/shared';
import type { Db } from './client.js';

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
 * (`extract:<versionId>:<attempts>`) after `true`; the reconciler covers a lost hint.
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
