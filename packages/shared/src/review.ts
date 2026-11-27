import { z } from 'zod';
import { ReviewAction, ValueReviewState } from './status.js';

/**
 * Review rules shared by the db read model, the api and the web UI, so the state a
 * value is shown in and the progress counts are decided in exactly one place.
 */

/**
 * Derives a value's review state from its newest own review and the review carried over
 * from the previous version.
 *
 * Precedence: a review on this version wins over a carried one (the reviewer has since
 * looked at this exact value); with neither, the value still needs a human.
 */
export function deriveReviewState(v: {
  latestReviewAction: ReviewAction | null;
  carriedReviewId: string | null;
}): ValueReviewState {
  if (v.latestReviewAction === 'approve') return 'approved';
  if (v.latestReviewAction === 'correct') return 'corrected';
  return v.carriedReviewId ? 'carried_over' : 'pending';
}

/** Counts of a version's values by review state, plus how many are gaps. */
export const ProgressDto = z.object({
  pending: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  corrected: z.number().int().nonnegative(),
  carried_over: z.number().int().nonnegative(),
  gaps: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type ProgressDto = z.infer<typeof ProgressDto>;

/**
 * Tallies review progress over a version's values.
 *
 * `gaps` is informational and overlaps the state counts: a gap that was approved or
 * corrected is still a gap, so the four state counts sum to `total` but `gaps` does not
 * add to them.
 */
export function computeProgress(
  values: { reviewState: ValueReviewState; isGap: boolean }[],
): ProgressDto {
  const progress: ProgressDto = {
    pending: 0,
    approved: 0,
    corrected: 0,
    carried_over: 0,
    gaps: 0,
    total: values.length,
  };
  for (const v of values) {
    progress[v.reviewState] += 1;
    if (v.isGap) progress.gaps += 1;
  }
  return progress;
}

/**
 * Body of `POST /values/:id/review`: approve as extracted, or correct with a new value.
 * Strings are trimmed first so whitespace-only input fails the length check, and an
 * empty note is dropped rather than stored as `''`.
 */
export const ReviewInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z
    .object({
      action: z.literal('correct'),
      value: z.string().trim().min(1).max(1000),
      note: z.string().trim().max(2000).optional(),
    })
    // Rebuilt rather than mapped per-field so an empty note leaves no `note` key at all.
    .transform(({ action, value, note }) => (note ? { action, value, note } : { action, value })),
]);
export type ReviewInput = z.infer<typeof ReviewInput>;
