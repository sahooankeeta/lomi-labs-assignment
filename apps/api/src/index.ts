import { createDb } from '@lomi/db';
import { createExtractionQueue, redisConnection } from '@lomi/queue';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const prisma = createDb(env.DATABASE_URL);
const redis = redisConnection(env.REDIS_URL);
const queue = createExtractionQueue(redis);

const app = buildApp({
  pingDb: async () => {
    await prisma.$queryRaw`select 1`;
  },
  pingRedis: async () => {
    // Commands queue up while Redis is down (maxRetriesPerRequest: null), so bound the wait.
    await Promise.race([
      redis.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('redis ping timeout')), 1_000)),
    ]);
  },
  close: async () => {
    await queue.close();
    await redis.quit();
    await prisma.$disconnect();
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: '0.0.0.0', port: env.API_PORT });
