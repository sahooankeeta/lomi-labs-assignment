import type { DocumentType, FieldDef } from '@lomi/shared';

/**
 * Bump when the prompt text OR validation/normalization rules change: stored chunk results
 * hold validated candidates and are reused on resume. Stored with each chunk result.
 */
export const PROMPT_VERSION = 'v2';

const TYPE_LABEL: Record<DocumentType, string> = {
  invoice: 'invoice',
  lease: 'lease agreement',
  market_report: 'market report',
};

const SYSTEM = `You extract fields from business documents. Every answer must be backed by the document text.

Rules:
- Extract only the fields listed. Return exactly one entry per listed field, using its name as given.
- "value": the value exactly as written in the text (no reformatting, no units added or removed).
- For number, money and percent fields, "value" is the figure exactly as written in the text (e.g. 24, $2,350.00, 4.2%) without surrounding words.
- "evidence": the shortest verbatim passage from the text that contains the value, copied character for character. Prefer a label plus its value (e.g. "Issue Date: 2025-09-14"), not that line plus the next.
- If a field is not stated in the text, set "value" and "evidence" to null and give a short "gap_reason" (e.g. "not stated in this part"). Otherwise "gap_reason" is null.
- Never guess, infer, convert or compute a value (no adding line items, no date arithmetic).
- The text may be one part of a longer document. Answer only from the text you are given.`;

export function buildPrompt(
  type: DocumentType,
  fields: FieldDef[],
  chunkText: string,
  ctx: { chunkIndex: number; chunkCount: number },
): { system: string; user: string } {
  const part =
    ctx.chunkCount > 1
      ? `This is part ${ctx.chunkIndex + 1} of ${ctx.chunkCount} of the document.\n`
      : '';
  const fieldList = fields.map((f) => `- ${f.field} (${f.type})`).join('\n');
  const user = `Document type: ${TYPE_LABEL[type]}
${part}
Fields to extract:
${fieldList}

<document_text>
${chunkText}
</document_text>`;
  return { system: SYSTEM, user };
}
