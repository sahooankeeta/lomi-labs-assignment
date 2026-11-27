import type { VersionSummaryDto } from '@lomi/shared';
import type { Db } from './client.js';

/**
 * Revised-file writes and reads behind `POST /documents/:id/versions` and
 * `GET /documents/:id/versions`. Like the rest of this package they only change rows;
 * enqueuing the extraction job for a `created` version is the caller's job, after commit.
 */

export interface CreateVersionInput {
  /** Content-addressed file key (`<sha256>.pdf`); the file is stored before this call. */
  fileKey: string;
  sha256: string;
}

export type CreateVersionResult =
  | {
      kind: 'created';
      versionId: string;
      versionNo: number;
      /** Fresh version: BullMQ job id is `extract-<versionId>-0`. */
      attempts: 0;
      /** Ids of the older `queued`/`extracting` versions that were superseded. */
      superseded: string[];
    }
  /** The upload is byte-identical to the current version; nothing was written. */
  | { kind: 'unchanged'; versionId: string }
  | { kind: 'not_found' };

/**
 * Makes a revised PDF the document's new current version, in one transaction.
 *
 * The document row is locked `FOR UPDATE` first. That serializes concurrent uploads (so
 * the `max(versionNo) + 1` below can't be computed twice, and two identical uploads
 * resolve to one `created` and one `unchanged` instead of a unique violation) and pairs
 * with `reviewValue`'s `FOR SHARE`, so a review either lands before the supersede or sees
 * the new current version.
 *
 * Dedupe is against the *current* version only: re-uploading an older file is a revert
 * and becomes a new version.
 *
 * Unfinished (`queued`/`extracting`) versions become `superseded` and their lease is
 * cleared. `activeRunId` is kept as the record of who held it; every worker write is
 * guarded by `status = 'extracting'`, so a stale worker cannot write. Their `running`
 * runs are marked `abandoned` here because a run that loses its lease just returns
 * without marking itself. Values, reviews and finished/failed versions are never touched.
 */
export async function createVersion(
  db: Db,
  documentId: string,
  input: CreateVersionInput,
): Promise<CreateVersionResult> {
  return db.$transaction(async (tx) => {
    // $queryRaw (not $executeRaw): a SELECT ... FOR UPDATE returns rows.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM documents WHERE id = ${documentId}::uuid FOR UPDATE`;
    if (locked.length === 0) return { kind: 'not_found' } as const;

    const document = await tx.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { currentVersionId: true },
    });
    if (document.currentVersionId) {
      const current = await tx.documentVersion.findUniqueOrThrow({
        where: { id: document.currentVersionId },
        select: { id: true, sha256: true },
      });
      if (current.sha256 === input.sha256) {
        return { kind: 'unchanged', versionId: current.id } as const;
      }
    }

    // Aggregated under the lock; `@@unique([documentId, versionNo])` is only the backstop.
    const { _max } = await tx.documentVersion.aggregate({
      where: { documentId },
      _max: { versionNo: true },
    });
    const versionNo = (_max.versionNo ?? 0) + 1;

    const unfinished = await tx.documentVersion.findMany({
      where: { documentId, status: { in: ['queued', 'extracting'] } },
      select: { id: true },
    });
    const superseded = unfinished.map((v) => v.id);
    if (superseded.length > 0) {
      await tx.documentVersion.updateMany({
        where: { id: { in: superseded } },
        data: { status: 'superseded', leaseExpiresAt: null },
      });
      await tx.extractionRun.updateMany({
        where: { versionId: { in: superseded }, status: 'running' },
        data: { status: 'abandoned', finishedAt: new Date() },
      });
    }

    const version = await tx.documentVersion.create({
      data: { documentId, versionNo, fileKey: input.fileKey, sha256: input.sha256 },
    });
    await tx.document.update({
      where: { id: documentId },
      data: { currentVersionId: version.id },
    });
    return {
      kind: 'created',
      versionId: version.id,
      versionNo,
      attempts: 0,
      superseded,
    } as const;
  });
}

/**
 * All versions of a document, newest first, for the version picker. `null` when the
 * document doesn't exist (an existing document always has at least v1).
 */
export async function listVersions(
  db: Db,
  documentId: string,
): Promise<VersionSummaryDto[] | null> {
  const rows = await db.documentVersion.findMany({
    where: { documentId },
    orderBy: { versionNo: 'desc' },
    select: { id: true, versionNo: true, status: true, error: true, createdAt: true },
  });
  if (rows.length === 0) return null;
  return rows.map((r) => ({
    id: r.id,
    versionNo: r.versionNo,
    status: r.status,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
  }));
}
