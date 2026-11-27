import type { Candidate } from '@lomi/shared';
import { describe, expect, it } from 'vitest';
import { buildPrompt } from './prompt.js';
import {
  INVOICE_FIELDS,
  INVOICE_V1,
  INVOICE_V1_OUTPUT,
  LEASE_FIELDS,
  LEASE_OUTPUT,
  LEASE_TERM_CLAUSE,
} from './testdata.js';
import { validateChunkOutput } from './validate.js';

const chunk = { text: INVOICE_V1, start: 0 };

function withField(field: string, patch: Record<string, string | null>) {
  return {
    fields: INVOICE_V1_OUTPUT.fields.map((f) => (f.field === field ? { ...f, ...patch } : f)),
  };
}

function byField(cs: Candidate[], field: string): Candidate {
  return cs.find((c) => c.field === field)!;
}

describe('validateChunkOutput', () => {
  it('accepts a correct answer for every invoice field, in field order', () => {
    const out = validateChunkOutput(INVOICE_V1_OUTPUT, INVOICE_FIELDS, chunk);
    expect(out.map((c) => [c.field, c.kind])).toEqual(
      INVOICE_FIELDS.map((f) => [f.field, 'value']),
    );
    const total = byField(out, 'total_amount');
    expect(total.kind === 'value' && INVOICE_V1.slice(total.start, total.end)).toBe(
      'Total Due: $5,230.29',
    );
  });

  it('rejects hallucinated evidence', () => {
    const out = validateChunkOutput(
      withField('total_amount', { value: '$5,300.00', evidence: 'Total Due: $5,300.00' }),
      INVOICE_FIELDS,
      chunk,
    );
    expect(byField(out, 'total_amount')).toEqual({
      field: 'total_amount',
      kind: 'gap',
      reason: 'evidence not found in document text',
    });
  });

  it('rejects a value its real quote does not state', () => {
    const out = validateChunkOutput(
      withField('total_amount', { value: '5230.30' }),
      INVOICE_FIELDS,
      chunk,
    );
    expect(byField(out, 'total_amount')).toMatchObject({
      kind: 'gap',
      reason: 'value not found in its quote',
    });
  });

  it('keeps the model gap reason for a null value', () => {
    const out = validateChunkOutput(
      withField('due_date', { value: null, evidence: null, gap_reason: 'not present' }),
      INVOICE_FIELDS,
      chunk,
    );
    expect(byField(out, 'due_date')).toEqual({
      field: 'due_date',
      kind: 'gap',
      reason: 'not present',
    });
  });

  it('falls back to "not returned by model" for a null value without a reason', () => {
    const out = validateChunkOutput(
      withField('due_date', { value: null, evidence: null, gap_reason: '  ' }),
      INVOICE_FIELDS,
      chunk,
    );
    expect(byField(out, 'due_date')).toMatchObject({
      kind: 'gap',
      reason: 'not returned by model',
    });
  });

  it('ignores unknown fields, keeps the first duplicate, gaps missing fields', () => {
    const fields = INVOICE_V1_OUTPUT.fields.filter((f) => f.field !== 'due_date');
    const output = {
      fields: [
        ...fields,
        { field: 'foo', value: 'bar', evidence: 'INVOICE', gap_reason: null },
        {
          field: 'invoice_number',
          value: 'Lomi Labs Inc.',
          evidence: 'Lomi Labs Inc.',
          gap_reason: null,
        },
      ],
    };
    const out = validateChunkOutput(output, INVOICE_FIELDS, chunk);
    expect(out.map((c) => c.field)).toEqual(INVOICE_FIELDS.map((f) => f.field));
    expect(byField(out, 'due_date')).toMatchObject({
      kind: 'gap',
      reason: 'not returned by model',
    });
    expect(byField(out, 'invoice_number')).toMatchObject({ kind: 'value', value: 'INV-2025-0847' });
  });

  it.each([null, undefined, 'nope', { fields: 'x' }, { fields: [{ field: 'invoice_number' }] }])(
    'gaps every field for malformed output %j',
    (output) => {
      const out = validateChunkOutput(output, INVOICE_FIELDS, chunk);
      expect(out).toEqual(
        INVOICE_FIELDS.map((f) => ({
          field: f.field,
          kind: 'gap',
          reason: 'not returned by model',
        })),
      );
    },
  );

  it('trims values', () => {
    const out = validateChunkOutput(
      withField('total_amount', { value: '  $5,230.29 ' }),
      INVOICE_FIELDS,
      chunk,
    );
    expect(byField(out, 'total_amount')).toMatchObject({ kind: 'value', value: '$5,230.29' });
  });

  it('uses the first occurrence inside the chunk and shifts by the chunk start', () => {
    const text = 'Rate: 4.2% here.\n\nAgain Rate: 4.2% there.';
    const fields = [{ field: 'vacancy_rate', type: 'percent' as const }];
    const output = {
      fields: [{ field: 'vacancy_rate', value: '4.2%', evidence: 'Rate: 4.2%', gap_reason: null }],
    };
    expect(validateChunkOutput(output, fields, { text, start: 0 })[0]).toMatchObject({
      start: 0,
      end: 10,
    });
    expect(validateChunkOutput(output, fields, { text, start: 1000 })[0]).toMatchObject({
      start: 1000,
      end: 1010,
    });
  });
});

describe('validateChunkOutput numeric values with words', () => {
  it('accepts "twenty-four (24)" for term_months and slices offsets to the evidence', () => {
    const out = validateChunkOutput(LEASE_OUTPUT, LEASE_FIELDS, {
      text: LEASE_TERM_CLAUSE,
      start: 0,
    });
    const term = byField(out, 'term_months');
    expect(term).toMatchObject({ kind: 'value', value: 'twenty-four (24)' });
    expect(term.kind === 'value' && LEASE_TERM_CLAUSE.slice(term.start, term.end)).toBe(
      'twenty-four (24)\nmonths',
    );
  });
});

describe('buildPrompt', () => {
  it('lists every field and wraps the chunk text', () => {
    const { system, user } = buildPrompt('invoice', INVOICE_FIELDS, INVOICE_V1, {
      chunkIndex: 1,
      chunkCount: 3,
    });
    expect(system).toContain('shortest verbatim passage');
    expect(system).toContain('without surrounding words');
    for (const f of INVOICE_FIELDS) expect(user).toContain(`${f.field} (${f.type})`);
    expect(user).toContain(INVOICE_V1);
    expect(user).toContain('part 2 of 3');
  });

  it('does not claim a part for a single-chunk document', () => {
    const { user } = buildPrompt('invoice', INVOICE_FIELDS, 'x', { chunkIndex: 0, chunkCount: 1 });
    expect(user).not.toContain('part 1 of 1');
  });
});
