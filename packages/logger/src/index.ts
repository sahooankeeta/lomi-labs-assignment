import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

/**
 * One logger setup for every Node service (api, worker, seed).
 *
 * - Readable one-line text by default (pino-pretty), coloured in a terminal.
 * - LOG_FORMAT=json switches to JSON lines (for a log collector).
 * - Level from LOG_LEVEL (default `info`). Tests get `silent` unless LOG_LEVEL is set.
 * - Secrets are redacted wherever they appear in a logged object.
 */
export function createLogger(service: string, overrides: LoggerOptions = {}): Logger {
  const env = process.env;
  const level = env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info');
  const pretty = env.LOG_FORMAT !== 'json';

  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'apiKey',
        '*.apiKey',
        'headers.authorization',
        'headers["x-api-key"]',
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'ANTHROPIC_API_KEY',
        '*.ANTHROPIC_API_KEY',
      ],
      censor: '[redacted]',
    },
    ...(pretty && {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: Boolean(process.stdout.isTTY),
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname,service',
          messageFormat: '[{service}] {msg}',
        },
      },
    }),
    ...overrides,
  });
}

/** Turn an unknown thrown value into something pino serializes well. */
export const errInfo = (err: unknown) =>
  err instanceof Error ? { err } : { err: { message: String(err) } };

/** `postgres://user:pass@host:5432/db` → `host:5432/db` (never logs credentials). */
export function describeUrl(url: string | undefined): string {
  if (!url) return '(not set)';
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '(default port)'}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return '(invalid url)';
  }
}

/**
 * Startup check: ping each dependency once and log one line per result,
 * e.g. "postgres connected (postgres:5432/lomi)" or "redis NOT reachable (...)".
 * Never throws: the service keeps running and retries on its own.
 */
export async function logConnections(
  log: Logger,
  checks: { name: string; target: string; ping: () => Promise<unknown> }[],
): Promise<void> {
  await Promise.all(
    checks.map(async ({ name, target, ping }) => {
      try {
        await ping();
        log.info(`${name} connected (${target})`);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          `${name} NOT reachable (${target})`,
        );
      }
    }),
  );
}
