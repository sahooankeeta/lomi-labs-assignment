import type { ExtractRequest, Extractor } from './types.js';

const MESSAGE = 'ANTHROPIC_API_KEY is not set';

/**
 * Stand-in when no API key is configured. The worker still boots (so uploads, review and
 * the UI keep working), and each version fails with a clear message instead of the process
 * crashing at startup. Every call rejects with `ANTHROPIC_API_KEY is not set`.
 */
export class MissingKeyExtractor implements Extractor {
  readonly model = 'none';

  /** Always rejects with `ANTHROPIC_API_KEY is not set`. */
  countTokens(_text: string): Promise<number> {
    return Promise.reject(new Error(MESSAGE));
  }

  /** Always rejects with `ANTHROPIC_API_KEY is not set`. */
  extract(_req: ExtractRequest): Promise<{ output: unknown; raw: unknown }> {
    return Promise.reject(new Error(MESSAGE));
  }
}
