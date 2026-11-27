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
 *
 * Also pulls in the carried review and the previous version's value (with its version
 * number, its newest review and its carried review) in the same query, so the detail view
 * can show what the last version said without a query per value.
 */
export async function loadValuesWithLatestReview(db: ValueReader, versionIds: string[]) {
  return db.extractedValue.findMany({
    where: { versionId: { in: versionIds } },
    include: {
      reviews: { orderBy: { createdAt: 'desc' }, take: 1 },
      carriedReview: true,
      previousValue: {
        include: {
          version: { select: { versionNo: true } },
          reviews: { orderBy: { createdAt: 'desc' }, take: 1 },
          carriedReview: true,
        },
      },
    },
  });
}

/**
 * Safety net for the recursive chain walks: chains are acyclic by construction (a value
 * only ever points at an older version's value), but a bad manual edit must not hang a query.
 */
const MAX_CHAIN_DEPTH = 1000;

/**
 * For each given value, how many earlier versions its field's chain has (following
 * `previous_value_id` back): 0 = none, 1 = only the immediate previous one. One recursive
 * query for all values, so the cost does not grow with the number of fields.
 */
export async function loadEarlierCounts(db: Db, valueIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (valueIds.length === 0) return counts;
  const rows = await db.$queryRaw<{ root: string; earlier: number }[]>`
    WITH RECURSIVE chain(root, prev, depth) AS (
      SELECT id, previous_value_id, 0 FROM extracted_values WHERE id = ANY(${valueIds}::uuid[])
      UNION ALL
      SELECT c.root, v.previous_value_id, c.depth + 1
      FROM chain c JOIN extracted_values v ON v.id = c.prev
      WHERE c.depth < ${MAX_CHAIN_DEPTH}
    )
    SELECT root::text AS root, (count(*) - 1)::int AS earlier FROM chain GROUP BY root`;
  for (const r of rows) counts.set(r.root, r.earlier);
  return counts;
}

/**
 * The ids of a value's chain: the value itself first, then each older version's value
 * (newest to oldest). Empty when the id is unknown.
 */
export async function loadChainIds(db: Db, valueId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE chain(id, prev, depth) AS (
      SELECT id, previous_value_id, 0 FROM extracted_values WHERE id = ${valueId}::uuid
      UNION ALL
      SELECT v.id, v.previous_value_id, c.depth + 1
      FROM chain c JOIN extracted_values v ON v.id = c.prev
      WHERE c.depth < ${MAX_CHAIN_DEPTH}
    )
    SELECT id::text AS id FROM chain ORDER BY depth`;
  return rows.map((r) => r.id);
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
