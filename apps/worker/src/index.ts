import { Worker } from 'bullmq';
import { createDb } from '@lomi/db';
import { LocalFileStore } from '@lomi/files';
import { createLogger, describeUrl, errInfo, logConnections } from '@lomi/logger';
import { loadExpectedFields } from '@lomi/shared/node';
import {
  createExtractionQueue,
  enqueueExtraction,
  EXTRACTION_QUEUE,
  isRedisConnectionError,
  redisConnection,
  type ExtractionJob,
} from '@lomi/queue';

import { createExtractor } from './extractors/index.js';
import { processVersion, type PipelineDeps } from './pipeline.js';
import { startReconciler } from './reconciler.js';

/**
 * Worker entry: BullMQ jobs (hints carrying a versionId) run `processVersion`; the
 * reconciler re-derives lost hints from Postgres. See README "Worker".
 */
const CONCURRENCY = 2;
const RECONCILE_MS = 10_000;
const log = createLogger('worker');
const prisma = createDb();
const redis = redisConnection(undefined, log);
const queue = createExtractionQueue(redis, log);
const extractor = createExtractor(process.env);
log.info(`extractor: ${extractor.constructor.name} (model ${extractor.model})`);

// Aborted on SIGTERM/SIGINT: in-flight runs hand their version back instead of finishing.
const shutdown = new AbortController();
const deps: PipelineDeps = {
  db: prisma,
  files: new LocalFileStore(process.env.UPLOAD_DIR ?? './uploads'),
  extractor,
  fields: loadExpectedFields(),
  log,
  signal: shutdown.signal,
  chunkConcurrency: Number.parseInt(process.env.CHUNK_CONCURRENCY ?? '', 10) || 3,
};

const worker = new Worker<ExtractionJob>(
  EXTRACTION_QUEUE,
  // Every outcome is a normal return: Postgres holds the result, BullMQ never retries.
  async (job) => {
    await processVersion(deps, job.data.versionId);
  },
  { connection: redis, concurrency: CONCURRENCY },
);

const reconciler = startReconciler({
  db: prisma,
  enqueue: (versionId, attempts) => enqueueExtraction(queue, versionId, attempts),
  log,
  intervalMs: RECONCILE_MS,
  isReady: () => redis.status === 'ready',
});

worker.on('ready', () =>
  log.info(`worker listening on queue "${EXTRACTION_QUEUE}" (concurrency ${CONCURRENCY})`),
);
worker.on('failed', (job, err) =>
  log.error({ jobId: job?.id, versionId: job?.data.versionId, ...errInfo(err) }, 'job failed'),
);
worker.on('stalled', (jobId) => log.warn({ jobId }, 'job stalled (worker lost its lock)'));
worker.on('error', (err) => {
  if (!isRedisConnectionError(err)) log.error(errInfo(err), 'worker error');
});

process.on('unhandledRejection', (err) => log.error(errInfo(err), 'unhandled rejection'));

await logConnections(log, [
  {
    name: 'postgres',
    target: describeUrl(process.env.DATABASE_URL),
    ping: () => prisma.$queryRaw`select 1`,
  },
  {
    name: 'redis',
    target: describeUrl(process.env.REDIS_URL),
    ping: () =>
      Promise.race([
        redis.ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 2_000)),
      ]),
  },
]);

// Immediate pass: a restart (or a flushed Redis) is repaired without waiting a full interval.
reconciler.runOnce().catch((err: unknown) => log.error(errInfo(err), 'initial reconcile failed'));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    log.info({ signal }, 'shutting down: handing in-flight versions back');
    shutdown.abort(); // in-flight runs hand off and return
    reconciler.stop();
    await worker.close(); // waits for those runs to finish handing off
    await queue.close();
    await redis.quit();
    await prisma.$disconnect();
    log.info('shutdown complete');
    process.exit(0);
  });
}
