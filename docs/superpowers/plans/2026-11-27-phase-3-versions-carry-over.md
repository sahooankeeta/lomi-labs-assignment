# Phase 3 — Re-extraction & Carry-over Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reviewer uploads a revised PDF as a new version of a document. Any unfinished older
version is superseded. Once the new version is extracted, every value whose evidence didn't change
inherits its previous review, and only the changed fields are pending: `invoice-001.v2.pdf` after a
fully reviewed v1 leaves exactly `due_date` and `total_amount` pending. Older versions stay
viewable read-only.

**Architecture:** The "unchanged" rule is a pure function in `@lomi/extraction`. `finishVersion`
runs it inside its existing guarded transaction against the latest `extracted` version older than
this one, and writes `previousValueId` / `carriedReviewId` along with the values. `createVersion` in
`@lomi/db` locks the document row `FOR UPDATE`, which is the lock Phase 2's `reviewValue` already
waits on with `FOR SHARE`. It dedupes against the current version's sha256, supersedes
queued/extracting versions, abandons their running runs and moves `currentVersionId`. The api adds
two version routes. The web detail page gets a version switcher, a read-only history view, an
"upload new version" control, and "was X in v1" / "carried over from v1" lines on the value cards.

**Tech Stack:** pnpm monorepo, TypeScript ESM, Fastify 5, Prisma 7.10.1, Zod 4, Vitest, Vite 8 +
React 19 + TanStack Query 5 + react-router 8, Mantine 9.8.2. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-26-extraction-review-design.md`. Read the sections
"Carry-over (\"unchanged evidence\")", "Ingest and versions", "Data model", "API", "UI" and
"Routes (summary)" first. This plan implements the spec's Phase 3. The Phase 2 plan
(`docs/superpowers/plans/2026-11-27-phase-2-review.md`) shows the conventions this one follows.

## Global Constraints

- **Unchanged** ⇔ both previous and new are non-gap values, their normalized values are equal
  (`normalizeValue(_, fieldType)`), **and** the previous version's evidence still appears verbatim
  (normalized: `findQuote`) in the new version's `parsedText`. Offsets and pages are never compared.
- Carry-over compares against the **latest `extracted` version older than this one**. Superseded
  and failed versions have no values and are skipped.
- `previousValueId` is set whenever the previous extracted version has a value for the field,
  changed or not. `carriedReviewId` is set only when the value is unchanged, and it is the previous
  value's effective review: its own latest review, else what it itself carried. With nothing to
  carry it stays null and the value is pending.
- Gaps never carry over (builder call, documented), including a gap that was "confirmed absent".
- A value whose evidence changed (different value, quote gone, or either side a gap) goes back to
  `pending`. Its card shows the previous version's value, quote and review beside it, so the
  reviewer sees what changed. When only the quote changed, the card says so, instead of showing the
  same value as "was".
- `POST /documents/:id/versions` (multipart `file`) runs in one transaction that locks the document
  row `FOR UPDATE`. The new number is `max(versionNo) + 1`. Every `queued`/`extracting` version of
  the document becomes `superseded`, and `currentVersionId` points at the new one. → `201`.
  Re-uploading the current version's sha256 → `200` with the current version, nothing created or
  enqueued. Dedupe is against the **current** version only, so re-uploading an older file (a revert)
  creates a new version.
- Values, reviews and old versions are never updated or deleted. Superseding changes only the
  version's `status` (and clears its lease) and marks its `running` runs `abandoned`.
- Derived state stays as in Phase 2: own latest review → `approved`/`corrected`; else
  `carriedReviewId` → `carried_over`; else `pending`. Only the current, `extracted` version is
  reviewable (`409` otherwise). Old versions are read-only in the UI as well.
- The api never calls the LLM and never parses PDFs. Errors are `{ error, message }`. Zod schemas
  live in `@lomi/shared`.
- The UI polls every `2000` ms, only while something shown is `queued` or `extracting`.
- Turbo is blocked on this machine: use `pnpm -r run build|lint|typecheck|test` or
  `pnpm --filter <pkg> <script>`. Integration suites need the native PG 19 on 5432 (via `.env`) and
  must run **one package at a time** (they share `lomi_test`).
- Every task adds doc comments on new exports plus "why" comments, and updates the README section
  it touches (user rule).
- UI is Mantine components only (`Select`, `FileInput`, `Button`, `Alert`, `Text`, `Anchor`, …), no
  other UI library.
- Commit after each task with conventional prefixes and the repo's `Co-Authored-By` trailer. Never
  push.

## Carry-over table

"v1" means the latest `extracted` version older than the new one. This table is the contract the
tests in Tasks 1, 2, 4 and 6 pin, and Task 7 copies it into the README.

| # | Previous (v1) | New (v2) | v2 state | Card label |
|---|---|---|---|---|
| 1 | Value, approved | Same value, v1's quote found in v2's text | `carried_over` (v1's approval) | carried over from v1 (approved) |
| 2 | Value, corrected | Same value, quote found | `carried_over`; effective value = the correction | carried over from v1 (corrected) |
| 3 | Value carried over from an earlier version, no review of its own (e.g. v1 approved → v2 carried → now v3) | Same value, quote found | `carried_over` (the original review, passed along the chain) | carried over from v2 (approved) |
| 4 | Value, never reviewed | Same value, quote found | `pending` (nothing to carry) | unchanged from v1 (not reviewed there) |
| 5 | Value (any review) | Different value | `pending` | was $5,230.29 in v1 (approved / corrected / not reviewed) |
| 6 | Value (any review) | Same value, v1's quote **not** in v2's text | `pending` | same value as v1 (approved / corrected / not reviewed), but its quote changed |
| 7 | Value (any review) | Gap | `pending` | was $5,230.29 in v1 (approved / corrected / not reviewed) |
| 8 | Gap (any review) | Value | `pending` | was a gap in v1 (confirmed absent / corrected / not reviewed) |
| 9 | Gap, confirmed absent | Gap | `pending`: **gaps never carry** | also a gap in v1 (confirmed absent) |
| 10 | Gap, corrected (value supplied) | Gap | `pending` | also a gap in v1, corrected to 52000 |
| 11 | Gap, never reviewed | Gap | `pending` | also a gap in v1 (not reviewed) |
| 12 | No extracted older version (v1 superseded or failed) | Anything | `pending`, no previous link | none |

- **"Same value"** means equal after per-type normalization:
  - money, numbers and percents compare by digits (`$5,230.29` = `5230.29`);
  - dates compare by parsed date (`2025-09-14` = `September 14, 2025`);
  - strings compare case-insensitively.
- **"Quote found"** means v1's quote appears anywhere in v2's text after both sides are normalized
  the same way: Unicode NFKC, curly quotes and dashes to ASCII, whitespace runs collapsed.
  Positions and pages are never compared, so a quote that moved to another line or page (the
  whole text shifted) still counts as found.
- The README states both beside the table.

A field removed from `expected-fields.json` is simply not shown (the read model already lists only
defined fields), so the table has no row for it.

Two rules hold in every row:
- A review made on v2 always beats a carried one.
- v1's values and reviews are never changed. v1 is read-only once v2 exists, so v1 stays as it was
  when v2 was extracted.

## Review Focus

1. **Double-clicking "Upload new version" with the same file** → one new version (v2), and the
   second request gets `200` with v2. It must not create v3. Pinned in Task 3
   (`concurrent identical uploads create one new version`).
2. **v2 uploaded while v1 is still extracting** → v1 ends `superseded` with zero values, its run
   `abandoned` (not left `running`). The old run's renew and finish are refused, and v2 has no
   `previous` links. Pinned in Tasks 3 and 4 (`supersedes an extracting v1` and
   `v2 during v1 extraction`).
3. **A value whose quote moved** (lines inserted above it, a different page) but whose text is the
   same → still carried. **The same value with its quote gone** → pending. Pinned in Task 1.
4. **A corrected v1 value that is unchanged in v2** → v2 shows `carried_over`, and its effective
   value is the correction, not the re-extracted text. Pinned in Tasks 2 and 4.
5. **Reverting**: uploading v1's file again while v2 is current → creates v3, which carries from v2
   (the latest extracted older version), and reviewing a v1 value afterwards gets `409`. Pinned in
   Tasks 3 and 4.

## Execution order

```
T1 pure carry rule → T2 DTOs + read model → T3 db createVersion/listVersions
→ T4 carry-over in finish + worker → T5 api routes → T6 web → T7 docs, compose, browser check
```

Sequential: each task consumes the previous one's interfaces.

## File map

| File                                                | Task | Responsibility                                          |
| --------------------------------------------------- | ---- | ------------------------------------------------------- |
| `packages/extraction/src/carry.ts` (+ test)         | 1    | `isUnchanged`                                           |
| `packages/extraction/src/fixtures.test.ts`          | 1    | invoice v1 vs v2 on the real parsed text                |
| `packages/extraction/src/testdata.ts`               | 1    | `INVOICE_V2_OUTPUT`                                     |
| `packages/shared/src/api.ts`, `review.ts` (+ test)  | 2    | new DTO fields, `effectiveValue`                        |
| `packages/db/src/value-rows.ts`, `documents.ts`     | 2    | read model fills `previous`, `carriedReview`            |
| `packages/db/src/versions.ts` (+ int test)          | 3    | `createVersion`, `listVersions`                         |
| `packages/db/src/coordination.ts`, `carry.int.test.ts` | 4 | carry-over in `finishVersion`                           |
| `apps/worker/src/pipeline.ts` (+ int test)          | 4    | passes field defs to finish; v1→v2 end to end           |
| `apps/api/src/upload.ts`, `routes/versions.ts`      | 5    | shared multipart reader; the two version routes         |
| `apps/api/src/versions.int.test.ts`                 | 5    | route tests                                             |
| `apps/web/src/lib/values.ts`, `lib/versions.ts`, `lib/format.ts` | 6 | `previousLabel`, `versionOptions`, `uploadErrorMessage` |
| `apps/web/src/pages/DocumentDetail.tsx`, `components/ValueCard.tsx`, `components/VersionBar.tsx` | 6 | switcher, upload, read-only, labels |
| `apps/web/src/components/ValueHistory.tsx`          | 6    | per-field history drawer                                |
| `packages/db/src/documents.ts` (`getValueHistory`), `apps/api/src/routes/versions.ts` (`GET /values/:id/history`) | 2, 5 | value history |
| `docs/decisions/0009-versions-and-carry-over.md`, `README.md` | 7 | docs                                    |

---

### Task 1: Pure carry-over rule

**Files:**
- Create: `packages/extraction/src/carry.ts`, `packages/extraction/src/carry.test.ts`
- Modify: `packages/extraction/src/index.ts` (export), `packages/extraction/src/testdata.ts`
  (add `INVOICE_V2_OUTPUT`), `packages/extraction/src/fixtures.test.ts`

**Interfaces:**
- Consumes: `normalizeValue(value, type)`, `findQuote(quote, haystack)` (same package).
- Produces:
  - `isUnchanged(prev: { value: string | null; evidence: string | null }, next: { value: string | null }, newText: string, type: FieldType): boolean`
  - `INVOICE_V2_OUTPUT`: `INVOICE_V1_OUTPUT` with `due_date` = `2025-11-13` / `Due Date: 2025-11-13`
    and `total_amount` = `$6,126.45` / `Total Due: $6,126.45`.

- [ ] **Step 1: Write the failing tests** in `carry.test.ts` (a decision table). Use `newText` built
  from `INVOICE_V1`:
  - `same value, quote present → true`: prev `{ value: '$5,230.29', evidence: 'Total Due: $5,230.29' }`, next `'$5,230.29'`, money → `true`
  - `formatting-only difference still unchanged`: next `'5230.29'` → `true`; a date `'2025-09-14'` vs `'September 14, 2025'` with prev evidence `'Issue Date: 2025-09-14'` → `true`
  - `quote moved is still unchanged`: `newText = 'NEW HEADER LINE\n\n' + INVOICE_V1` → `true`
  - `whitespace differences in the quote still match`: prev evidence `'Total  Due:\n$5,230.29'` → `true`
  - `value changed → false`: next `'$6,126.45'`
  - `quote gone → false`: same value, but `newText` has `Total Due: $5,230.29` replaced with `Amount Payable: $5,230.29`
  - `either side a gap → false`: prev `{ value: null, evidence: null }`; next `{ value: null }`
  - `next value not parseable as the type → false`: money next `'abc'`
- [ ] **Step 2: Write the failing fixture test** in `fixtures.test.ts`:
  `invoice v1 vs v2: exactly due_date and total_amount changed`. Parse both PDFs, validate
  `INVOICE_V1_OUTPUT` on v1 and `INVOICE_V2_OUTPUT` on v2 (both 5 values), then compute the fields
  where `!isUnchanged(v1, v2, v2Text, type)` → `['due_date', 'total_amount']`.
- [ ] **Step 3:** `pnpm --filter @lomi/extraction test` → FAIL (`isUnchanged` not exported).
- [ ] **Step 4:** Implement `isUnchanged`. Both values must normalize (non-null) and be equal, and
  `findQuote(prev.evidence, newText) !== null`.
- [ ] **Step 5:** `pnpm --filter @lomi/extraction test` → PASS.
- [ ] **Step 6: Commit** `feat(extraction): unchanged-evidence rule for carry-over`.

### Task 2: DTOs, effective value, and the read model's previous/carried data

**Files:**
- Modify: `packages/shared/src/api.ts`, `packages/shared/src/review.ts`, `packages/shared/src/review.test.ts`,
  `packages/db/src/value-rows.ts`, `packages/db/src/documents.ts`, `packages/db/src/documents.int.test.ts`

**Interfaces:**
- Produces (`@lomi/shared`):
  - `PreviousValueDto = { id: string; versionNo: int; value: string | null; effectiveValue: string | null; evidence: string | null; evidencePage: int | null; reviewState: ValueReviewState; review: ReviewDto | null; change: 'value' | 'evidence' | 'gap' | null }`.
    `review` is the previous value's effective review: its own latest review, else its carried one.
    `change` comes from Task 1's `isUnchanged(previous, current, shownVersion.parsedText, fieldType)`:
    - `null` when unchanged;
    - `'gap'` when both are gaps (never carried, so the reviewer looks again);
    - `'evidence'` when both are values, they normalize equal, and only the quote is gone;
    - `'value'` otherwise (a different value, or exactly one side a gap).

    The read model computes `change`, so the UI never needs the normalizers.
  - `ValueDto` gains `carriedReview: ReviewDto | null`, `previous: PreviousValueDto | null` and
    `earlierCount: int`. `earlierCount` is the number of earlier versions in this field's chain,
    found by following `previousValueId` back: 0 = none, 1 = only `previous`.
  - `ValueHistoryEntryDto = { valueId: string; versionNo: int; versionStatus: VersionStatus; value: string | null; evidence: string | null; evidencePage: int | null; gapReason: string | null; reviewState: ValueReviewState; carriedReview: ReviewDto | null; reviews: ReviewDto[] }`.
    `reviews` holds every own review, oldest first (they are append-only, so this is the full
    record).
  - `ValueHistoryDto = { field: string; entries: ValueHistoryEntryDto[] }`. Entries run newest
    first, starting with the value asked for.
  - `DocumentDetailDto` gains `currentVersionNo: int` (so a client can tell it is showing history).
  - `VersionSummaryDto = { id: string; versionNo: int; status: VersionStatus; error: string | null; createdAt: string }`.
  - `effectiveValue(v: { value: string | null; latestReview: { action: ReviewAction; correctedValue: string | null } | null; carriedReview: { action: ReviewAction; correctedValue: string | null } | null }): string | null`.
    If there is an own latest review, it decides: `correct` → its `correctedValue`, `approve` → `value`.
    Otherwise a carried `correct` → its `correctedValue`. Otherwise `value`.
- Produces (`@lomi/db`): `getDocumentDetail` fills the new fields. `loadValuesWithLatestReview` also
  includes `carriedReview` and `previousValue` (with its version's `versionNo`, its newest review and
  its `carriedReview`), in the same single query, with no per-value queries. `earlierCount` comes
  from one `WITH RECURSIVE` query over `previous_value_id` for all the shown values.
- Produces (`@lomi/db`): `getValueHistory(db: Db, valueId: string): Promise<ValueHistoryDto | null>`
  (`null` = unknown value). It walks the chain with the same recursive query, then loads each
  entry's reviews and carried review in one query.

- [ ] **Step 1: Write the failing unit tests** (`review.test.ts`) for `effectiveValue`:
  own `correct('X')` → `'X'`; own `approve` over a carried `correct('X')` → `value`; no own review and
  carried `correct('X')` → `'X'`; nothing → `value`; gap with nothing → `null`.
- [ ] **Step 2:** `pnpm --filter @lomi/shared test` → FAIL. Implement. → PASS.
- [ ] **Step 3: Write the failing int tests** (`documents.int.test.ts`). Build v1 and v2 directly
  with Prisma, as the existing `carried_over` test does:
  - `shows the previous value and its review for a changed value`: v1 `total` `'$5,230.29'`
    approved, v2 `total` `'$6,126.45'` with `previousValueId` = v1's and no carried review. v2's value
    has `reviewState: 'pending'`, `carriedReview: null` and `previous` `{ versionNo: 1, value: '$5,230.29', effectiveValue: '$5,230.29', evidence: 'Total Due: $5,230.29', reviewState: 'approved', change: 'value' }`, with `previous.review.action === 'approve'`.
  - `only the quote changed → change 'evidence'`: same value `'$5,230.29'` in v1 and v2, but v2's
    `parsedText` has no `Total Due: $5,230.29` → `previous.change === 'evidence'`.
  - `an unchanged carried value → change null`.
  - `a gap in both versions → change 'gap'`: v1 gap approved (confirmed absent), v2 gap →
    `reviewState: 'pending'`, `carriedReview: null`, `previous.change === 'gap'`.
  - `the previous review's note is returned`: v1 corrected with `note: 'per PO'` →
    `previous.review.note === 'per PO'`.
  - `a carried correction is the effective value`: v1 corrected to `'5000'`, v2 `carriedReviewId` =
    that review → `reviewState: 'carried_over'`, `carriedReview.correctedValue === '5000'`,
    `effectiveValue(dto) === '5000'`.
  - `currentVersionNo is the current version even when viewing ?version=1`: `=== 2`.
  - Values with no previous version: `previous === null`, `carriedReview === null`, `earlierCount === 0`.
  - `earlierCount follows the chain`: in a v1 → v2 → v3 chain, v3's value has `earlierCount === 2`
    and v2's (viewed with `?version=2`) has `1`.
  - `getValueHistory returns the chain newest first with every review`: v1 approved, then corrected
    (2 reviews); v2 carried; v3 value. The result is `entries.map(e => e.versionNo)` `[3, 2, 1]`,
    v1's `reviews` has the actions `['approve', 'correct']` in that order, and v2's entry has
    `carriedReview` set. An unknown id → `null`.
