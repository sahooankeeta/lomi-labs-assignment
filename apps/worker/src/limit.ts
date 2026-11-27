/** A bounded-concurrency gate. See {@link createLimiter}. */
export interface Limiter {
  /**
   * Runs `fn` once a slot is free (FIFO). Resolves/rejects with whatever `fn` does;
   * a rejection or synchronous throw frees the slot, so failures never leak capacity.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Tasks running right now. */
  readonly active: number;
  /** High-water mark of `active`, for tests and diagnostics. */
  readonly maxSeen: number;
}

/**
 * Creates a limiter allowing at most `n` tasks in flight; extra callers queue in order.
 * `n` is clamped to a minimum of 1 so a bad config value cannot deadlock the queue.
 */
export function createLimiter(n: number): Limiter {
  const max = Math.max(1, Math.floor(n) || 1);
  let active = 0;
  let maxSeen = 0;
  const waiting: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < max) {
      active++;
      maxSeen = Math.max(maxSeen, active);
      return;
    }
    // The releasing task hands its slot over directly (active stays constant),
    // so a late arrival cannot jump the queue between release and wake-up.
    await new Promise<void>((resolve) => waiting.push(resolve));
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get maxSeen() {
      return maxSeen;
    },
  };
}
