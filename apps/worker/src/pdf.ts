import { joinPages } from '@lomi/extraction';
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Extracts the text layer of a PDF, one string per page, joined into the single text the
 * rest of the pipeline works on.
 *
 * - `pageOffsets[i]` is the offset in `text` where page `i + 1` starts (see `joinPages`),
 *   so evidence offsets can be mapped back to a page.
 * - A page with no text layer contributes an empty string; the caller decides whether the
 *   whole document is too empty to use (scanned PDF).
 * - Rejects if the bytes are not a readable PDF. Does no I/O and never mutates `bytes`
 *   (pdf.js may detach the buffer it is given, so it parses a copy).
 */
export async function parsePdf(
  bytes: Uint8Array,
): Promise<{ text: string; pageOffsets: number[] }> {
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: false });
  return joinPages(text);
}