- [ ] **Step 4:** `pnpm --filter @lomi/db test:integration` → FAIL. Implement. → PASS (all suites).
- [ ] **Step 5:** `pnpm -r run typecheck` → exit 0. Web still compiles, since the new fields are
  additions. **Commit** `feat(shared,db): previous value, carried review and current version in the detail`.

### Task 3: DB — create a version (supersede, dedupe) and list versions

**Files:**
- Create: `packages/db/src/versions.ts`, `packages/db/src/versions.int.test.ts`
- Modify: `packages/db/src/index.ts` (export); the `reviewValue` doc comment in `reviews.ts` (it
  says "Phase 3's new-version transaction"; name `createVersion`)

**Interfaces:**
- Consumes: `VersionSummaryDto` (Task 2).
- Produces:
  - `createVersion(db: Db, documentId: string, input: { fileKey: string; sha256: string }): Promise<CreateVersionResult>`
  - `type CreateVersionResult = { kind: 'created'; versionId: string; versionNo: number; attempts: 0; superseded: string[] } | { kind: 'unchanged'; versionId: string } | { kind: 'not_found' }`
  - `listVersions(db: Db, documentId: string): Promise<VersionSummaryDto[] | null>`: newest
    first; `null` = unknown document.

`createVersion` is one interactive `$transaction`, in this order:
1. `SELECT id FROM documents WHERE id = $1::uuid FOR UPDATE` (`$queryRaw`). No row → `not_found`.
2. Load the current version. Same `sha256` → `unchanged` with its id.
3. `versionNo = max(versionNo) + 1` (aggregate under the lock, so two uploads can't share a number;
   `@@unique([documentId, versionNo])` is the backstop).
