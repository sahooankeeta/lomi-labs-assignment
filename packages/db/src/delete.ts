import type { Db } from './client.js';

/**
 * Hard delete of a whole document. There is deliberately no single-version delete: the
 * brief keeps old versions queryable across re-extraction, and this is the one explicit,
 * user-confirmed way a document goes away.
 */

export type DeleteDocumentResult =
  | {
      kind: 'deleted';
      versionCount: number;
      /**
       * Distinct file keys of the deleted versions that no remaining version references.
       * The caller removes these files after commit; shared files must survive.
       */
      orphanedFileKeys: string[];
    }
  | { kind: 'not_found' };

/**
 * Deletes a document, all its versions and everything hanging off them, in one
 * transaction. Idempotent in effect: a second call answers `not_found`.
 *
 * Locks are taken document row first, then its version rows, the same order as
 * `createVersion`, so no deadlock with it or the worker:
 * - `documents ... FOR UPDATE` serializes with `createVersion` (`FOR UPDATE`) and
 *   `reviewValue` (`FOR SHARE`): an upload either commits first (its version is deleted
 *   below) or finds no document and answers `not_found`.
 * - `document_versions ... FOR UPDATE` serializes with the worker, which never locks the
 *   document row and only touches version rows. A concurrent `finishVersion` either
 *   commits first (its values are deleted below) or waits, then matches 0 rows (`stale`).
 *   Without it, a finish committing between the child deletes and the version delete would
 *   fail the latter with a foreign-key violation.
 *
 * Nothing outside Postgres is touched (no Redis, no files); the returned
 * `orphanedFileKeys` tell the caller which PDFs to remove after commit.
 */
export async function deleteDocument(db: Db, documentId: string): Promise<DeleteDocumentResult> {
  return db.$transaction(async (tx): Promise<DeleteDocumentResult> => {
    // $queryRaw (not $executeRaw): a SELECT ... FOR UPDATE returns rows.
    const doc = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM documents WHERE id = ${documentId}::uuid FOR UPDATE`;
    if (doc.length === 0) return { kind: 'not_found' };

    // Lock the versions too (see above). Any version a racing upload added has committed
    // by now, because that upload held the document lock until its commit.
    const versions = await tx.$queryRaw<{ id: string; file_key: string }[]>`
      SELECT id, file_key FROM document_versions WHERE document_id = ${documentId}::uuid FOR UPDATE`;
    const versionIds = versions.map((v) => v.id);
    const byVersion = { versionId: { in: versionIds } };

    // Children before parents; FKs are RESTRICT. Reviews go first because values and
    // reviews form a cycle: a review points at its value (RESTRICT) and a carried value
    // points at a review (`carried_review_id`, SET NULL). Deleting reviews first breaks it
    // by nulling the carry links, after which the values can go.
    await tx.review.deleteMany({ where: { value: byVersion } });
    await tx.extractedValue.deleteMany({ where: byVersion });
    await tx.chunkResult.deleteMany({ where: byVersion });
    await tx.versionChunk.deleteMany({ where: byVersion });
    await tx.extractionRun.deleteMany({ where: byVersion });

    // `documents.current_version_id` clears itself (SET NULL) as its version goes.
    await tx.documentVersion.deleteMany({ where: { id: { in: versionIds } } });
    await tx.document.delete({ where: { id: documentId } });

    // Checked after the deletes, in the same transaction, so rows of this document don't
    // count and another document's upload committed before us does.
    const keys = [...new Set(versions.map((v) => v.file_key))];
    const stillUsed = await tx.documentVersion.findMany({
      where: { fileKey: { in: keys } },
      select: { fileKey: true },
    });
    const used = new Set(stillUsed.map((v) => v.fileKey));

    return {
      kind: 'deleted',
      versionCount: versionIds.length,
      orphanedFileKeys: keys.filter((k) => !used.has(k)),
    };
  });
}
