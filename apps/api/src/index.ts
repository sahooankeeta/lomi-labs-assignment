import { createDb } from '@lomi/db';
import { LocalFileStore } from '@lomi/files';
import { createLogger, describeUrl, errInfo, logConnections } from '@lomi/logger';
import { createExtractionQueue, enqueueExtraction, redisConnection } from '@lomi/queue';
import { loadExpectedFields } from '@lomi/shared/node';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

/**
 * API process entry point.
 *
 * Loads configuration, creates shared infrastructure clients, builds the Fastify
 * app, and starts the HTTP server. Postgres is the source of truth; Redis and
 * BullMQ are used only for extraction job hints.
 */
const log = createLogger('api');
const env = loadEnv();
const prisma = createDb(env.DATABASE_URL);
const redis = redisConnection(env.REDIS_URL, log);
const queue = createExtractionQueue(redis, log);

/** Reports whether Postgres can execute a minimal query. */
const pingDb = async () => {
  await prisma.$queryRaw`select 1`;
};

/** Reports whether Redis responds, with a bounded wait for the health check. */
const pingRedis = async () => {
  // Commands queue up while Redis is down (maxRetriesPerRequest: null), so bound the wait.
  await Promise.race([
    redis.ping(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('redis ping timeout')), 2_000)),
  ]);
};

/**
 * Creates the API dependencies.
 *
 * The real implementations are injected through `Deps` so application routes
 * and health checks can be tested without external services.
 */
const app = buildApp(
  {
    pingDb,
    pingRedis,
    db: prisma,
    files: new LocalFileStore(env.UPLOAD_DIR),
    fields: loadExpectedFields(),
    enqueue: (versionId, attempts) => enqueueExtraction(queue, versionId, attempts),
    /** Closes infrastructure resources in reverse dependency order. */
    close: async () => {
      await queue.close();
      await redis.quit();
      await prisma.$disconnect();
    },
  },
  log,
);

// Make shutdown explicit and orderly for both container and local-process signals.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}

// Log rejected promises that have no route or caller to handle their error.
process.on('unhandledRejection', (err) => log.error(errInfo(err), 'unhandled rejection'));

// Listen on all interfaces so the API is reachable from Docker and local clients.
await app.listen({
  host: '0.0.0.0',
  port: env.API_PORT,
  listenTextResolver: (address) => `api listening on ${address}`,
});
log.info(`api on your machine: ${env.PUBLIC_URL}`);

// Run and log Postgres/Redis connection checks after the HTTP server is ready.
await logConnections(log, [
  { name: 'postgres', target: describeUrl(env.DATABASE_URL), ping: pingDb },
  { name: 'redis', target: describeUrl(env.REDIS_URL), ping: pingRedis },
]);
