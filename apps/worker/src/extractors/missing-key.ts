import type { ExtractRequest, Extractor } from './types.js';

const DEFAULT_MESSAGE = 'GEMINI_API_KEY is not set';

/**
 * Stand-in when no API key is configured. The worker still boots (so uploads, review and
 * the UI keep working), and each version fails with a clear message instead of the process
 * crashing at startup. Every call rejects with `message` (default `GEMINI_API_KEY is not set`;
 * the factory also uses it for an unsupported `EXTRACTOR` value).
 */
export class MissingKeyExtractor implements Extractor {
  readonly model = 'none';

  constructor(private readonly message: string = DEFAULT_MESSAGE) {}

  /** Always rejects with the configured message. */
  countTokens(_text: string): Promise<number> {
    return Promise.reject(new Error(this.message));
  }

  /** Always rejects with the configured message. */
  extract(_req: ExtractRequest): Promise<{ output: unknown; raw: unknown }> {
    return Promise.reject(new Error(this.message));
  }
}