4. `updateMany` the document's versions with status `queued`/`extracting` → `superseded`,
   `leaseExpiresAt: null`. Keep `activeRunId`: it records which run held the version, and every
   worker guard also checks `status = 'extracting'`. Then `extractionRun.updateMany` their `running`
   runs → `abandoned` with `finishedAt`, because a run that loses its lease returns without marking
   itself.
5. Create the version (`queued`) and point `currentVersionId` at it.

- [ ] **Step 1: Write the failing int tests** (`versions.int.test.ts`; use `createDocumentWithV1`
  and direct Prisma updates for statuses):
  - `creates v2 as the current queued version; an extracted v1 is untouched` (v1 stays `extracted`)
  - `supersedes a queued v1`
  - `supersedes an extracting v1 and abandons its run`: `claimVersion` v1, then `createVersion`.
    v1 is `superseded`, its run is `abandoned`. Then `renewLease(old run)` → `false`, and
    `finishVersion(old run, values, { fields })` → `'stale'` with `extractedValue.count() === 0`.
    `finishVersion` gains `opts` in Task 4: write this assertion now with the current 4-argument
    call, and Task 4 updates it.
  - `a failed v1 stays failed` (history, not superseded)
  - `same file as the current version → unchanged; no row, no supersede`
  - `concurrent identical uploads create one new version`: `Promise.all` of two identical calls →
    one `created` with `versionNo: 2` and one `unchanged` with the same id; `documentVersion.count() === 2`
  - `concurrent different uploads get versions 2 and 3`, and the current version is the 3
  - `re-uploading v1's file while v2 is current creates v3` (revert)
  - `not_found for an unknown document`
  - `a v1 value is not reviewable once v2 exists`: an extracted v1 with one value, `createVersion`,
    then `reviewValue(v1 value, approve)` → `not_reviewable`, `review.count() === 0`
  - `listVersions` → `[v2 queued, v1 superseded]` newest first; unknown → `null`
