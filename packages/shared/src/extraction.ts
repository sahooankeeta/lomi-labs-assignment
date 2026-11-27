import { z } from 'zod';

/** What the model must return for one chunk: one entry per expected field. */
export const ExtractionOutput = z.object({
  fields: z.array(
    z.object({
      field: z.string(),
      value: z.string().nullable(),
      evidence: z.string().nullable(),
      gap_reason: z.string().nullable(),
    }),
  ),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;

/** A validated per-chunk answer. Offsets index into the version's parsedText. */
export type Candidate =
  | { field: string; kind: 'value'; value: string; evidence: string; start: number; end: number }
  | { field: string; kind: 'gap'; reason: string };

/** The merged answer for one field of one version, ready to persist. */
export interface FinalValue {
  field: string;
  value: string | null;
  evidence: string | null;
  gapReason: string | null;
  /** Conflicting values from different chunks, kept on a gap. */
  candidates: { value: string; page: number }[] | null;
  evidencePage: number | null;
  evidenceStart: number | null;
  evidenceEnd: number | null;
}
