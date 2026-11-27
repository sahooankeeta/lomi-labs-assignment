import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { LogController } from 'fastify';
import type { Db } from '@lomi/db';
import type { FileStore } from '@lomi/files';
import { createLogger, type Logger } from '@lomi/logger';
import type { ApiError, ExpectedFields } from '@lomi/shared';
import { ZodError } from 'zod';
import { HttpError } from './errors.js';
import { documentRoutes } from './routes/documents.js';

/**
 * Everything the api touches outside itself, injected so tests can fake the edges
 * (a real test database, a temp-dir file store, a spy for the queue).
 */
export interface Deps {
  /** Health check: resolves if Postgres answers, rejects otherwise. */
  pingDb: () => Promise<void>;
  /** Health check: resolves if Redis answers, rejects otherwise. */
  pingRedis: () => Promise<void>;
  /** Releases the PG pool, Redis and queue connections on shutdown. */
  close: () => Promise<void>;
  /** Postgres, the source of truth for documents, versions and values. */
  db: Db;
  /** Where uploaded PDFs live; written before the DB row that points at them. */
  files: FileStore;
  /** Expected fields per document type (`expected-fields.json`), for the read model's field order. */
  fields: ExpectedFields;
  /**
   * Hints the worker that a version needs extraction (job `extract-<versionId>-<attempts>`).
   * May reject (the real one is `enqueueExtraction`); the route logs it and does not wait,
   * because the worker's reconciler re-enqueues any unfinished version.
   */
  enqueue: (versionId: string, attempts: number) => Promise<void>;
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

  /**
   * The one error handler. `HttpError` and Zod validation errors become their status with
   * `{ error, message }`; multipart errors (file too large, not multipart) keep Fastify's
   * 4xx status; anything else is a bug or an outage: logged by the `onError` hook above and
   * answered with a generic 500 `internal` so internals never leak.
   */
  app.setErrorHandler((err: unknown, _req, reply) => {
    const send = (status: number, error: ApiError['error'], message: string) =>
      reply.code(status).send({ error, message } satisfies ApiError);

    if (err instanceof HttpError) return send(err.status, err.code, err.message);
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const where = issue?.path.join('.');
      return send(
        400,
        'bad_request',
        issue ? `${where ? `${where}: ` : ''}${issue.message}` : 'invalid request',
      );
    }
    const status = (err as { statusCode?: unknown }).statusCode;
    if (status === 413) return send(413, 'payload_too_large', 'file is larger than 20 MB');
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return send(400, 'bad_request', (err as Error).message);
    }
    return send(500, 'internal', 'internal server error');
  });

  // Unknown routes answer in the same { error, message } shape as every other error.
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: 'not_found',
      message: `Route ${req.method} ${req.url} not found`,
    } satisfies ApiError),
  );

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

  // Registered as a plugin so the routes see Fastify's default logger typing.
  app.register(async (scope) => documentRoutes(scope, deps));

  return app;
}