- [ ] **Step 2:** `pnpm --filter @lomi/db test:integration` → FAIL (`createVersion` not exported).
- [ ] **Step 3:** Implement `versions.ts`.
- [ ] **Step 4:** `pnpm --filter @lomi/db test:integration` → PASS (all suites).
- [ ] **Step 5: Commit** `feat(db): new versions supersede unfinished ones; list versions`.

### Task 4: Carry-over in finish, and the worker end to end

**Files:**
- Modify: `packages/db/src/coordination.ts` (`finishVersion`), `packages/db/src/coordination.int.test.ts`
  (existing calls pass `{ fields }`), `packages/db/src/versions.int.test.ts` (the Task 3 call),
  `apps/worker/src/pipeline.ts`, `apps/worker/src/pipeline.int.test.ts`
- Create: `packages/db/src/carry.int.test.ts`

**Interfaces:**
- Consumes: `isUnchanged` (Task 1), `createVersion` (Task 3), `loadValuesWithLatestReview` (Task 2).
- Produces: `finishVersion(db: Db, versionId: string, runId: string, values: FinalValue[], opts: { fields: FieldDef[] }): Promise<'finished' | 'stale'>`.
  `opts.fields` are the document type's field definitions, giving each field's type. The worker
  passes `expected`, which it already has.

