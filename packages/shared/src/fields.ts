import { z } from 'zod';

export const DocumentType = z.enum(['invoice', 'lease', 'market_report']);
export type DocumentType = z.infer<typeof DocumentType>;

export const FieldType = z.enum(['string', 'date', 'money', 'number', 'percent']);
export type FieldType = z.infer<typeof FieldType>;

export const FieldDef = z.object({ field: z.string(), type: FieldType });
export type FieldDef = z.infer<typeof FieldDef>;

/** Shape of fixtures/expected-fields.json. */
export const ExpectedFields = z.record(DocumentType, z.array(FieldDef));
export type ExpectedFields = z.infer<typeof ExpectedFields>;

/** Shape of fixtures/documents.json. */
export const FixtureManifest = z.array(
  z.object({
    id: z.string(),
    type: DocumentType,
    title: z.string(),
    versions: z.array(
      z.object({
        version: z.number().int().positive(),
        file: z.string(),
        note: z.string().optional(),
      }),
    ),
  }),
);
export type FixtureManifest = z.infer<typeof FixtureManifest>;
