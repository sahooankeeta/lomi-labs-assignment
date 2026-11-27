import { ExtractionOutput, type FieldDef } from '@lomi/shared';
import { describe, expect, it } from 'vitest';
import { FakeExtractor } from './fake.js';
import type { ExtractRequest } from './types.js';

/** Invoice v1 as unpdf parses fixtures/documents/invoice-001.pdf (copied from @lomi/extraction testdata). */
const INVOICE_V1 =
  'MERIDIAN OFFICE SUPPLIES LLC\n482 Commerce Way, Suite 210\nEastport, CA 94702\nINVOICE\nInvoice Number: INV-2025-0847\nIssue Date: 2025-09-14\nDue Date: 2025-10-14\nPayment Terms: Net 30\nBill To:\nLomi Labs Inc.\n900 Mission Street, Floor 5\nSan Francisco, CA 94103\nDescription Qty Unit Price Amount\n----------------------------------------------------------------------\nStanding desk, model SD-400 4 $589.00 $2,356.00\nErgonomic chair, model EC-220 4 $412.50 $1,650.00\nMonitor arm, dual, model MA-2 6 $89.00 $534.00\nDelivery and assembly 1 $275.00 $275.00\n----------------------------------------------------------------------\nSubtotal: $4,815.00\nSales Tax (8.625%): $415.29\nTotal Due: $5,230.29\nPlease reference the invoice number on all payments.\nPayments by ACH to the account on file. A late fee of 1.5% per month\napplies to balances outstanding past the due date.';

const FIELDS: FieldDef[] = [
  { field: 'invoice_number', type: 'string' },
  { field: 'total_amount', type: 'money' },
  { field: 'unknown_field', type: 'string' },
];

const req = (fields: FieldDef[] = FIELDS): ExtractRequest => ({
  type: 'invoice',
  fields,
  chunkText: INVOICE_V1,
  prompt: { system: '', user: '' },
});

describe('FakeExtractor', () => {
  it('has model "fake" and counts ceil(len/4) tokens', async () => {
    const fake = new FakeExtractor();
    expect(fake.model).toBe('fake');
    expect(await fake.countTokens('abcde')).toBe(2);
  });

  it('extracts invoice values with their quotes, valid against ExtractionOutput', async () => {
    const { output } = await new FakeExtractor().extract(req());
    const parsed = ExtractionOutput.parse(output);
    const total = parsed.fields.find((f) => f.field === 'total_amount');
    expect(total).toMatchObject({ value: '$5,230.29', evidence: 'Total Due: $5,230.29' });
    const num = parsed.fields.find((f) => f.field === 'invoice_number');
    expect(num).toMatchObject({
      value: 'INV-2025-0847',
      evidence: 'Invoice Number: INV-2025-0847',
    });
  });

  it('reports a gap for fields without a rule or match', async () => {
    const { output } = await new FakeExtractor().extract(req());
    const parsed = ExtractionOutput.parse(output);
    expect(parsed.fields.find((f) => f.field === 'unknown_field')).toMatchObject({
      value: null,
      evidence: null,
      gap_reason: 'not found by fake extractor',
    });
  });

  it('rejects when aborted during the delay', async () => {
    const ctrl = new AbortController();
    const p = new FakeExtractor({ delayMs: 5000 }).extract(req(), { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    await expect(p).rejects.toThrow(/abort/i);
  });

  it('rejects immediately if already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(new FakeExtractor().extract(req(), { signal: ctrl.signal })).rejects.toThrow(
      /abort/i,
    );
  });
});
