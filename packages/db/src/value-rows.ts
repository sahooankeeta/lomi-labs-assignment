import { computeProgress, deriveReviewState } from '@lomi/shared';
import type { ProgressDto, ValueReviewState } from '@lomi/shared';
import type { Db } from './client.js';

/**
 * Private to this package (not exported from index.ts): the one place that loads values
 * with their newest review and turns them into review states and progress, so the detail
 * view, the list, `getProgress` and `reviewValue` all derive their counts the same way.
 */

/** Anything with `extractedValue`: the client itself or an interactive-transaction client. */
export type ValueReader = Pick<Db, 'extractedValue'>;

/**
 * Loads the values of the given versions, each with only its newest review (reviews are
 * append-only, so the newest row is the current one).
 */
export async function loadValuesWithLatestReview(db: ValueReader, versionIds: string[]) {
  return db.extractedValue.findMany({
    where: { versionId: { in: versionIds } },
    include: { reviews: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
}

export type ValueWithLatestReview = Awaited<ReturnType<typeof loadValuesWithLatestReview>>[number];

/** A value's review state: its own newest review beats a carried one (see deriveReviewState). */
export function reviewStateOf(row: ValueWithLatestReview): ValueReviewState {
  return deriveReviewState({
    latestReviewAction: row.reviews[0]?.action ?? null,
    carriedReviewId: row.carriedReviewId,
  });
}

/**
 * Progress over one version's loaded values, counting only fields defined for the
 * document's type (`defs`), the same set the detail view lists, so a stored value for a
 * field since removed from the type never shows up in the counts. A version with no
 * values (not extracted yet) is all zeros.
 */
export function progressOf(rows: ValueWithLatestReview[], defs: { field: string }[]): ProgressDto {
  const known = new Set(defs.map((d) => d.field));
  return computeProgress(
    rows
      .filter((r) => known.has(r.field))
      .map((r) => ({ reviewState: reviewStateOf(r), isGap: r.value === null })),
  );
}
