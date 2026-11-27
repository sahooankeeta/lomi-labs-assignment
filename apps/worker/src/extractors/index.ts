import { ClaudeExtractor } from './claude.js';
import { FakeExtractor } from './fake.js';
import { GeminiExtractor } from './gemini.js';
import { MissingKeyExtractor } from './missing-key.js';
import type { Extractor } from './types.js';

export * from './types.js';
export { ClaudeExtractor, FakeExtractor, GeminiExtractor, MissingKeyExtractor };

/** Parses a non-negative integer env value; anything else yields `fallback`. */
function intEnv(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Picks the extractor from the environment. Never throws.
 * - `EXTRACTOR=fake` -> FakeExtractor, delay `FAKE_EXTRACTOR_DELAY_MS` (default 0).
 * - `EXTRACTOR=gemini` -> GeminiExtractor (free tier) with `GEMINI_API_KEY` (blank ->
 *   MissingKeyExtractor `GEMINI_API_KEY is not set`), `GEMINI_MODEL` (default `gemini-3.6-flash`),
 *   `GEMINI_FALLBACK_MODELS` (comma separated, default `gemini-flash-lite-latest`) and `LLM_MAX_INFLIGHT`.
 * - any other `EXTRACTOR` except unset/`claude` -> MissingKeyExtractor saying it is unsupported.
 * - Claude (unset or `EXTRACTOR=claude`): no (or blank) `ANTHROPIC_API_KEY` -> MissingKeyExtractor
 *   (calls reject clearly); otherwise ClaudeExtractor with `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`) and
 *   `LLM_MAX_INFLIGHT` (default 4; non-numeric or < 1 falls back to 4).
 */
export function createExtractor(env: NodeJS.ProcessEnv): Extractor {
  if (env.EXTRACTOR === 'fake') {
    return new FakeExtractor({ delayMs: intEnv(env.FAKE_EXTRACTOR_DELAY_MS, 0) });
  }
  if (env.EXTRACTOR === 'gemini') {
    const geminiKey = env.GEMINI_API_KEY?.trim();
    if (!geminiKey) return new MissingKeyExtractor('GEMINI_API_KEY is not set');
    const model = env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash';
    const fallbackModels = env.GEMINI_FALLBACK_MODELS
      ? env.GEMINI_FALLBACK_MODELS.split(',')
          .map((m) => m.trim())
          .filter((m) => m && m !== model)
      : ['gemini-flash-lite-latest'];
    return new GeminiExtractor({
      apiKey: geminiKey,
      model,
      fallbackModels,
      maxInflight: intEnv(env.LLM_MAX_INFLIGHT, 4) || 4,
    });
  }
  if (env.EXTRACTOR && env.EXTRACTOR !== 'claude') {
    return new MissingKeyExtractor(
      `EXTRACTOR=${env.EXTRACTOR} is not supported (use claude, gemini or fake)`,
    );
  }
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return new MissingKeyExtractor();
  return new ClaudeExtractor({
    apiKey,
    model: env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-5-5',
    maxInflight: intEnv(env.LLM_MAX_INFLIGHT, 4) || 4,
  });
}