Inside the existing transaction, after the guarded update succeeds and before `createMany`:
1. Read this version's `documentId`, `versionNo` and `parsedText`.
2. Find the latest older `extracted` version of the same document
   (`versionNo < this`, ordered `desc`). If there is none, write the values with null links, as today.
3. Load its values with their newest review and their own `carriedReviewId`. For each new value
   whose field has a previous value: `previousValueId = prev.id`. If the field has a type in
   `opts.fields` and `isUnchanged(prev, next, parsedText, type)`, then
   `carriedReviewId = prev.reviews[0]?.id ?? prev.carriedReviewId ?? null`.

The previous version's reviews can't change during this: it stopped being current when this
version was created, so `reviewValue` rejects reviews on it. Say so in a comment.

- [ ] **Step 1: Write the failing int tests** (`carry.int.test.ts`). Use a helper that builds an
  extracted v1 with given values and reviews through Prisma, then a v2 claimed (`claimVersion`) with
  `parsedText` set and finished through `finishVersion`. Use `INVOICE_V1`-style text, with an
  invoice field set that includes `total` (money) and `vendor` (string):
  - `carries the review of an unchanged value; a changed value is pending with its previous link`
  - `same value but its quote is gone from the new text → pending, previousValueId set`
  - `an unreviewed previous value → previousValueId set, carriedReviewId null, pending`
  - `a confirmed-absent gap never carries`
  - `carries a correction` → state `carried_over`, and `getDocumentDetail` shows `carriedReview.action === 'correct'`
  - `carries what the previous value itself carried (v1 → v2 → v3)`: v1 approved, v2 carried and
    unreviewed, v3 carries v1's review id
  - `skips superseded and failed versions`: v1 extracted and approved, v2 superseded, v3 failed, v4
    links to v1
  - `a field missing from opts.fields never carries`
  - `first version: every link null`
