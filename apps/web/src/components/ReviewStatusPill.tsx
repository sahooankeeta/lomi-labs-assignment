import { Badge } from '@mantine/core';
import type { VersionStatus } from '@lomi/shared';
import { REVIEW_STATUS_LABEL, reviewStatus } from '../lib/reviewStatus';
import { reviewColors } from '../theme';
import { StatusPill } from './StatusPill';

/**
 * Pastel pill showing the review status (Queued, Extracting, Failed, In review, Approved) as
 * text. The status is UI-only, derived from the version status and progress, because the brief
 * fixes the API's status values. A superseded version has no review status, so the raw
 * version status pill is shown instead.
 */
export function ReviewStatusPill({
  status,
  progress,
}: {
  status: VersionStatus;
  progress: { pending: number };
}) {
  const review = reviewStatus(status, progress);
  if (!review) return <StatusPill status={status} />;
  const { bg, fg } = reviewColors[review];
  return (
    <Badge bg={bg} c={fg} fw={500} size="md">
      {REVIEW_STATUS_LABEL[review]}
    </Badge>
  );
}
