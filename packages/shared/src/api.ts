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
});
export type DocumentDetailDto = z.infer<typeof DocumentDetailDto>;

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
