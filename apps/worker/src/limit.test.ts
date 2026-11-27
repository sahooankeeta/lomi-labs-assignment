import { describe, expect, it } from 'vitest';
import { createLimiter } from './limit.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createLimiter', () => {
  it('never runs more than n tasks at once and resolves all', async () => {
    const limiter = createLimiter(3);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limiter.run(async () => {
          expect(limiter.active).toBeLessThanOrEqual(3);
          await sleep(5);
          return i;
        }),
      ),
    );
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(limiter.maxSeen).toBe(3);
    expect(limiter.active).toBe(0);
  });

  it('releases the slot when a task rejects', async () => {
    const limiter = createLimiter(1);
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(limiter.active).toBe(0);
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('releases the slot when a task throws synchronously', async () => {
    const limiter = createLimiter(1);
    await expect(
      limiter.run(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    await expect(limiter.run(async () => 1)).resolves.toBe(1);
  });
});
