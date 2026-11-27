import type {
  DocumentDetailDto,
  DocumentType,
  ExpectedFields,
  ValueDto,
  ValueReviewState,
} from '@lomi/shared';
import type { Db } from './client.js';

export interface CreateDocumentInput {
  type: DocumentType;
  title: string;
  fileKey: string;
  sha256: string;
}

export interface CreateDocumentResult {
  documentId: string;
  versionId: string;
  attempts: number;
  created: boolean;
}

/**
 * Creates a document with a queued v1, or returns the existing one when a document of
 * the same type already has a v1 with this sha256. The advisory lock serialises
 * concurrent identical uploads so only one row is ever created.
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

  const rows = await db.extractedValue.findMany({
    where: { versionId: version.id },
    include: { reviews: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });

  const defs = opts.fields[document.type];
  const values: ValueDto[] = [];
  for (const def of defs) {
    const row = rows.find((r) => r.field === def.field);
    if (!row) continue;
    const review = row.reviews[0] ?? null;
    const reviewState: ValueReviewState = review
      ? review.action === 'approve'
        ? 'approved'
        : 'corrected'
      : row.carriedReviewId
        ? 'carried_over'
        : 'pending';
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
      latestReview: review && {
        id: review.id,
        action: review.action,
        correctedValue: review.correctedValue,
        note: review.note,
        createdAt: review.createdAt.toISOString(),
      },
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
  };
}

export type RetryResult =
  | { kind: 'retried'; versionId: string; attempts: 0 }
  | { kind: 'not_found' }
  | { kind: 'not_failed'; status: string };

/** Requeues the current version of a document, only if it is `failed`. */
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

  const current = await db.documentVersion.findUnique({
    where: { id: versionId },
    select: { status: true },
  });
  return current ? { kind: 'not_failed', status: current.status } : { kind: 'not_found' };
}
