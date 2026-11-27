import { retryCurrentVersion, getDocumentDetail, createDocumentWithV1 } from '@lomi/db';
import { UploadFields, type DocumentDetailDto, type DocumentSummaryDto } from '@lomi/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { HttpError } from '../errors.js';

const PDF_MAGIC = Buffer.from('%PDF-');
const IdParams = z.object({ id: z.uuid() });
const DetailQuery = z.object({ version: z.coerce.number().int().positive().optional() });

/** `invoice-001.pdf` -> `invoice-001`; clipped to the 200 characters `UploadFields.title` allows. */
function titleFromFilename(filename: string | undefined): string {
  const base = (filename ?? '').replace(/\.pdf$/i, '').trim();
  return (base || 'Untitled').slice(0, 200);
}

/** Summary of a document's current version, the body of every mutating route. */
async function summarize(deps: Deps, documentId: string): Promise<DocumentSummaryDto> {
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
function fireEnqueue(deps: Deps, req: FastifyRequest, versionId: string, attempts: number): void {
  Promise.resolve()
    .then(() => deps.enqueue(versionId, attempts))
    .catch((err: unknown) =>
      req.log.warn({ versionId, err }, 'enqueue failed; reconciler will retry'),
    );
}

/** Registers the document routes. Validation and persistence only: no PDF parsing, no LLM. */
export function documentRoutes(app: FastifyInstance, deps: Deps): void {
  /**
   * `POST /documents` (multipart: `type`, optional `title`, `file`).
   *
   * - `201` + `DocumentSummaryDto`: a new document with a `queued` v1 was created.
   * - `200` + the existing summary: a document of the same type already has a v1 with the
   *   same sha256 (re-upload / double-click), nothing is created or enqueued.
   * - `400 bad_request`: bad or missing `type`, no file, or the file does not start with `%PDF-`.
   * - `413 payload_too_large`: file over 20 MB (multipart `fileSize` limit).
   *
   * After the transaction commits, an extraction job is enqueued as a fire-and-forget
   * *hint* (never awaited: with Redis down the queue waits for reconnection instead of
   * failing, which would hang the request). Postgres is the source of truth, and the
   * worker's reconciler picks up a queued version whose hint was lost.
   */
  app.post('/documents', async (req, reply) => {
    const fields: Record<string, string> = {};
    let file: { bytes: Buffer; filename: string | undefined } | undefined;

    for await (const part of req.parts()) {
      if (part.type === 'file') {
        // Throws a 413 error past the `fileSize` limit; the error handler maps it.
        file = { bytes: await part.toBuffer(), filename: part.filename };
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }

    const parsed = UploadFields.parse({ type: fields.type, title: fields.title || undefined });
    if (!file || file.bytes.length === 0)
      throw new HttpError(400, 'bad_request', 'file is required');
    // Magic bytes, not the extension or Content-Type: both are client-controlled.
    if (!file.bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      throw new HttpError(400, 'bad_request', 'file is not a PDF');
    }

    // File first, DB second: the row never points at a missing file. A crash in between
    // leaves an orphan file, which is harmless (content-addressed, reused by the next upload).
    const { key, sha256 } = await deps.files.put(file.bytes);
    const result = await createDocumentWithV1(deps.db, {
      type: parsed.type,
      title: parsed.title ?? titleFromFilename(file.filename),
      fileKey: key,
      sha256,
    });

    // Build the body before the hint, so the response reflects what this request committed.
    const body = await summarize(deps, result.documentId);
    // Only after the commit (a job must never reference a version that is not visible yet)
    // and only for a new version.
    if (result.created) fireEnqueue(deps, req, result.versionId, result.attempts);
    return reply.code(result.created ? 201 : 200).send(body);
  });

  /**
   * `GET /documents/:id[?version=N]` -> `DocumentDetailDto` for the current version, or
   * version N.
   *
   * - `200`: the document, the shown version and its values (empty until extraction finishes).
   * - `400 bad_request`: `:id` is not a UUID, or `version` is not a positive integer.
   * - `404 not_found`: no such document, or it has no version N.
   */
  app.get('/documents/:id', async (req): Promise<DocumentDetailDto> => {
    const { id } = IdParams.parse(req.params);
    const { version } = DetailQuery.parse(req.query);
    const detail = await getDocumentDetail(deps.db, id, {
      fields: deps.fields,
      versionNo: version,
    });
    if (!detail) throw new HttpError(404, 'not_found', 'document or version not found');
    return detail;
  });

  /**
   * `POST /documents/:id/retry`: puts a `failed` current version back to `queued`.
   *
   * - `202` + `DocumentSummaryDto`: the version was reset (fresh attempt budget) and a job
   *   `extract:<versionId>:0` is enqueued (fire-and-forget, after the update commits). As
   *   with upload, a lost hint is repaired by the reconciler.
   * - `400 bad_request`: `:id` is not a UUID.
   * - `404 not_found`: no such document.
   * - `409 conflict`: the current version is not `failed` (also what a double click gets).
   */
  app.post('/documents/:id/retry', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const result = await retryCurrentVersion(deps.db, id);
    if (result.kind === 'not_found') throw new HttpError(404, 'not_found', 'document not found');
    if (result.kind === 'not_failed') {
      throw new HttpError(
        409,
        'conflict',
        `only a failed version can be retried (it is ${result.status})`,
      );
    }
    const body = await summarize(deps, id);
    fireEnqueue(deps, req, result.versionId, result.attempts);
    return reply.code(202).send(body);
  });
}
