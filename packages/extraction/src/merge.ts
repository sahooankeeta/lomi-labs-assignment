import type { Candidate, FieldDef, FinalValue } from '@lomi/shared';
import { pageOf } from './pages.js';
import { NOT_RETURNED } from './validate.js';
import { normalizeValue } from './values.js';

export const NOT_FOUND = 'not found in document';

type ValueCandidate = Extract<Candidate, { kind: 'value' }>;

function gapValue(
  field: string,
  reason: string,
  candidates: FinalValue['candidates'] = null,
): FinalValue {
  return {
    field,
    value: null,
    evidence: null,
    gapReason: reason,
    candidates,
    evidencePage: null,
    evidenceStart: null,
    evidenceEnd: null,
  };
}

/**
 * One value or gap per field, in `fields` order. Equal values (by per-type canonical form)
 * collapse to the earliest chunk's; different values become a conflict gap, never a pick.
 */
export function mergeCandidates(
  fields: FieldDef[],
  perChunk: Candidate[][],
  pageOffsets: number[],
): FinalValue[] {
  return fields.map(({ field, type }) => {
    const all = perChunk.flatMap((cs) => cs.filter((c) => c.field === field));
    const values = all.filter((c): c is ValueCandidate => c.kind === 'value');

    if (values.length === 0) {
      const informative = all.find((c) => c.kind === 'gap' && c.reason !== NOT_RETURNED);
      return gapValue(field, informative?.kind === 'gap' ? informative.reason : NOT_FOUND);
    }

    const distinct = new Map<string, ValueCandidate>();
    for (const c of values) {
      const key = normalizeValue(c.value, type) ?? c.value;
      if (!distinct.has(key)) distinct.set(key, c);
    }

    if (distinct.size === 1) {
      const first = values[0]!;
      return {
        field,
        value: first.value,
        evidence: first.evidence,
        gapReason: null,
        candidates: null,
        evidencePage: pageOf(first.start, pageOffsets),
        evidenceStart: first.start,
        evidenceEnd: first.end,
      };
    }

    const candidates = [...distinct.values()].map((c) => ({
      value: c.value,
      page: pageOf(c.start, pageOffsets),
    }));
    const listed = candidates.map((c) => `${c.value} (p.${c.page})`).join(', ');
    return gapValue(field, `conflicting values found: ${listed}`, candidates);
  });
}
