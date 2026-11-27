import { effectiveValue, type ReviewDto, type ValueDto } from '@lomi/shared';

/**
 * Splits values into the three review groups shown on the detail page. Pending values
 * (gaps included) need attention; carried-over ones await a look; approved/corrected are
 * done. Input order (field order) is kept inside each group.
 */
export function groupValues(values: ValueDto[]): {
  attention: ValueDto[];
  carried: ValueDto[];
  done: ValueDto[];
} {
  return {
    attention: values.filter((v) => v.reviewState === 'pending'),
    carried: values.filter((v) => v.reviewState === 'carried_over'),
    done: values.filter((v) => v.reviewState === 'approved' || v.reviewState === 'corrected'),
  };
}

export { effectiveValue };

/** The word for a review in a label; an approve on a gap reads "confirmed absent". */
function reviewWord(review: ReviewDto | null, isGap: boolean): string {
  if (!review) return 'not reviewed';
  if (review.action === 'correct') return 'corrected';
  return isGap ? 'confirmed absent' : 'approved';
}

/**
 * The one-line "what happened since the previous version" label under a value, or null
 * when there is no previous value. Wording follows the carry-over table. The parenthesis
 * names the previous value's effective review (never its state), so a value v1 itself
 * carried still reads "approved".
 */
export function previousLabel(v: ValueDto): string | null {
  const p = v.previous;
  if (!p) return null;
  const n = p.versionNo;
  const wasGap = p.value === null;
  const word = reviewWord(p.review, wasGap);

  // The carried review is the previous value's effective review, so name it directly.
  if (v.carriedReview) {
    return `carried over from v${n} (${reviewWord(v.carriedReview, false)})`;
  }
  switch (p.change) {
    case 'value':
      return wasGap ? `was a gap in v${n} (${word})` : `was ${p.effectiveValue} in v${n} (${word})`;
    case 'gap':
      return p.review?.action === 'correct'
        ? `also a gap in v${n}, corrected to ${p.effectiveValue}`
        : `also a gap in v${n} (${word})`;
    case 'evidence':
      return `same value as v${n} (${word}), but its quote changed`;
    case null:
      return `unchanged from v${n} (not reviewed there)`;
  }
}

/** Body of a review request, as `POST /values/:id/review` takes it. */
export type ReviewBody = { action: 'approve' } | { action: 'correct'; value: string; note?: string };

/**
 * The card's primary button. A value that carries a correction and has no review of its own
 * must re-send that correction ("Keep correction"): an own approve would outrank the carried
 * correction and silently revert the value to the re-extracted text.
 */
export function primaryAction(v: ValueDto): { label: string; body: ReviewBody } {
  const carried = v.carriedReview;
  if (
    v.reviewState === 'carried_over' &&
    !v.latestReview &&
    carried?.action === 'correct' &&
    carried.correctedValue !== null
  ) {
    return {
      label: 'Keep correction',
      body: { action: 'correct', value: carried.correctedValue },
    };
  }
  return { label: v.value === null ? 'Confirm absent' : 'Approve', body: { action: 'approve' } };
}
