import type { Db } from '@lomi/db';
import type { Logger } from '@lomi/logger';
import { describe, expect, it, vi } from 'vitest';
import { startReconciler } from './reconciler.js';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

describe('startReconciler isReady', () => {
  it('skips the pass (no query, no enqueue) while the connection is not ready', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'v1', attempts: 0 }]);
    const db = { documentVersion: { findMany } } as unknown as Db;
    const enqueue = vi.fn().mockResolvedValue(undefined);
    let ready = false;
    const reconciler = startReconciler({
      db,
      enqueue,
      log,
      intervalMs: 3_600_000,
      isReady: () => ready,
    });
    try {
      expect(await reconciler.runOnce()).toBe(0);
      expect(findMany).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();

      ready = true;
      expect(await reconciler.runOnce()).toBe(1);
      expect(enqueue).toHaveBeenCalledWith('v1', 0);
    } finally {
      reconciler.stop();
    }
  });
});
