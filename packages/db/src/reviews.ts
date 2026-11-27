import { normalizeValue } from '@lomi/extraction';
import type {
  DocumentListItemDto,
  ExpectedFields,
  ProgressDto,
  ReviewInput,
  ReviewResultDto,
} from '@lomi/shared';
import type { Db } from './client.js';
import { loadValuesWithLatestReview, progressOf, reviewStateOf } from './value-rows.js';

/**
 * Review writes and the list/progress reads that sit next to them. Reviews are
 * append-only: a re-review adds a row, and the newest row is the value's current review.
 */

export type ReviewValueResult =
  | { kind: 'reviewed'; result: ReviewResultDto }
  | { kind: 'not_found' }
  | { kind: 'not_reviewable'; reason: string }
  | { kind: 'invalid_value'; message: string };

/**
 * Backs `POST /values/:id/review`: appends an approve or correct review to a value and
 * returns the value's new state with the version's progress.
 *
 * - Only values of the document's current, `extracted` version can be reviewed, otherwise
 *   `not_reviewable` with the reason (the api answers 409).
 * - A gap (null value) can be approved ("confirmed absent") or corrected (supplies it).
 * - A correction must parse as the field's type (`normalizeValue`), else `invalid_value`.
 *   The text the reviewer typed (trimmed) is stored, not the normalized form.
 *
 * The document row is locked `FOR SHARE` before the checks. Phase 3's new-version
 * transaction takes `FOR UPDATE` on that same row, so a review either commits before the
 * supersede starts or waits for it and then sees the new current version. Without the
 * lock a review could land on a version in the instant it stops being current.
 * Concurrent reviews only share the lock, so they don't block each other.
 */
export async function reviewValue(
  db: Db,
  valueId: string,
  input: ReviewInput,
  opts: { fields: ExpectedFields },
): Promise<ReviewValueResult> {
  return db.$transaction(async (tx): Promise<ReviewValueResult> => {
    const value = await tx.extractedValue.findUnique({ where: { id: valueId } });
    if (!value) return { kind: 'not_found' };
    const version0 = await tx.documentVersion.findUniqueOrThrow({ where: { id: value.versionId } });
    const documentId = version0.documentId;

    // $queryRaw (not $executeRaw): a SELECT ... FOR SHARE returns rows.
    await tx.$queryRaw`SELECT 1 FROM documents WHERE id = ${documentId}::uuid FOR SHARE`;

    // Re-read after the lock: what we loaded above may be stale if a supersede just committed.
    const document = await tx.document.findUniqueOrThrow({ where: { id: documentId } });
    const version = await tx.documentVersion.findUniqueOrThrow({ where: { id: value.versionId } });
    if (document.currentVersionId !== version.id) {
      return {
        kind: 'not_reviewable',
        reason: `value belongs to version ${version.versionNo}, not the current version`,
      };
    }
    if (version.status !== 'extracted') {
      return { kind: 'not_reviewable', reason: `version is ${version.status}, not extracted` };
    }

    const defs = opts.fields[document.type];
    let correctedValue: string | null = null;
    if (input.action === 'correct') {
      correctedValue = input.value.trim();
      const type = defs.find((f) => f.field === value.field)?.type;
      // A field no longer defined for the type can't be validated, so it can't be corrected.
      if (!type) {
        return {
          kind: 'invalid_value',
          message: `field "${value.field}" is not defined for ${document.type}`,
        };
      }
      if (normalizeValue(correctedValue, type) === null) {
        return { kind: 'invalid_value', message: `"${correctedValue}" is not a valid ${type}` };
      }
    }

    const review = await tx.review.create({
      data: {
        valueId,
        action: input.action,
        correctedValue,
        note: input.action === 'correct' ? (input.note ?? null) : null,
      },
    });

    // Progress is computed after the insert so it includes this review.
    const rows = await loadValuesWithLatestReview(tx, [version.id]);
    const self = rows.find((r) => r.id === valueId)!;
    return {
      kind: 'reviewed',
      result: {
        review: {
          id: review.id,
          action: review.action,
          correctedValue: review.correctedValue,
          note: review.note,
          createdAt: review.createdAt.toISOString(),
        },
        reviewState: reviewStateOf(self),
        progress: progressOf(rows, defs),
      },
    };
  });
}

/**
 * Backs `GET /documents`: every document, newest first, with its current version's number
 * and status and that version's review progress (only fields defined for the type).
 *
 * Two queries regardless of document count: the documents with their current version,
 * then all those versions' values with their newest review. A document without a current
 * version (which `createDocumentWithV1` never produces) is skipped.
 */
export async function listDocuments(
  db: Db,
  opts: { fields: ExpectedFields },
): Promise<DocumentListItemDto[]> {
  const documents = await db.document.findMany({
    orderBy: { createdAt: 'desc' },
    include: { currentVersion: true },
  });
  const withVersion = documents.flatMap((d) =>
    d.currentVersion ? [{ document: d, version: d.currentVersion }] : [],
  );
  const rows = await loadValuesWithLatestReview(
    db,
    withVersion.map((x) => x.version.id),
  );

  return withVersion.map(({ document, version }) => ({
    id: document.id,
    title: document.title,
    type: document.type,
    versionNo: version.versionNo,
    status: version.status,
    progress: progressOf(
      rows.filter((r) => r.versionId === version.id),
      opts.fields[document.type],
    ),
    createdAt: document.createdAt.toISOString(),
  }));
}

/**
 * Review progress of a document's current version (only fields defined for its type); `null` when the document is unknown.
 * A version that isn't extracted yet has no values, so it reports all zeros.
 */
export async function getProgress(
  db: Db,
  documentId: string,
  opts: { fields: ExpectedFields },
): Promise<ProgressDto | null> {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: { type: true, currentVersionId: true },
  });
  if (!document) return null;
  const rows = document.currentVersionId
    ? await loadValuesWithLatestReview(db, [document.currentVersionId])
    : [];
  return progressOf(rows, opts.fields[document.type]);
}
