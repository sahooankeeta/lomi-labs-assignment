import { isUnchanged, normalizeValue } from '@lomi/extraction';
import { deriveReviewState, effectiveValue } from '@lomi/shared';
import type {
  DocumentDetailDto,
  DocumentType,
  ExpectedFields,
  FieldType,
  PreviousValueDto,
  ReviewDto,
  ValueDto,
  ValueHistoryDto,
} from '@lomi/shared';
import type { Db } from './client.js';
import {
  loadChainIds,
  loadEarlierCounts,
  loadValuesWithLatestReview,
  progressOf,
  reviewStateOf,
} from './value-rows.js';

/**
 * Document lifecycle reads and writes used by the api and the seed script.
 *
 * Postgres is the source of truth: these functions only change rows. Enqueuing the
 * BullMQ hint is the caller's job, *after* the transaction commits, and a lost hint is
 * repaired by the worker's reconciler, so no function here talks to Redis.
 */

export interface CreateDocumentInput {
  type: DocumentType;
  title: string;
  /** Content-addressed file key (`<sha256>.pdf`); the file is stored before this call. */
  fileKey: string;
  sha256: string;
}

export interface CreateDocumentResult {
  documentId: string;
  versionId: string;
  /** The version's attempt count; part of the BullMQ job id (`extract-<versionId>-<attempts>`). */
  attempts: number;
  /** `false` when an identical upload already existed and its ids were returned instead. */
  created: boolean;
}

/**
 * Creates a document with a queued v1, or returns the existing one when a document of
 * the same type already has a v1 with this sha256 (re-uploading a file is idempotent;
 * the same file under a different type is a different document).
 *
 * The advisory lock is the first statement of the transaction and is released at
 * commit, so two identical uploads at the same instant (a double-click) run one after
 * the other: the second sees the first's committed row and returns `created: false`.
 */
export async function createDocumentWithV1(
  db: Db,
  input: CreateDocumentInput,
): Promise<CreateDocumentResult> {
  const lockKey = `${input.type}:${input.sha256}`;
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const existing = await tx.documentVersion.findFirst({
      where: { versionNo: 1, sha256: input.sha256, document: { type: input.type } },
      select: { id: true, documentId: true, attempts: true },
    });
    if (existing) {
      return {
        documentId: existing.documentId,
        versionId: existing.id,
        attempts: existing.attempts,
        created: false,
      };
    }

    // Document and version reference each other, so: create both, then point the
    // document at its current version.
    const document = await tx.document.create({ data: { type: input.type, title: input.title } });
    const version = await tx.documentVersion.create({
      data: { documentId: document.id, versionNo: 1, fileKey: input.fileKey, sha256: input.sha256 },
    });
    await tx.document.update({
      where: { id: document.id },
      data: { currentVersionId: version.id },
    });
    return { documentId: document.id, versionId: version.id, attempts: 0, created: true };
  });
}

