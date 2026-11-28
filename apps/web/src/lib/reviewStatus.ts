import type { VersionStatus } from '@lomi/shared';

/** What a reviewer cares about, derived on the client from the version status and progress. */
export type ReviewStatus = 'queued' | 'extracting' | 'failed' | 'in_review' | 'approved';

/** Display text for each review status. */
export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  queued: 'Queued',
  extracting: 'Extracting',
  failed: 'Failed',
  in_review: 'In review',
  approved: 'Approved',
};

/**
 * Maps a version's status and review progress to a review status. This is UI-only: the
 * assignment brief fixes the API's version status values, so "in review" and "approved" are
 * worked out here (extracted with pending values, or with none) rather than stored.
 * Returns null for `superseded`: the caller shows the raw version status instead.
 */
export function reviewStatus(
  status: VersionStatus,
  progress: { pending: number },
): ReviewStatus | null {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'extracting':
      return 'extracting';
    case 'failed':
      return 'failed';
    case 'extracted':
      return progress.pending > 0 ? 'in_review' : 'approved';
    case 'superseded':
      return null;
  }
}
