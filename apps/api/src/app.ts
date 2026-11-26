import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { LogController } from 'fastify';
import { createLogger, type Logger } from '@lomi/logger';

/** Anything the health check can ping. Kept abstract so tests can fake it. */
export interface Deps {
  pingDb: () => Promise<void>;
  pingRedis: () => Promise<void>;
  close: () => Promise<void>;
}

export function buildApp(deps: Deps, log: Logger = createLogger('api')) {
  const app = Fastify({
    loggerInstance: log,
    // No per-request logs; only startup/connection status and errors.
    logController: new LogController({ disableRequestLogging: true }),
  });

  // Disabling request logging also silences Fastify's error-handler logs, so log errors here.
  app.addHook('onError', async (req, _reply, err) => {
    req.log.error({ err, method: req.method, url: req.url }, 'handler error');
  });

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