- [ ] **Step 2:** `pnpm --filter @lomi/db test:integration` → FAIL. Implement. Update the existing
  callers to pass `{ fields }`. → PASS (all suites).
- [ ] **Step 3: Write the failing worker int tests** (`pipeline.int.test.ts`; `FakeExtractor`, real fixtures):
  - `v2 of the invoice carries three approved values and leaves two pending`:
    1. Seed `invoice-001.pdf` and process it, then approve all 5 values with `reviewValue`.
    2. `files.put(invoice-001.v2.pdf)`, `createVersion`, `processVersion(v2)` → `'finished'`.
    3. `getDocumentDetail`: `invoice_number`, `issue_date` and `vendor_name` are `carried_over`.
       `due_date` and `total_amount` are `pending`, with `previous.value` `'2025-10-14'` and
       `'$5,230.29'`. Progress is `{ pending: 2, approved: 0, corrected: 0, carried_over: 3, gaps: 0, total: 5 }`.
  - `v2 during v1 extraction`:
    1. Start `processVersion(v1)` with `FakeExtractor({ delayMs: 300 })` (do not await), and wait
       until v1 is `extracting`.
    2. `createVersion(v2)`, then await v1's run → `'stale'`. v1 is `superseded` with 0 values.
    3. `processVersion(v2)` → `'finished'`, and every v2 value has `previousValueId === null`.
- [ ] **Step 4:** Pass `{ fields: expected }` to `finishVersion` in `pipeline.ts`. Then run
  `pnpm --filter @lomi/worker test:integration` → PASS, followed by `pnpm -r run typecheck` → exit 0.
- [ ] **Step 5: Commit** `feat: carry reviews over to unchanged values in a new version`.

### Task 5: API — version routes

**Files:**
- Create: `apps/api/src/upload.ts`, `apps/api/src/routes/versions.ts`, `apps/api/src/versions.int.test.ts`
- Modify: `apps/api/src/routes/documents.ts` (use `readPdfUpload`; move `summarize` and
  `fireEnqueue` into a module both route files import, e.g. `apps/api/src/routes/common.ts`),
  `apps/api/src/app.ts` (register), README "API" table

**Interfaces:**
- Consumes: `createVersion`, `listVersions` (Task 3); `deps.files.put`; `deps.enqueue`.
- Produces:
  - `readPdfUpload(req: FastifyRequest): Promise<{ fields: Record<string, string>; file: { bytes: Buffer; filename: string | undefined } }>`.
    It throws `HttpError(400, 'bad_request', 'file is required')` or `'file is not a PDF'`, the same
    checks and messages `POST /documents` has today. A 413 still comes from the multipart limit.
  - `POST /documents/:id/versions` (multipart `file`): `400` for a bad uuid, which is checked before
    reading the body. Then the file is put, then `createVersion`:
    - `created` → `201 DocumentSummaryDto` and `fireEnqueue(versionId, 0)`;
    - `unchanged` → `200 DocumentSummaryDto`, not enqueued;
    - `not_found` → `404`. The file is already stored by then, which is harmless: it is
      content-addressed. Say so in a comment.

    Other errors: `400` no file or not a PDF, `413`.
  - `GET /documents/:id/versions` → `200 VersionSummaryDto[]`; `400` bad uuid; `404`.
  - `GET /values/:id/history` → `200 ValueHistoryDto` (from `getValueHistory`, Task 2); `400` bad
    uuid; `404` unknown value. This is what makes earlier versions' reviews queryable in full,
    not only the latest one.

- [ ] **Step 1: Write the failing tests** (`versions.int.test.ts`). Reuse the app/upload helpers
  pattern from `documents.int.test.ts`, with `invoice-001.v2.pdf` as the second file:
  - `POST versions → 201 v2 queued, enqueued once with (v2 id, 0) after commit`
  - `the same bytes as the current version → 200 with the current versionNo; enqueue not called`
  - `uploading v2 twice → second is 200 with versionNo 2`
  - `non-PDF → 400 'file is not a PDF'`; `no file part → 400 'file is required'`; `over 20 MB → 413`
  - `unknown document → 404`; `non-uuid id → 400`
  - `GET versions → [{ versionNo: 2, status: 'queued' }, { versionNo: 1, status: 'superseded' }]`; unknown → `404`
  - `GET /documents/:id?version=1 after v2 → status 'superseded', currentVersionNo 2`
  - `GET /values/:id/history → 200` with entries newest first; unknown → `404`; non-uuid → `400`
  - `POST /documents` still passes its old tests after the refactor
- [ ] **Step 2:** `pnpm --filter @lomi/api test:integration` → FAIL (404 route not found).
- [ ] **Step 3:** Implement. Every route comment states its statuses, as the existing ones do.
- [ ] **Step 4:** `pnpm --filter @lomi/api test:integration` → PASS (all suites), then
  `pnpm --filter @lomi/api lint typecheck` → exit 0.
