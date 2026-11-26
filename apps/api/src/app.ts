import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';

/** Anything the health check can ping. Kept abstract so tests can fake it. */
export interface Deps {
  pingDb: () => Promise<void>;
  pingRedis: () => Promise<void>;
  close: () => Promise<void>;
}

export function buildApp(deps: Deps) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  app.register(cors, { origin: true });
  app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

  // Close the PG pool and Redis connection when the server shuts down.
  app.addHook('onClose', async () => deps.close());

  app.get('/health', async (_req, reply) => {
    const [pg, redis] = await Promise.allSettled([deps.pingDb(), deps.pingRedis()]);
    const body = {
      pg: pg.status === 'fulfilled' ? 'ok' : 'down',
      redis: redis.status === 'fulfilled' ? 'ok' : 'down',
    };
    return reply.code(body.pg === 'ok' && body.redis === 'ok' ? 200 : 503).send(body);
  });

  return app;
}
