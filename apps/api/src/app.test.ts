import { describe, expect, it } from 'vitest';
import { buildApp, type Deps } from './app.js';

const ok = async () => {};
const fail = async () => {
  throw new Error('down');
};
const deps = (overrides: Partial<Deps> = {}): Deps => ({
  pingDb: ok,
  pingRedis: ok,
  close: ok,
  // Health tests never touch these.
  db: {} as Deps['db'],
  files: {} as Deps['files'],
  fields: { invoice: [], lease: [], market_report: [] },
  enqueue: ok,
  ...overrides,
});

describe('GET /health', () => {
  it('is 200 when PG and Redis respond', async () => {
    const res = await buildApp(deps()).inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pg: 'ok', redis: 'ok' });
  });

  it('is 503 and names the failing dependency', async () => {
    const res = await buildApp(deps({ pingRedis: fail })).inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ pg: 'ok', redis: 'down' });
  });
});
