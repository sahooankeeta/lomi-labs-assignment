import type { DocumentSummaryDto } from '@lomi/shared';
import type { FastifyRequest } from 'fastify';
import type { Deps } from '../app.js';
import { HttpError } from '../errors.js';

/** Summary of a document's current version, the body of every mutating route. */
export async function summarize(deps: Deps, documentId: string): Promise<DocumentSummaryDto> {
  const doc = await deps.db.document.findUnique({
    where: { id: documentId },
    include: { currentVersion: true },
  });
  if (!doc?.currentVersion) throw new HttpError(404, 'not_found', 'document not found');
  return {
    id: doc.id,
    title: doc.title,
    type: doc.type,
    versionNo: doc.currentVersion.versionNo,
    status: doc.currentVersion.status,
  };
}

/**
 * Fire-and-forget enqueue, called after the response body is built. Not awaited: the
 * queue's Redis connection retries forever, so an outage would hang the request.
 * Postgres is the source of truth and the reconciler repairs a lost hint; a failure is
 * only logged.
 */
export function fireEnqueue(
  deps: Deps,
  req: FastifyRequest,
  versionId: string,
  attempts: number,
): void {
  Promise.resolve()
    .then(() => deps.enqueue(versionId, attempts))
    .catch((err: unknown) =>
      req.log.warn({ versionId, err }, 'enqueue failed; reconciler will retry'),
    );
}
