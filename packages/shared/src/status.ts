import { z } from 'zod';

/** Lifecycle of one document version's extraction. */
export const DocumentStatus = z.enum(['queued', 'extracting', 'extracted', 'failed']);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

/** Review state of one extracted value, as shown to the reviewer. */
export const ValueReviewState = z.enum(['pending', 'approved', 'corrected', 'carried_over']);
export type ValueReviewState = z.infer<typeof ValueReviewState>;

export const ReviewAction = z.enum(['approve', 'correct']);
export type ReviewAction = z.infer<typeof ReviewAction>;
