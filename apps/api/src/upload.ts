import type { FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';

const PDF_MAGIC = Buffer.from('%PDF-');

/**
 * Reads a multipart request into its text fields and its one PDF file, shared by every
 * upload route.
 *
 * Throws `HttpError(400)` when there is no (or an empty) file, or when it does not start
 * with `%PDF-` (magic bytes, not the extension or Content-Type: both are client-controlled).
 * A file over the multipart `fileSize` limit makes `toBuffer` throw a 413, which the app's
 * error handler maps.
 */
export async function readPdfUpload(req: FastifyRequest): Promise<{
  fields: Record<string, string>;
  file: { bytes: Buffer; filename: string | undefined };
}> {
  const fields: Record<string, string> = {};
  let file: { bytes: Buffer; filename: string | undefined } | undefined;

  for await (const part of req.parts()) {
    if (part.type === 'file') {
      file = { bytes: await part.toBuffer(), filename: part.filename };
    } else if (typeof part.value === 'string') {
      fields[part.fieldname] = part.value;
    }
  }

  if (!file || file.bytes.length === 0) throw new HttpError(400, 'bad_request', 'file is required');
  if (!file.bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new HttpError(400, 'bad_request', 'file is not a PDF');
  }
  return { fields, file };
}
