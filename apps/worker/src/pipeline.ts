import {
  claimVersion,
  failVersion,
  finishVersion,
  getChunkState,
  saveChunkPlan,
  saveChunkResult,
  saveParsedText,
  type Db,
} from '@lomi/db';
import {
  buildPrompt,
  mergeCandidates,
  planChunks,
  PROMPT_VERSION,
  validateChunkOutput,
  type CHUNK_DEFAULTS,
} from '@lomi/extraction';
import type { FileStore } from '@lomi/files';
import type { Logger } from '@lomi/logger';
import type { Candidate, ExpectedFields } from '@lomi/shared';
import type { Extractor } from './extractors/index.js';
import { createLimiter } from './limit.js';
import { parsePdf } from './pdf.js';

/** Everything `processVersion` needs; all of it is injected so tests can use fakes. */
export interface PipelineDeps {
  db: Db;
  files: FileStore;
  extractor: Extractor;
  /** Expected fields per document type (`fixtures/expected-fields.json`). */
  fields: ExpectedFields;
  log: Logger;
  /** Lease length passed to claim (default `LEASE_MS`). */
  leaseMs?: number;
  /** How often the lease is renewed while running (default 10 s). */
  renewMs?: number;
  /** Max chunks sent to the extractor at once (default 3). */
  chunkConcurrency?: number;
  /** Overrides for the chunk planner (tests use small chunks). */
  chunkOptions?: Partial<typeof CHUNK_DEFAULTS>;
  /** Aborted on SIGTERM: the run stops and hands the version back. */
  signal?: AbortSignal;
}

/**
 * How one `processVersion` call ended, and what it means for the BullMQ job. In every
 * case the job is simply acknowledged (returned, not thrown): Postgres holds the real
 * outcome, and retries are the reconciler's business, never BullMQ's.
 *
 * - `finished`: values written, version `extracted`.
 * - `failed`: version `failed` with a human-readable error; the user can retry it.
 * - `skipped`: someone else holds a live lease, or the version is already done. Nothing changed.
 * - `capped`: the version had already been interrupted too many times and is now `failed`.
 * - `stale`: this run lost the lease (another worker took over, or it already ended). It
 *   wrote nothing after losing it; the new owner decides the outcome.
 * - `handed_off`: SIGTERM. The version is `queued` again with its attempt refunded, and
 *   stored chunk results are kept, so the next worker resumes.
 */
export type ProcessResult = 'finished' | 'stale' | 'skipped' | 'capped' | 'failed' | 'handed_off';

const MIN_TEXT_CHARS = 20;
const NO_TEXT = 'No text layer found (scanned PDF?); OCR is not supported';

/**
 * Runs one extraction attempt for a version: claim, parse, plan, extract chunks, merge,
 * finish. Never throws for pipeline problems (they become `failed`); it rejects only if
 * Postgres itself is unreachable, in which case the lease expires and the reconciler
 * re-enqueues the version.
 *
 * Guarantees:
 * - Safe to call twice at once for a version: `claimVersion` lets exactly one run proceed.
 * - Resumable: parsed text is reused from the row (offsets in stored results index into
 *   it, so it is never re-derived) and the chunk plan and results stored by an earlier
 *   run are reused; only chunks without a result for this prompt version are re-extracted.
 */
export async function processVersion(
  deps: PipelineDeps,
  versionId: string,
): Promise<ProcessResult> {
  const { db, files, extractor, log } = deps;
  const claim = await claimVersion(db, versionId, {
    model: extractor.model,
    leaseMs: deps.leaseMs,
  });
  if (claim.kind !== 'claimed') {
    log.info({ versionId }, claim.kind);
    return claim.kind;
  }
  const { runId, version } = claim;
  const rlog = log.child({ versionId, runId });
  rlog.info({ attempts: version.attempts }, 'claimed');

  try {
    // Parsed text: from the row when an earlier run stored it, else parse and store.
    let text = version.parsedText;
    let pageOffsets = version.pageOffsets;
    if (text === null) {
      const parsed = await parsePdf(await files.read(version.fileKey));
      if (parsed.text.replace(/\s/g, '').length < MIN_TEXT_CHARS) throw new Error(NO_TEXT);
      text = parsed.text;
      pageOffsets = parsed.pageOffsets;
      await saveParsedText(db, versionId, runId, { parsedText: text, pageOffsets });
    }
    rlog.info({ pages: pageOffsets.length }, `parsed ${pageOffsets.length} pages`);

    const expected = deps.fields[version.type];
    if (!expected) throw new Error(`No expected fields for document type ${version.type}`);

    let state = await getChunkState(db, versionId, PROMPT_VERSION);
    if (state.chunks.length === 0) {
      const plan = await planChunks(
        text,
        pageOffsets,
        { count: (t) => extractor.countTokens(t) },
        deps.chunkOptions,
      );
      await saveChunkPlan(db, versionId, plan);
      // Re-read: if another run planned first, its plan is the one results line up with.
      state = await getChunkState(db, versionId, PROMPT_VERSION);
    }
    const { chunks, results } = state;
    rlog.info({ chunks: chunks.length }, `planned ${chunks.length} chunks`);

    const candidatesByChunk = new Map<number, Candidate[]>(
      [...results].map(([i, r]) => [i, r.candidates as unknown as Candidate[]]),
    );
    const limiter = createLimiter(deps.chunkConcurrency ?? 3);
    const todo = chunks.filter((c) => !results.has(c.chunkIndex));
    // When one chunk fails, `stop` cancels the siblings (in flight and still queued) so
    // no further LLM calls are made for a run that is already doomed.
    const stop = new AbortController();
    let firstError: unknown;
    await Promise.all(
      todo.map((chunk) =>
        limiter
          .run(async () => {
            if (stop.signal.aborted) return;
            const chunkText = text.slice(chunk.start, chunk.end);
            const prompt = buildPrompt(version.type, expected, chunkText, {
              chunkIndex: chunk.chunkIndex,
              chunkCount: chunks.length,
            });
            const { output, raw } = await extractor.extract(
              { type: version.type, fields: expected, chunkText, prompt },
              { signal: stop.signal },
            );
            const candidates = validateChunkOutput(output, expected, {
              text: chunkText,
              start: chunk.start,
            });
            await saveChunkResult(db, {
              versionId,
              chunkIndex: chunk.chunkIndex,
              promptVersion: PROMPT_VERSION,
              runId,
              prompt: `${prompt.system}\n\n${prompt.user}`,
              rawResponse: raw,
              candidates,
            });
            candidatesByChunk.set(chunk.chunkIndex, candidates);
            rlog.info({ chunk: chunk.chunkIndex }, `chunk ${chunk.chunkIndex} done`);
          })
          .catch((err: unknown) => {
            if (firstError === undefined) firstError = err;
            stop.abort(err);
          }),
      ),
    );
    if (firstError !== undefined) throw firstError;

    const perChunk = chunks.map((c) => candidatesByChunk.get(c.chunkIndex)!);
    const merged = mergeCandidates(expected, perChunk, pageOffsets);
    const outcome = await finishVersion(db, versionId, runId, merged);
    rlog.info({ outcome }, outcome === 'finished' ? 'finished' : 'finish refused (stale)');
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const wrote = await failVersion(db, versionId, runId, message);
    rlog.error({ err: message }, 'failed');
    return wrote ? 'failed' : 'stale';
  }
}
