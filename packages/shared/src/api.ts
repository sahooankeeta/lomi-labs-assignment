import { z } from 'zod';
import { DocumentType, FieldType } from './fields.js';
import { ReviewAction, ValueReviewState, VersionStatus } from './status.js';
import { ProgressDto } from './review.js';

export const UploadFields = z.object({
  type: DocumentType,
  title: z.string().trim().min(1).max(200).optional(),
});
export type UploadFields = z.infer<typeof UploadFields>;

export const ApiError = z.object({
  error: z.enum(['bad_request', 'not_found', 'conflict', 'payload_too_large', 'internal']),
  message: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;

export const ReviewDto = z.object({
  id: z.string(),
  action: ReviewAction,
  correctedValue: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type ReviewDto = z.infer<typeof ReviewDto>;

/**
 * What the previous version held for the same field, shown beside a value whose evidence
 * changed (or that carried over) so the reviewer sees what moved.
 */
export const PreviousValueDto = z.object({
  id: z.string(),
  versionNo: z.number().int(),
  value: z.string().nullable(),
  /** The previous value after its review (correction applied). */
  effectiveValue: z.string().nullable(),
  evidence: z.string().nullable(),
  evidencePage: z.number().int().nullable(),
  reviewState: ValueReviewState,
  /** Its effective review: its own latest, else the one it carried. */
  review: ReviewDto.nullable(),
  /**
   * How it differs from the shown value; null when unchanged. 'gap' = both are gaps
   * (never carried), 'evidence' = same value but its quote is gone, 'value' = otherwise.
   * Computed server-side so the UI never needs the normalizers.
   */
  change: z.enum(['value', 'evidence', 'gap']).nullable(),
});
export type PreviousValueDto = z.infer<typeof PreviousValueDto>;

export const ValueDto = z.object({
  id: z.string(),
  field: z.string(),
  fieldType: FieldType,
  value: z.string().nullable(),
  evidence: z.string().nullable(),
  gapReason: z.string().nullable(),
  candidates: z.array(z.object({ value: z.string(), page: z.number().int() })).nullable(),
  evidencePage: z.number().int().nullable(),
  evidenceStart: z.number().int().nullable(),
  evidenceEnd: z.number().int().nullable(),
  reviewState: ValueReviewState,
  latestReview: ReviewDto.nullable(),
  /** The review inherited from the previous version (set only when the value is unchanged). */
  carriedReview: ReviewDto.nullable(),
  previous: PreviousValueDto.nullable(),
  /** Earlier versions in this field's chain: 0 = none, 1 = only `previous`. */
  earlierCount: z.number().int().nonnegative(),
});
export type ValueDto = z.infer<typeof ValueDto>;

export const VersionDto = z.object({
  id: z.string(),
  versionNo: z.number().int(),
  status: VersionStatus,
  error: z.string().nullable(),
  parsedText: z.string().nullable(),
  pageOffsets: z.array(z.number().int()),
  /** ISO 8601 */
  createdAt: z.string(),
});
export type VersionDto = z.infer<typeof VersionDto>;

export const DocumentDetailDto = z.object({
  id: z.string(),
  title: z.string(),
  type: DocumentType,
  /** Status of the shown version. */
  status: VersionStatus,
  version: VersionDto,
  values: z.array(ValueDto),
  /** Review progress of the shown version's values. */
  progress: ProgressDto,
  /** The document's current version number, so a client can tell it is showing history. */
  currentVersionNo: z.number().int(),
});
export type DocumentDetailDto = z.infer<typeof DocumentDetailDto>;

/** One row of a document's version list. */
export const VersionSummaryDto = z.object({
  id: z.string(),
  versionNo: z.number().int(),
  status: VersionStatus,
  error: z.string().nullable(),
  /** ISO 8601 */
  createdAt: z.string(),
});
export type VersionSummaryDto = z.infer<typeof VersionSummaryDto>;

/** One version's take on a field, with its full review record. */
export const ValueHistoryEntryDto = z.object({
  valueId: z.string(),
  versionNo: z.number().int(),
  versionStatus: VersionStatus,
  value: z.string().nullable(),
  evidence: z.string().nullable(),
  evidencePage: z.number().int().nullable(),
  gapReason: z.string().nullable(),
  reviewState: ValueReviewState,
  carriedReview: ReviewDto.nullable(),
  /** Every own review, oldest first (reviews are append-only). */
  reviews: z.array(ReviewDto),
});
export type ValueHistoryEntryDto = z.infer<typeof ValueHistoryEntryDto>;

/** A field's history across versions, newest first, starting with the value asked for. */
export const ValueHistoryDto = z.object({
  field: z.string(),
  entries: z.array(ValueHistoryEntryDto),
});
export type ValueHistoryDto = z.infer<typeof ValueHistoryDto>;

export const DocumentSummaryDto = z.object({
  id: z.string(),
  title: z.string(),
  type: DocumentType,
  versionNo: z.number().int(),
  status: VersionStatus,
});
export type DocumentSummaryDto = z.infer<typeof DocumentSummaryDto>;

/** Answer to submitting a review: the stored review plus the value's new state and the version's progress. */
export const ReviewResultDto = z.object({
  review: ReviewDto,
  reviewState: ValueReviewState,
  progress: ProgressDto,
});
export type ReviewResultDto = z.infer<typeof ReviewResultDto>;

/** One row of the document list: the summary plus review progress and creation time. */
export const DocumentListItemDto = DocumentSummaryDto.extend({
  progress: ProgressDto,
  /** ISO 8601 */
  createdAt: z.string(),
});
export type DocumentListItemDto = z.infer<typeof DocumentListItemDto>;
