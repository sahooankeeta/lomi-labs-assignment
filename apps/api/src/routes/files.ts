import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { HttpError } from '../errors.js';

const IdParams = z.object({ id: z.uuid() });

/** Registers the PDF download route the review UI embeds. */
export function fileRoutes(app: FastifyInstance, deps: Deps): void {
  /**
   * `GET /versions/:id/file`: the version's PDF, inline.
   *
   * - `200`: the bytes, `content-type: application/pdf`, `content-disposition: inline;
   *   filename="<title>-v<N>.pdf"` (title characters outside `[A-Za-z0-9._-]` become `_`,
   *   so the header is always safe), and an immutable cache header: files are
   *   content-addressed, so a version's bytes never change.
   * - `400 bad_request`: `:id` is not a UUID.
   * - `404 not_found`: no such version, or its file is missing from the store.
   *
   * Uses `files.read` rather than a stream: uploads are capped at 20 MB, and reading first
   * turns a missing file into a clean 404 before any header is sent.
   */
  app.get('/versions/:id/file', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const version = await deps.db.documentVersion.findUnique({
      where: { id },
      include: { document: { select: { title: true } } },
    });
    if (!version) throw new HttpError(404, 'not_found', 'version not found');

    let bytes: Uint8Array;
    try {
      bytes = await deps.files.read(version.fileKey);
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') {
        throw new HttpError(404, 'not_found', 'file not found');
      }
      throw err;
    }

    const safeTitle = version.document.title.replace(/[^A-Za-z0-9._-]/g, '_');
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${safeTitle}-v${version.versionNo}.pdf"`)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(Buffer.from(bytes));
  });
}
