// Test-time I/O only: the package source stays pure.
import { readFile } from 'node:fs/promises';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { isUnchanged } from './carry.js';
import { joinPages } from './pages.js';
import {
  INVOICE_FIELDS,
  INVOICE_V1,
  INVOICE_V1_OUTPUT,
  INVOICE_V2_OUTPUT,
  LEASE_FIELDS,
  LEASE_OUTPUT,
} from './testdata.js';
import { validateChunkOutput } from './validate.js';

const docs = new URL('../../../fixtures/documents/', import.meta.url);

async function parse(file: string): Promise<{ text: string; pageOffsets: number[] }> {
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(new URL(file, docs))));
  const { text } = await extractText(pdf, { mergePages: false });
  return joinPages(text);
}

describe('fixture PDFs', () => {
  it.each([
    ['invoice-001.pdf', 'Total Due: $5,230.29'],
    ['invoice-001.v2.pdf', 'Total Due: $6,126.45'],
    ['lease-excerpt-001.pdf', '$2,350.00'],
    ['market-report-excerpt-001.pdf', '4.2%'],
  ])('%s parses to one page containing %j', async (file, needle) => {
    const { text, pageOffsets } = await parse(file);
    expect(pageOffsets).toEqual([0]);
    expect(text).toContain(needle);
  });

  it('a correct answer for invoice v1 validates to 5 values on the real text', async () => {
    const { text } = await parse('invoice-001.pdf');
    expect(text).toBe(INVOICE_V1);
    const out = validateChunkOutput(INVOICE_V1_OUTPUT, INVOICE_FIELDS, { text, start: 0 });
    expect(out.filter((c) => c.kind === 'value')).toHaveLength(5);
  });

  it('a correct answer for the lease validates to 5 values on the real text', async () => {
    const { text } = await parse('lease-excerpt-001.pdf');
    const out = validateChunkOutput(LEASE_OUTPUT, LEASE_FIELDS, { text, start: 0 });
    expect(out.filter((c) => c.kind === 'value')).toHaveLength(5);
  });

  it('invoice v1 vs v2: exactly due_date and total_amount changed', async () => {
    const v1 = await parse('invoice-001.pdf');
    const v2 = await parse('invoice-001.v2.pdf');
    const out1 = validateChunkOutput(INVOICE_V1_OUTPUT, INVOICE_FIELDS, { text: v1.text, start: 0 });
    const out2 = validateChunkOutput(INVOICE_V2_OUTPUT, INVOICE_FIELDS, { text: v2.text, start: 0 });
    expect(out1.filter((c) => c.kind === 'value')).toHaveLength(5);
    expect(out2.filter((c) => c.kind === 'value')).toHaveLength(5);
    const changed = INVOICE_FIELDS.filter(({ field, type }) => {
      const a = INVOICE_V1_OUTPUT.fields.find((f) => f.field === field)!;
      const b = INVOICE_V2_OUTPUT.fields.find((f) => f.field === field)!;
      return !isUnchanged(a, b, v2.text, type);
    }).map((f) => f.field);
    expect(changed).toEqual(['due_date', 'total_amount']);
  });
});
