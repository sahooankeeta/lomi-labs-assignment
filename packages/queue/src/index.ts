import { Queue } from 'bullmq';
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
export function redisConnection(url = process.env.REDIS_URL): Redis {
  if (!url) throw new Error('REDIS_URL is not set');
  // maxRetriesPerRequest: null is required by BullMQ for blocking worker connections.
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function createExtractionQueue(connection: Redis) {
  return new Queue<ExtractionJob>(EXTRACTION_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: 1_000,
      removeOnFail: 1_000,
    },
  });
}

/** One job per version: re-adding the same version is a no-op while it's queued. */
export const extractionJobId = (versionId: string) => `extract:${versionId}`;
