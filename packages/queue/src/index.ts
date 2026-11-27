import { Queue } from 'bullmq';
import type { Logger } from '@lomi/logger';
import { Redis } from 'ioredis';

/**
 * Redis only coordinates work. A job carries just a version id; everything a
 * user can see (status, values, errors) lives in Postgres. If Redis is flushed,
 * the queue can be rebuilt from versions that Postgres still marks unfinished.
 */
export const EXTRACTION_QUEUE = 'extraction';

export interface ExtractionJob {
  versionId: string;
}

/**
 * BullMQ 6 treats ioredis as optional and, under native ESM, wants a client
 * instance rather than connection options. Each call returns a new client that
 * the caller owns and must `quit()`: BullMQ does not close clients passed in.
 */
export function redisConnection(url = process.env.REDIS_URL, log?: Logger): Redis {
  if (!url) throw new Error('REDIS_URL is not set');
  // maxRetriesPerRequest: null is required by BullMQ for blocking worker connections.
  const redis = new Redis(url, { maxRetriesPerRequest: null });
  if (log) {
    // ioredis emits `error` on every reconnect attempt; log transitions, not each retry.
    let down = false;
    // The first connect is reported by the startup check; this only logs reconnects.
    redis.on('ready', () => {
      if (down) log.info('redis reconnected');
      down = false;
    });
    redis.on('error', (err) => {
      if (!down) log.warn({ err: err.message }, 'redis connection lost, retrying');
      down = true;
    });
  }
  return redis;
}

/** Redis connection failures are logged once by `redisConnection`; skip the repeats. */
export const isRedisConnectionError = (err: Error) =>
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|Connection is closed/.test(err.message);

export const extractionJobOptions = {
  // Retries belong to the reconciler (it re-enqueues with a new attempt number), not BullMQ.
  attempts: 1,
  // Finished jobs are dropped at once. BullMQ ignores an add whose job id still exists, and job
  // ids are reused (handoff and retry both reset attempts, so `extract-<id>-0` comes back), so a
  // retained finished job would strand the version in `queued`. Dedupe must only cover
  // waiting/active jobs. History lives in Postgres `extraction_runs`.
  removeOnComplete: true,
  removeOnFail: true,
} as const;

export function createExtractionQueue(connection: Redis, log?: Logger) {
  const queue = new Queue<ExtractionJob>(EXTRACTION_QUEUE, {
    connection,
    defaultJobOptions: extractionJobOptions,
  });
  // Without a listener BullMQ prints raw stack traces for every reconnect attempt.
  queue.on('error', (err) => {
    if (!isRedisConnectionError(err)) log?.error({ err }, 'queue error');
  });
  return queue;
}

/**
 * One job per version attempt: re-adding the same attempt is a no-op while the job is waiting or active.
 * No `:` in the id: BullMQ only accepts one through a legacy 3-part exemption slated for removal.
 */
export const extractionJobId = (versionId: string, attempts: number) =>
  `extract-${versionId}-${attempts}`;

/**
 * Adds the job for one version attempt. Rejects on add failure (e.g. Redis unreachable):
 * callers log and rely on the reconciler, which re-enqueues any unfinished version from Postgres.
 */
export async function enqueueExtraction(
  queue: Queue<ExtractionJob>,
  versionId: string,
  attempts: number,
): Promise<void> {
  await queue.add('extract', { versionId }, { jobId: extractionJobId(versionId, attempts) });
}