- [ ] **Step 5:** Add both routes to the README "API" table. **Commit** `feat(api): upload a new version and list versions`.

### Task 6: Web — version switcher, read-only history, upload, carry-over labels

**Files:**
- Create: `apps/web/src/lib/versions.ts`, `apps/web/src/lib/versions.test.ts`, `apps/web/src/components/VersionBar.tsx`
- Modify: `apps/web/src/lib/values.ts` (+ test), `apps/web/src/lib/format.ts` (+ test),
  `apps/web/src/pages/DocumentDetail.tsx`, `apps/web/src/pages/DocumentList.tsx` (use
  `uploadErrorMessage`), `apps/web/src/components/ValueCard.tsx`

**Interfaces:**
- Consumes: Task 2 DTOs and `effectiveValue` from `@lomi/shared`; Task 5 routes; `apiUpload`, `pollInterval`.
- Produces:
  - `lib/values.ts`: `effectiveValue` is the shared one: delete the local body and import it from
    `@lomi/shared`, keeping the existing tests. Add `previousLabel(v: ValueDto): string | null`,
    which picks its wording from `previous.change` and `carriedReview` (tests below).
  - `lib/versions.ts`: `versionOptions(versions: VersionSummaryDto[], currentVersionNo: number): { value: string; label: string }[]`.
    Labels look like `v2 · extracted (current)` and `v1 · superseded`, in input order.
  - `lib/format.ts`: `uploadErrorMessage(err: unknown): string`. A `413` gives
    `file is larger than 20 MB`, an `ApiRequestError` gives its message, anything else gives
    `Upload failed`. This is the mapping `DocumentList` has inline today, moved here.
  - `<VersionBar documentId versionNo currentVersionNo />`: the version `Select` and, on the current
    version only, the "Upload new version" control.

- [ ] **Step 1: Write the failing unit tests**:
  - `previousLabel`:
    - `change: 'value'`, `previous { versionNo: 1, effectiveValue: '$5,230.29', reviewState: 'approved' }` → `'was $5,230.29 in v1 (approved)'`
    - `change: 'value'` with a previous gap (`effectiveValue: null`, `pending`) → `'was a gap in v1 (pending)'`
    - `change: 'gap'`, previous review `approve` → `'also a gap in v1 (confirmed absent)'`;
      previous review `correct('52000')` → `'also a gap in v1, corrected to 52000'`;
      no previous review → `'also a gap in v1 (not reviewed)'`
    - `change: 'value'` where the previous was a gap confirmed absent → `'was a gap in v1 (confirmed absent)'`
      (on a gap, an `approve` always reads "confirmed absent", never "approved")
    - `change: 'evidence'`, `reviewState: 'approved'` → `'same value as v1 (approved), but its quote changed'`
    - `change: null`, `carriedReview` set, `previous.reviewState: 'corrected'` → `'carried over from v1 (corrected)'`
    - `change: null`, no carried review (v1 was never reviewed) → `'unchanged from v1 (not reviewed there)'`
    - the parenthesis always names the previous value's **effective review**
      (`previous.review`): `approve` → `approved` (`confirmed absent` on a gap), `correct` →
      `corrected`, none → `not reviewed`. It never names v1's state, so a value v1 itself carried
      reads `(approved)`, not `(carried over)`.
    - `previous: null` → `null`
  - `versionOptions([{ versionNo: 2, status: 'queued' }, { versionNo: 1, status: 'superseded' }], 2)` →
    `[{ value: '2', label: 'v2 · queued (current)' }, { value: '1', label: 'v1 · superseded' }]`
  - `uploadErrorMessage(new ApiRequestError(413, 'payload_too_large', 'x')) === 'file is larger than 20 MB'`;
    `uploadErrorMessage(new ApiRequestError(400, 'bad_request', 'file is not a PDF')) === 'file is not a PDF'`
- [ ] **Step 2:** `pnpm --filter @lomi/web test` → FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** Build the UI:
  - **Shown version:** the `?version=N` search param (`useSearchParams`). The detail query key is
    `['document', id, version ?? 'current']`, so the existing `['document', id]` invalidations
    still match by prefix. The versions query is `['versions', id]` →
    `GET /documents/:id/versions`, polling with `pollInterval(versions.map(v => v.status))`.
  - **VersionBar** in the header:
    - A `Select` from `versionOptions`. Choosing the current version removes the param; choosing
      another sets it.
    - On the current version only: a `FileInput` (`accept="application/pdf"`) and an "Upload new
      version" `Button` (`loading` while pending). Success (`201` or `200`) invalidates
      `['document', id]`, `['versions', id]` and `['documents']`. Errors show
      `uploadErrorMessage(err)` in a red `Alert`.
  - **Read-only history:** when `d.version.versionNo !== d.currentVersionNo`, show an `Alert` with
    "Viewing v1 (superseded), read only." and an `Anchor` "Go to current (v2)" that removes the
    param. Set `canReview = d.status === 'extracted' && d.version.versionNo === d.currentVersionNo`.
  - **ValueCard:**
    - Under the value, show `previousLabel(value)` as dimmed `Text` when it is non-null.
    - When `previous` is present (changed or carried), a "Previous (vN)" block sits beside the
      current value:
      - the previous quote in a dimmed `Blockquote`, with its "page N";
      - the previous review's correction and note, when they exist.

      The reviewer can then compare the old and new quote and value side by side. Clicking the
      block does not change the selection, and the evidence panel keeps showing this version's
      quote.
    - When `earlierCount > 1`, an `Anchor` "History (N earlier versions)" sits under the Previous
      block. It opens a Mantine `Drawer` (`components/ValueHistory.tsx`) that fetches
      `GET /values/:id/history` only when opened (`useQuery` with `enabled: opened`). The drawer
      shows a Mantine `Timeline` with one item per version, newest first:
      - the version number, its value (or the gap reason) and its quote with "page N";
      - every review, with its action, correction, note and time;
      - "carried over" when the entry inherited a review.

      Loading shows a `Loader`, and an error shows an `Alert`. Clicking the link must not
      re-select the card.
    - The shown value is `effectiveValue(value)`. A carried correction shows the correction, with
      the extracted value struck through, as an own correction already does.
