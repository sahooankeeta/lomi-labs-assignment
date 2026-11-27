import type { Candidate, FieldDef } from '@lomi/shared';
import { describe, expect, it } from 'vitest';
import { mergeCandidates } from './merge.js';

const fields: FieldDef[] = [
  { field: 'average_rent_1br', type: 'money' },
  { field: 'vacancy_rate', type: 'percent' },
  { field: 'median_household_income', type: 'money' },
];
const pageOffsets = [0, 1000, 2000];

const value = (field: string, v: string, start: number): Candidate => ({
  field,
  kind: 'value',
  value: v,
  evidence: `quote ${v}`,
  start,
  end: start + 10,
});
const gap = (field: string, reason: string): Candidate => ({ field, kind: 'gap', reason });

describe('mergeCandidates', () => {
  it('reports a field no chunk found as not found in document', () => {
    const out = mergeCandidates(
      fields,
      [[gap('median_household_income', 'not returned by model')], []],
      pageOffsets,
    );
    expect(out.find((v) => v.field === 'median_household_income')).toEqual({
      field: 'median_household_income',
      value: null,
      evidence: null,
      gapReason: 'not found in document',
      candidates: null,
      evidencePage: null,
      evidenceStart: null,
      evidenceEnd: null,
    });
  });

  it('keeps the first informative gap reason', () => {
    const out = mergeCandidates(
      fields,
      [
        [gap('vacancy_rate', 'not returned by model')],
        [gap('vacancy_rate', 'evidence not found in document text')],
        [gap('vacancy_rate', 'not stated')],
      ],
      pageOffsets,
    );
    expect(out[1]!.gapReason).toBe('evidence not found in document text');
  });

  it('merges equal values across chunks into the earliest one', () => {
    const out = mergeCandidates(
      fields,
      [[value('average_rent_1br', '$1,985', 1200)], [value('average_rent_1br', '1985.00', 2100)]],
      pageOffsets,
    );
    expect(out[0]).toEqual({
      field: 'average_rent_1br',
      value: '$1,985',
      evidence: 'quote $1,985',
      gapReason: null,
      candidates: null,
      evidencePage: 2,
      evidenceStart: 1200,
      evidenceEnd: 1210,
    });
  });

  it('turns conflicting values into a gap listing each with its page', () => {
    const out = mergeCandidates(
      fields,
      [
        [value('vacancy_rate', '4.2%', 10)],
        [value('vacancy_rate', '4.9%', 1500), gap('average_rent_1br', 'not stated')],
        [value('vacancy_rate', '4.20%', 2500)],
      ],
      pageOffsets,
    );
    expect(out[1]).toMatchObject({
      field: 'vacancy_rate',
      value: null,
      evidence: null,
      gapReason: 'conflicting values found: 4.2% (p.1), 4.9% (p.2)',
      candidates: [
        { value: '4.2%', page: 1 },
        { value: '4.9%', page: 2 },
      ],
      evidencePage: null,
    });
  });

  it('returns one value per field in field order', () => {
    const out = mergeCandidates(
      fields,
      [[value('median_household_income', '$70,000', 0), value('average_rent_1br', '$1,985', 5)]],
      pageOffsets,
    );
    expect(out.map((v) => v.field)).toEqual(fields.map((f) => f.field));
  });
});
