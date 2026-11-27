import { createVersion, getValueHistory, listVersions } from '@lomi/db';
import type { ValueHistoryDto, VersionSummaryDto } from '@lomi/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { HttpError } from '../errors.js';
import { readPdfUpload } from '../upload.js';
import { fireEnqueue, summarize } from './common.js';

// A uuid check, not just a string: `getValueHistory` casts the id with `::uuid` in raw SQL,
// so a malformed one must stop here as a 400 instead of becoming a database 500.
const IdParams = z.object({ id: z.uuid() });

/** Registers the version routes: upload a new version, list versions, per-value history. */
export function versionRoutes(app: FastifyInstance, deps: Deps): void {
  /**
   * `POST /documents/:id/versions` (multipart: `file`).
   *
   * - `201` + `DocumentSummaryDto`: a new `queued` version became the current one (older
   *   unfinished versions are superseded) and an extraction job is enqueued as a
   *   fire-and-forget hint, after the commit.
   * - `200` + the current summary: the bytes equal the current version's, nothing is created
   *   or enqueued (re-upload / double-click).
   * - `400 bad_request`: `:id` is not a UUID (checked before the body is read), no file, or
   *   the file does not start with `%PDF-`.
   * - `404 not_found`: no such document.
   * - `413 payload_too_large`: file over 20 MB (multipart `fileSize` limit).
   */
  app.post('/documents/:id/versions', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { file } = await readPdfUpload(req);

    // File first, DB second, as in POST /documents. On `not_found` the file stays in the
    // store: harmless, it is content-addressed and reused by the next upload of the same bytes.
    const { key, sha256 } = await deps.files.put(file.bytes);
    const result = await createVersion(deps.db, id, { fileKey: key, sha256 });
    if (result.kind === 'not_found') throw new HttpError(404, 'not_found', 'document not found');

    const body = await summarize(deps, id);
    if (result.kind === 'unchanged') return reply.code(200).send(body);
    // Built from this call's result, not the document's current version: a concurrent upload
    // may already have moved the current version on to v3.
    const createdBody = { ...body, versionNo: result.versionNo, status: 'queued' as const };
    // Only after the commit: a job must never reference a version that is not visible yet.
    fireEnqueue(deps, req, result.versionId, result.attempts);
    return reply.code(201).send(createdBody);
  });

  /**
   * `GET /documents/:id/versions` -> `VersionSummaryDto[]`, newest first.
   *
   * - `200`: every version of the document with its status.
   * - `400 bad_request`: `:id` is not a UUID.
   * - `404 not_found`: no such document.
   */
  app.get('/documents/:id/versions', async (req): Promise<VersionSummaryDto[]> => {
    const { id } = IdParams.parse(req.params);
    const versions = await listVersions(deps.db, id);
    if (!versions) throw new HttpError(404, 'not_found', 'document not found');
    return versions;
  });

  /**
   * `GET /values/:id/history` -> `ValueHistoryDto`: the field's value in this version and every
   * earlier one, newest first, each with its own reviews. This is what keeps earlier
   * versions' reviews queryable in full, not only the latest one.
   *
   * - `200`: the history chain.
   * - `400 bad_request`: `:id` is not a UUID.
   * - `404 not_found`: no such value.
   */
  app.get('/values/:id/history', async (req): Promise<ValueHistoryDto> => {
    const { id } = IdParams.parse(req.params);
    const history = await getValueHistory(deps.db, id);
    if (!history) throw new HttpError(404, 'not_found', 'value not found');
    return history;
  });
}
