import { findReconcilable, type Db } from '@lomi/db';
import { errInfo, type Logger } from '@lomi/logger';

/**
 * Starts the reconciler: every `intervalMs` (default 10 s) it enqueues a job for each
 * version Postgres says is unfinished (`queued`, or `extracting` with an expired lease).
 *
 * Why it exists: Postgres is the source of truth and a BullMQ job is only a hint. A hint
 * is lost when the api's enqueue fails, when Redis is flushed or restarted, or when a
 * worker dies mid-run. This loop repairs all of those by re-deriving the work list from
 * Postgres. Over-enqueueing is harmless: job ids include the attempt number, so a
 * duplicate add is a no-op, and `claimVersion` turns any duplicate that runs into `skipped`.
 *
 * The timer does not fire at start: call `runOnce()` yourself for an immediate pass.
 * `stop()` cancels the timer; a pass already running finishes.
 */
export function startReconciler(deps: {
  db: Db;
  enqueue(versionId: string, attempts: number): Promise<void>;
  log: Logger;
  intervalMs?: number;
}): { stop(): void; runOnce(): Promise<number> } {
  const { db, enqueue, log } = deps;

  /**
   * One pass. Returns how many versions it tried to enqueue. A failing enqueue is logged
   * and does not stop the rest (the next pass retries it); a failing database query
   * rejects, which the timer logs.
   */
  async function runOnce(): Promise<number> {
    const pending = await findReconcilable(db);
    for (const { id, attempts } of pending) {
      try {
        await enqueue(id, attempts);
      } catch (err) {
        log.warn({ versionId: id, ...errInfo(err) }, 'reconciler: enqueue failed');
      }
    }
    if (pending.length > 0) log.info({ count: pending.length }, 'reconciler: enqueued');
    return pending.length;
  }

  const timer = setInterval(() => {
    runOnce().catch((err: unknown) => log.error(errInfo(err), 'reconciler pass failed'));
  }, deps.intervalMs ?? 10_000);

  return { stop: () => clearInterval(timer), runOnce };
}
