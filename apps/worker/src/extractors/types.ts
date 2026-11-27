import type { DocumentType, FieldDef } from '@lomi/shared';

/** One chunk-extraction request. `prompt` is built by `@lomi/extraction`'s `buildPrompt`. */
export interface ExtractRequest {
  type: DocumentType;
  fields: FieldDef[];
  chunkText: string;
  prompt: { system: string; user: string };
}

/**
 * The worker's only boundary to an LLM. Implementations: Claude, a deterministic fake,
 * and a missing-key stub. Callers must not assume `output` is valid: pass it to
 * `validateChunkOutput`, which checks shape and evidence.
 */
export interface Extractor {
  /** Model id recorded with stored results ('fake' for the fake extractor). */
  readonly model: string;
  /** Token count of `text`. Rejects on transport/API errors (or a missing key). */
  countTokens(text: string): Promise<number>;
  /**
   * Extracts fields for one chunk. Rejects on API errors, timeouts, an unusable model
   * response (refusal, truncation, unparseable) or when `opts.signal` aborts.
   * `raw` is the provider response, kept for audit.
   */
  extract(
    req: ExtractRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<{ output: unknown; raw: unknown }>;
}
