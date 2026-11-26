import { Worker } from 'bullmq';
import { createDb } from '@lomi/db';
import { createLogger, describeUrl, errInfo, logConnections } from '@lomi/logger';
import {
  EXTRACTION_QUEUE,
  isRedisConnectionError,
  redisConnection,
  type ExtractionJob,
} from '@lomi/queue';

/**
 * Skeleton worker: receives extraction jobs (no processing yet).
 * Next step: parse PDF -> call Claude -> validate evidence -> write values to PG.
 */
const CONCURRENCY = 2;
const log = createLogger('worker');
const prisma = createDb();
const redis = redisConnection(undefined, log);

const worker = new Worker<ExtractionJob>(
  EXTRACTION_QUEUE,
  async (_job) => {
    // Extraction lands in phase 1.
  },
  { connection: redis, concurrency: CONCURRENCY },
);

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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    log.info({ signal }, 'shutting down: waiting for in-flight jobs');
    // close() waits for in-flight jobs; an interrupted job is retried by BullMQ.
    await worker.close();
    await redis.quit();
    await prisma.$disconnect();
    log.info('shutdown complete');
    process.exit(0);
  });
}