- [ ] **Step 6:** `pnpm --filter @lomi/web build lint test` → exit 0. **Commit**
  `feat(web): version switcher, new-version upload and carry-over labels`.

### Task 7: Docs, compose, end-to-end browser check

**Files:**
- Create: `docs/decisions/0009-versions-and-carry-over.md` (≤ 30 lines: context, choice, alternatives, consequences)
- Modify: `README.md` (status line, API table, UI walkthrough, Decisions list, TODO)

- [ ] **Step 1:** Write decision note 0009. It covers:
  - the unchanged rule: normalized value plus the old quote searched in the new text. It never uses
    offsets, which is why shifted text still carries.
  - comparing with the latest extracted older version, and skipping superseded/failed ones;
  - carrying the effective review, a correction included;
  - gaps never carrying;
  - supersede under `FOR UPDATE`, and how it pairs with the review's `FOR SHARE` (0008);
  - dedupe against the current version only, so a revert is possible;
  - the cost: an unrelated edit inside a quoted passage makes a value pending again.
- [ ] **Step 2:** Update the README:
  - Status: Phase 3 done.
  - API: the two routes (from Task 5).
  - UI walkthrough: a step 5, "New version", covering the switcher and read-only history.
  - Link 0009 under Decisions.
  - Move "What happens when a new version arrives mid-extraction" and "How unchanged evidence is
    matched across versions" out of TODO into a short "Versions and carry-over" section that links
    0009. Write it after the code is done, from what was built, and keep it to three parts:
    1. **What "unchanged" means:** the "Same value" and "Quote found" definitions under this plan's
       carry-over table, including that positions and pages are never compared.
    2. **What gets carried:** this plan's carry-over table, copied as is.
    3. **Why:**
       - A quote that still appears in the new text is the only evidence that the reviewed passage
         didn't change. Comparing the old quote with the new text (not offsets) is what survives
         shifted text.
       - Gaps never carry: a gap has no quote, so "still absent" can't be verified, and the model
         may have missed a value that v2 now states.
       - The comparison is against the latest extracted older version.

    One sentence on supersede during extraction, then stop. The details live in 0009.
- [ ] **Step 3:** Host checks: `pnpm -r run build`, `pnpm -r run lint`, `pnpm -r run typecheck`,
  `pnpm -r run test` → all exit 0. Then run `pnpm --filter @lomi/db test:integration`,
  `pnpm --filter @lomi/worker test:integration` and `pnpm --filter @lomi/api test:integration`
  one after the other → PASS.
- [ ] **Step 4:** Rebuild the images one service at a time: `docker compose build api`, then
  `worker`, `web`, `migrate`, then `docker compose up -d`. Wait until
  `curl -s localhost:3000/health` returns `{"pg":"ok","redis":"ok"}`.
- [ ] **Step 5: Browser check** (Playwright MCP on `http://localhost:8080`; with a real Gemini key
  or `EXTRACTOR=fake`). Each item must hold:
  1. On the seeded invoice, approve all 5 values. Upload `invoice-001.v2.pdf` with "Upload new
     version": the header shows v2 and "Extracting…", then polling stops.
  2. v2 shows 3 cards under "Carried over", labelled "carried over from v1 (approved)", and 2 under
     "Needs review", labelled `was 2025-10-14 in v1 (approved)` and `was $5,230.29 in v1 (approved)`.
     Each pending card shows v1's quote (`Total Due: $5,230.29`) in its "Previous (v1)" block.
  3. Uploading `invoice-001.v2.pdf` again keeps v2 (the switcher still lists only v1 and v2).
  4. Choosing v1 in the switcher shows the read-only alert and disabled review buttons, and the PDF
     tab shows v1's file. "Go to current" returns to v2.
  5. Uploading a non-PDF as a new version shows `file is not a PDF`.
  6. Upload a third version (`invoice-001.pdf` again, a revert). A carried card shows
     "History (2 earlier versions)". Clicking it opens the drawer, which lists v3, v2 and v1, with
     v1's approval.

  Save screenshots for items 2 and 4 to the scratchpad and mention them in the report.
- [ ] **Step 6: Commit** `docs: phase 3 versions and carry-over, decision 0009`.
