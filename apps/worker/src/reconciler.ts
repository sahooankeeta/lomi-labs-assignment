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
 * Passes never overlap and never hang forever. During a Redis outage the queue's `add`
 * can wait indefinitely (the connection retries without limit), so a tick that fires
 * while a pass is still running is skipped, and a pass is abandoned after `timeoutMs`
 * (default `intervalMs`) with a warning. Adds from an abandoned pass may still complete
 * later; that is harmless for the same dedupe reasons. Without these bounds each tick
 * would pile another hung pass (and query) on top, growing memory for the whole outage.
 *
 * The timer does not fire at start: call `runOnce()` yourself for an immediate pass.
 * After `stop()` the timer is cancelled, no new pass starts and `runOnce()` returns 0.
 */
export function startReconciler(deps: {
  db: Db;
  enqueue(versionId: string, attempts: number): Promise<void>;
  log: Logger;
  intervalMs?: number;
  /** Longest a pass may run before it is abandoned (default: `intervalMs`). */
  timeoutMs?: number;
}): { stop(): void; runOnce(): Promise<number> } {
  const { db, enqueue, log } = deps;
  const intervalMs = deps.intervalMs ?? 10_000;
  const timeoutMs = deps.timeoutMs ?? intervalMs;
  let running = false;
  let stopped = false;

  /**
   * One pass. Returns how many adds completed successfully. Returns 0 without doing
   * anything if a pass is already in flight or the reconciler is stopped, and 0 (after
   * a warning) if the pass timed out; an abandoned pass starts no further adds. A
   * failing enqueue is logged and does not affect the others (the next pass retries
   * it); a failing database query rejects, which the timer logs.
   */
  async function runOnce(): Promise<number> {
    if (stopped) return 0;
    if (running) {
      log.debug('reconciler: previous pass still running; skipping');
      return 0;
    }
    running = true;
    let abandoned = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const pass = (async (): Promise<number> => {
        const pending = await findReconcilable(db);
        let done = 0;
        await Promise.all(
          pending.map(async ({ id, attempts }) => {
            if (abandoned) return;
            try {
              await enqueue(id, attempts);
              done++;
            } catch (err) {
              log.warn({ versionId: id, ...errInfo(err) }, 'reconciler: enqueue failed');
            }
          }),
        );
        if (done > 0) log.info({ count: done }, 'reconciler: enqueued');
        return done;
      })();
      const result = await Promise.race([pass, timeout]);
      if (result === 'timeout') {
        abandoned = true;
        // The abandoned pass may still reject later; it must not become unhandled.
        pass.catch(() => {});
        log.warn({ timeoutMs }, 'reconciler: pass timed out (Redis unreachable?); abandoned');
        return 0;
      }
      return result;
    } finally {
      clearTimeout(timer);
      running = false;
    }
  }

  const timer = setInterval(() => {
    runOnce().catch((err: unknown) => log.error(errInfo(err), 'reconciler pass failed'));
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    runOnce,
  };
}
