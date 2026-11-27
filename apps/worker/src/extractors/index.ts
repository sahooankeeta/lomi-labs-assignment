import { ClaudeExtractor } from './claude.js';
import { FakeExtractor } from './fake.js';
import { MissingKeyExtractor } from './missing-key.js';
import type { Extractor } from './types.js';

export * from './types.js';
export { ClaudeExtractor, FakeExtractor, MissingKeyExtractor };

/** Parses a non-negative integer env value; anything else yields `fallback`. */
function intEnv(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Picks the extractor from the environment. Never throws.
 * - `EXTRACTOR=fake` -> FakeExtractor, delay `FAKE_EXTRACTOR_DELAY_MS` (default 0).
 * - no (or blank) `ANTHROPIC_API_KEY` -> MissingKeyExtractor (calls reject clearly).
 * - otherwise ClaudeExtractor with `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`) and
 *   `LLM_MAX_INFLIGHT` (default 4; non-numeric or < 1 falls back to 4).
 */
export function createExtractor(env: NodeJS.ProcessEnv): Extractor {
  if (env.EXTRACTOR === 'fake') {
    return new FakeExtractor({ delayMs: intEnv(env.FAKE_EXTRACTOR_DELAY_MS, 0) });
  }
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return new MissingKeyExtractor();
  return new ClaudeExtractor({
    apiKey,
    model: env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-5-5',
    maxInflight: intEnv(env.LLM_MAX_INFLIGHT, 4) || 4,
  });
}
