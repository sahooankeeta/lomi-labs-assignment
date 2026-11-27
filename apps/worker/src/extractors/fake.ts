import type { ExtractionOutput } from '@lomi/shared';
import type { ExtractRequest, Extractor } from './types.js';

/** field name -> regex whose first capture group is the value; the full match is the quote. */
const RULES: Record<string, RegExp> = {
  invoice_number: /Invoice Number:\s*(\S+)/,
  issue_date: /Issue Date:\s*(\S+)/,
  due_date: /Due Date:\s*(\S+)/,
  vendor_name: /^(MERIDIAN OFFICE SUPPLIES LLC)/m,
  total_amount: /Total Due:\s*(\$[\d,.]+)/,
  monthly_rent: /monthly rent of (\$[\d,.]+)/,
  vacancy_rate: /vacancy rate declined to ([\d.]+%)/,
};

const NOT_FOUND = 'not found by fake extractor';

/** Resolves after `ms`; rejects with the signal's reason if it aborts first (or already has). */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Deterministic offline extractor for unit tests and e2e (`EXTRACTOR=fake`). No network.
 * Fields without a rule, or whose rule does not match, come back as gaps
 * ('not found by fake extractor'). `extract` rejects with the signal's reason if aborted
 * before or during `delayMs`.
 */
export class FakeExtractor implements Extractor {
  readonly model = 'fake';
  private readonly delayMs: number;

  /** @param opts.delayMs simulated latency per `extract` call (default 0). */
  constructor(opts: { delayMs?: number } = {}) {
    this.delayMs = opts.delayMs ?? 0;
  }

  /** Cheap estimate, ceil(length / 4); never fails. */
  countTokens(text: string): Promise<number> {
    return Promise.resolve(Math.ceil(text.length / 4));
  }

  /** Fills each requested field from the regex table; see class doc for gaps and abort. */
  async extract(
    req: ExtractRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<{ output: ExtractionOutput; raw: unknown }> {
    await abortableSleep(this.delayMs, opts?.signal);
    const fields = req.fields.map(({ field }) => {
      const match = RULES[field]?.exec(req.chunkText);
      if (!match?.[1]) {
        return { field, value: null, evidence: null, gap_reason: NOT_FOUND };
      }
      return { field, value: match[1], evidence: match[0], gap_reason: null };
    });
    return { output: { fields }, raw: { fake: true } };
  }
}
