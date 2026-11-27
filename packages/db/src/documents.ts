import type { DocumentType } from '@lomi/shared';
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
