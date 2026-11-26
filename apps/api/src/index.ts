import { createDb } from '@lomi/db';
import { createLogger, describeUrl, errInfo, logConnections } from '@lomi/logger';
import { createExtractionQueue, redisConnection } from '@lomi/queue';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

const log = createLogger('api');
const env = loadEnv();
const prisma = createDb(env.DATABASE_URL);
const redis = redisConnection(env.REDIS_URL, log);
const queue = createExtractionQueue(redis, log);

const pingDb = async () => {
  await prisma.$queryRaw`select 1`;
};
const pingRedis = async () => {
  // Commands queue up while Redis is down (maxRetriesPerRequest: null), so bound the wait.
  await Promise.race([
    redis.ping(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('redis ping timeout')), 2_000)),
  ]);
};

const app = buildApp(
  {
    pingDb,
    pingRedis,
    close: async () => {
      await queue.close();
      await redis.quit();
      await prisma.$disconnect();
    },
  },
  log,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}

process.on('unhandledRejection', (err) => log.error(errInfo(err), 'unhandled rejection'));

await app.listen({
  host: '0.0.0.0',
  port: env.API_PORT,
  listenTextResolver: (address) => `api listening on ${address}`,
});
log.info(`api on your machine: ${env.PUBLIC_URL}`);
await logConnections(log, [
  { name: 'postgres', target: describeUrl(env.DATABASE_URL), ping: pingDb },
  { name: 'redis', target: describeUrl(env.REDIS_URL), ping: pingRedis },
]);
