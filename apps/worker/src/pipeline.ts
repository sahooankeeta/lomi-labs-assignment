import {
  claimVersion,
  failVersion,
  finishVersion,
  getChunkState,
  handOffVersion,
  LEASE_MS,
  renewLease,
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
  type ChunkOptions,
} from '@lomi/extraction';
import type { FileStore } from '@lomi/files';
import { errInfo, type Logger } from '@lomi/logger';
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
  /** How often the lease is renewed while running (default 10 s, independent of chunk progress). */
  renewMs?: number;
  /** Max chunks sent to the extractor at once (default 3). */
  chunkConcurrency?: number;
  /** Overrides for the chunk planner (tests use small chunks). */
  chunkOptions?: Partial<ChunkOptions>;
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

  // Two different aborts, kept apart on purpose:
  // - `deps.signal` is SIGTERM: we still own the lease, so we give the version back
  //   (`handOffVersion`) and the next worker resumes it.
  // - `lost` is a failed lease renewal: someone else owns the version now. We must not
  //   fail or hand it off (that would be an attempt to write for a run that no longer
  //   owns it); we just stop and report `stale`.
  // - `stop` cancels sibling chunks when one chunk fails.
  // The extractor sees all three combined, so any of them cuts a long LLM call short.
  const lost = new AbortController();
  const stop = new AbortController();
  const runSignal = AbortSignal.any(
    deps.signal ? [stop.signal, lost.signal, deps.signal] : [stop.signal, lost.signal],
  );
  /** Throws at a step boundary once the run has been told to stop. */
  const checkpoint = (): void => {
    if (lost.signal.aborted) throw lost.signal.reason;
    if (deps.signal?.aborted) throw deps.signal.reason;
  };

  // Lease renewal runs on its own timer, not between chunks: one LLM call can take minutes
  // (retries and model fallback), far longer than the lease, and the lease must stay alive
  // throughout or another worker would take the version mid-call.
  let renewing = false;
  const renewTimer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    renewLease(db, versionId, runId, deps.leaseMs ?? LEASE_MS)
      .then((ok) => {
        if (!ok) {
          rlog.warn('lease lost; stopping this run');
          lost.abort(new Error('lease lost'));
        }
      })
      // A database blip must not kill the run: the next tick retries, and if it lasts
      // past the lease, the claim is lost the normal way.
      .catch((err: unknown) => rlog.warn(errInfo(err), 'lease renewal failed'))
      .finally(() => {
        renewing = false;
      });
  }, deps.renewMs ?? 10_000);

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
    checkpoint();

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
    checkpoint();
    const { chunks, results } = state;
    rlog.info({ chunks: chunks.length }, `planned ${chunks.length} chunks`);

    const candidatesByChunk = new Map<number, Candidate[]>(
      [...results].map(([i, r]) => [i, r.candidates as unknown as Candidate[]]),
    );
    const limiter = createLimiter(deps.chunkConcurrency ?? 3);
    const todo = chunks.filter((c) => !results.has(c.chunkIndex));
    // When one chunk fails, `stop` (above) cancels the siblings, in flight and still
    // queued, so no further LLM calls are made for a run that is already doomed.
    let firstError: unknown;
    await Promise.all(
      todo.map((chunk) =>
        limiter
          .run(async () => {
            if (runSignal.aborted) return;
            const chunkText = text.slice(chunk.start, chunk.end);
            const prompt = buildPrompt(version.type, expected, chunkText, {
              chunkIndex: chunk.chunkIndex,
              chunkCount: chunks.length,
            });
            const { output, raw } = await extractor.extract(
              { type: version.type, fields: expected, chunkText, prompt },
              { signal: runSignal },
            );
            // A run that lost its lease stores nothing more.
            if (lost.signal.aborted) return;
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
    // Tasks skipped because the run was told to stop leave holes. Surface that as the
    // abort it is. (A SIGTERM that lands after the last chunk completed still finishes:
    // the work is done and cheap to commit.)
    if (candidatesByChunk.size < chunks.length) {
      checkpoint();
      throw new Error('extraction ended with chunks missing');
    }

    const perChunk = chunks.map((c) => candidatesByChunk.get(c.chunkIndex)!);
    const merged = mergeCandidates(expected, perChunk, pageOffsets);
    const outcome = await finishVersion(db, versionId, runId, merged);
    rlog.info({ outcome }, outcome === 'finished' ? 'finished' : 'finish refused (stale)');
    return outcome;
  } catch (err) {
    if (lost.signal.aborted) {
      // Never write for a run that lost its lease; the new owner decides the outcome.
      rlog.warn('stale: lease lost');
      return 'stale';
    }
    if (deps.signal?.aborted) {
      const gaveBack = await handOffVersion(db, versionId, runId);
      rlog.info({ gaveBack }, 'handed off on shutdown');
      return gaveBack ? 'handed_off' : 'stale';
    }
    const message = err instanceof Error ? err.message : String(err);
    const wrote = await failVersion(db, versionId, runId, message);
    rlog.error({ err: message }, 'failed');
    return wrote ? 'failed' : 'stale';
  } finally {
    clearInterval(renewTimer);
  }
}
