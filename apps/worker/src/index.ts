import { Worker } from 'bullmq';
import { createDb } from '@lomi/db';
import { EXTRACTION_QUEUE, redisConnection, type ExtractionJob } from '@lomi/queue';

/**
 * Skeleton worker: receives extraction jobs and logs them.
 * Next step: parse PDF -> call Claude -> validate evidence -> write values to PG.
 */
const prisma = createDb();
const redis = redisConnection();

const worker = new Worker<ExtractionJob>(
  EXTRACTION_QUEUE,
  async (job) => {
    console.log(`[worker] job ${job.id} for version ${job.data.versionId} (not implemented yet)`);
  },
  { connection: redis, concurrency: 2 },
);

worker.on('ready', () => console.log('[worker] ready'));
worker.on('failed', (job, err) => console.error(`[worker] job ${job?.id} failed:`, err.message));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    console.log(`[worker] ${signal}, shutting down`);
    // close() waits for in-flight jobs; an interrupted job is retried by BullMQ.
    await worker.close();
    await redis.quit();
    await prisma.$disconnect();
    process.exit(0);
  });
}