/** A stored review row as the API shape. */
function toReviewDto(r: {
  id: string;
  action: ReviewDto['action'];
  correctedValue: string | null;
  note: string | null;
  createdAt: Date;
}): ReviewDto {
  return {
    id: r.id,
    action: r.action,
    correctedValue: r.correctedValue,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Classifies how the previous version's value differs from the shown one, using the
 * extracted (not corrected) values: carry-over compares the same thing, so the label
 * always agrees with what carry-over decided.
 *
 * Without the shown version's text or the field's type the quote can't be checked, so a
 * pair of values is reported as 'value' (the safe "look again") rather than throwing.
 */
function classifyChange(
  prev: { value: string | null; evidence: string | null },
  next: { value: string | null },
  newText: string | null,
  type: FieldType | undefined,
): PreviousValueDto['change'] {
  if (prev.value === null && next.value === null) return 'gap';
  if (prev.value === null || next.value === null) return 'value';
  if (newText === null || type === undefined) return 'value';
  if (isUnchanged(prev, next, newText, type)) return null;
  // Not unchanged: equal normalized values mean only the quote is gone.
  const a = normalizeValue(prev.value, type);
  const b = normalizeValue(next.value, type);
  return a !== null && a === b ? 'evidence' : 'value';
}

/**
 * The read model behind `GET /documents/:id`: one version (the current one, or
 * `versionNo` when given) with its extracted values and their review state and progress counts.
 *
 * - Returns `null` when the document or the requested version doesn't exist.
 * - `status` is the shown version's own status, so an old version reads `superseded`.
 * - Values are listed in the type's field order from `expected-fields.json`; a stored
 *   value for a field no longer defined for the type is left out.
 * - Before extraction finishes `values` is empty: values are written once, at finish.
 */
export async function getDocumentDetail(
  db: Db,
  documentId: string,
  opts: { fields: ExpectedFields; versionNo?: number },
): Promise<DocumentDetailDto | null> {
  const document = await db.document.findUnique({ where: { id: documentId } });
  if (!document) return null;

  const version =
    opts.versionNo === undefined
      ? document.currentVersionId
        ? await db.documentVersion.findUnique({ where: { id: document.currentVersionId } })
        : null
      : await db.documentVersion.findUnique({
          where: { documentId_versionNo: { documentId, versionNo: opts.versionNo } },
        });
  if (!version) return null;

  const rows = await loadValuesWithLatestReview(db, [version.id]);
  const earlier = await loadEarlierCounts(
    db,
    rows.map((r) => r.id),
  );
  // A client viewing an old version needs to know it is not the current one.
  const currentVersionNo =
    document.currentVersionId && document.currentVersionId !== version.id
      ? (
          await db.documentVersion.findUniqueOrThrow({
            where: { id: document.currentVersionId },
            select: { versionNo: true },
          })
        ).versionNo
      : version.versionNo;

  const defs = opts.fields[document.type];
  const values: ValueDto[] = [];
  for (const def of defs) {
    const row = rows.find((r) => r.field === def.field);
    if (!row) continue;
    const review = row.reviews[0] ?? null;
    const reviewState = reviewStateOf(row);
    const prevRow = row.previousValue;
    let previous: PreviousValueDto | null = null;
    if (prevRow) {
      const prevOwn = prevRow.reviews[0] ?? null;
      const prevReview = prevOwn ?? prevRow.carriedReview;
      previous = {
        id: prevRow.id,
        versionNo: prevRow.version.versionNo,
        value: prevRow.value,
        effectiveValue: effectiveValue({
          value: prevRow.value,
          latestReview: prevOwn,
          carriedReview: prevRow.carriedReview,
        }),
        evidence: prevRow.evidence,
        evidencePage: prevRow.evidencePage,
        reviewState: deriveReviewState({
          latestReviewAction: prevOwn?.action ?? null,
          carriedReviewId: prevRow.carriedReviewId,
        }),
        review: prevReview && toReviewDto(prevReview),
        change: classifyChange(prevRow, row, version.parsedText, def.type),
      };
    }
    values.push({
      id: row.id,
      field: row.field,
      fieldType: def.type,
      value: row.value,
      evidence: row.evidence,
      gapReason: row.gapReason,
      candidates: row.candidates as ValueDto['candidates'],
      evidencePage: row.evidencePage,
      evidenceStart: row.evidenceStart,
      evidenceEnd: row.evidenceEnd,
      reviewState,
      latestReview: review && toReviewDto(review),
      carriedReview: row.carriedReview && toReviewDto(row.carriedReview),
      previous,
      earlierCount: earlier.get(row.id) ?? 0,
    });
  }

  return {
    id: document.id,
    title: document.title,
    type: document.type,
    status: version.status,
    version: {
      id: version.id,
      versionNo: version.versionNo,
      status: version.status,
      error: version.error,
      parsedText: version.parsedText,
      pageOffsets: version.pageOffsets,
      createdAt: version.createdAt.toISOString(),
    },
    values,
    progress: progressOf(rows, defs),
    currentVersionNo,
  };
}

/**
 * The history of one field across versions, newest first, starting with the value asked
 * for (so asking for an old version's value shows only it and what came before).
 * `null` when the value id is unknown.
 *
 * The chain is walked with one recursive query, then every entry's reviews and carried
 * review load in a second one (no per-entry queries). `reviews` holds all own reviews,
 * oldest first, since they are append-only and are the full record.
 */
export async function getValueHistory(db: Db, valueId: string): Promise<ValueHistoryDto | null> {
  const ids = await loadChainIds(db, valueId);
  if (ids.length === 0) return null;
  const rows = await db.extractedValue.findMany({
    where: { id: { in: ids } },
    include: {
      version: { select: { versionNo: true, status: true } },
      reviews: { orderBy: { createdAt: 'asc' } },
      carriedReview: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const entries = ids.map((id) => {
    const r = byId.get(id)!;
    return {
      valueId: r.id,
      versionNo: r.version.versionNo,
      versionStatus: r.version.status,
      value: r.value,
      evidence: r.evidence,
      evidencePage: r.evidencePage,
      gapReason: r.gapReason,
      reviewState: deriveReviewState({
        latestReviewAction: r.reviews[r.reviews.length - 1]?.action ?? null,
        carriedReviewId: r.carriedReviewId,
      }),
      carriedReview: r.carriedReview && toReviewDto(r.carriedReview),
      reviews: r.reviews.map(toReviewDto),
    };
  });
  return { field: byId.get(ids[0]!)!.field, entries };
}

export type RetryResult =
  | { kind: 'retried'; versionId: string; attempts: 0 }
  | { kind: 'not_found' }
  | { kind: 'not_failed'; status: string };

/**
 * Backs `POST /documents/:id/retry`: puts the current version back to `queued` with a
 * fresh attempt budget, only if it is `failed`.
 *
 * The status check is part of the UPDATE (`where status = 'failed'`), so two retries at
 * once produce one `retried` and one `not_failed`, never a double reset. The caller
 * enqueues the job (`extract-<versionId>-0`) after this returns `retried`. That id may
 * equal an earlier finished job's; the queue removes finished jobs, and if the add still
 * collides with a job that is active, the reconciler re-adds it within seconds.
 */
export async function retryCurrentVersion(db: Db, documentId: string): Promise<RetryResult> {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: { currentVersionId: true },
  });
  if (!document?.currentVersionId) return { kind: 'not_found' };
  const versionId = document.currentVersionId;

  const { count } = await db.documentVersion.updateMany({
    where: { id: versionId, status: 'failed' },
    data: { status: 'queued', error: null, attempts: 0, activeRunId: null, leaseExpiresAt: null },
  });
  if (count === 1) return { kind: 'retried', versionId, attempts: 0 };

  // Nothing updated: report the status that blocked it (the api answers 409).

  const current = await db.documentVersion.findUnique({
    where: { id: versionId },
    select: { status: true },
  });
  return current ? { kind: 'not_failed', status: current.status } : { kind: 'not_found' };
}
