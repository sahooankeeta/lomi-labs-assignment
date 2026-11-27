import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ExtractionOutput } from '@lomi/shared';
import { createLimiter, type Limiter } from '../limit.js';
import type { ExtractRequest, Extractor } from './types.js';

const MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_INFLIGHT = 4;

/**
 * Extractor backed by Claude structured outputs (`messages.parse` + zod schema), so the
 * response is schema-constrained rather than coaxed through a forced tool call.
 */
export class ClaudeExtractor implements Extractor {
  readonly model: string;
  private readonly client: Pick<Anthropic, 'messages'>;
  // One limiter for countTokens AND extract: both draw on the same API rate limits, so
  // a single cap bounds total in-flight calls however the worker mixes them.
  private readonly limiter: Limiter;

  /**
   * @param opts.timeoutMs per-request timeout (default 60000); the SDK also retries transient errors.
   * @param opts.maxInflight max concurrent API calls across both methods (default 4).
   * @param opts.client replaces the real SDK client (tests); `apiKey` and `timeoutMs` are then unused.
   */
  constructor(opts: {
    apiKey: string;
    model: string;
    timeoutMs?: number;
    maxInflight?: number;
    client?: Pick<Anthropic, 'messages'>;
  }) {
    this.model = opts.model;
    this.client =
      opts.client ??
      new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    this.limiter = createLimiter(opts.maxInflight ?? DEFAULT_MAX_INFLIGHT);
  }

  /** Token count via the API. Rejects on API/transport errors. */
  countTokens(text: string): Promise<number> {
    return this.limiter.run(async () => {
      const res = await this.client.messages.countTokens({
        model: this.model,
        messages: [{ role: 'user', content: text }],
      });
      return res.input_tokens;
    });
  }

  /**
   * Rejects on API errors, timeout, abort, or an unusable response: `refusal` and
   * `max_tokens` (truncated JSON) or a null `parsed_output` throw
   * `model response unusable (stop_reason: X)`, so the chunk fails visibly rather than
   * silently turning into gaps.
   */
  extract(
    req: ExtractRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<{ output: unknown; raw: unknown }> {
    return this.limiter.run(async () => {
      const response = await this.client.messages.parse(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: req.prompt.system,
          messages: [{ role: 'user', content: req.prompt.user }],
          output_config: { format: zodOutputFormat(ExtractionOutput) },
        },
        { signal: opts?.signal },
      );
      const { stop_reason: stop, parsed_output: parsed } = response;
      if (stop === 'refusal' || stop === 'max_tokens' || parsed == null) {
        throw new Error(`model response unusable (stop_reason: ${stop ?? 'null'})`);
      }
      return { output: parsed, raw: response };
    });
  }
}
