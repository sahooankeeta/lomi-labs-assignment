# Document Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can delete a whole document from the review UI. The document, every version and everything hanging off them are hard-deleted, and a worker extracting it stops making LLM calls.

**Architecture:** One Postgres transaction (`deleteDocument` in `@lomi/db`) locks the document row and its version rows, then deletes children before parents. The api's `DELETE /documents/:id` runs it, then removes PDFs that no remaining version references. The worker needs no new signal: a deleted version fails every guarded write, and a new per-chunk ownership check (`renewLease` before each LLM call) stops the run at the next chunk. Redis isn't touched. Leftover jobs for deleted versions get `skipped` at claim.

**Tech Stack:** TypeScript, Prisma 7 on Postgres 19, Fastify, BullMQ worker, React + Mantine 9 + TanStack Query, Vitest.

**Spec:** the agreed design is in memory `deferred-document-delete` (hard delete, 204/404/400, lock, file cleanup, worker stops, confirm dialog). Project spec: `docs/superpowers/specs/2026-11-26-extraction-review-design.md`. Brief: https://github.com/Lomi-Labs/take-home-assignment (README).

## Global Constraints

- **Brief, section 3: "Nothing from the old version is deleted. Earlier versions and their reviews stay queryable."** That rule covers re-extraction. This plan adds **no** way to delete a single version. `createVersion`, supersede and carry-over stay unchanged. Delete works on the whole document only, as an explicit user action with confirmation.
- **Brief: Postgres is the system of record; `FLUSHALL` loses nothing.** Delete is one PG transaction and makes no Redis calls. It doesn't remove queued jobs: they're hints, and `claimVersion` skips them.
- **Jobs for deleted versions leave Redis on their own:** the worker returns `skipped` (the job completes, it is not thrown), and the queue uses `removeOnComplete: true` / `removeOnFail: true` (`packages/queue/src/index.ts:52-53`, pinned by `packages/queue/src/index.test.ts:35`). Do not change those options. Task 4 asserts the skipped run returns normally.
- **Brief: never stuck in `extracting`, never lost.** A version that still exists can't be left `extracting` with a dead run. Delete removes the row outright (no new status), and a running worker ends `stale`.
- **Spec anti-goal "a document ... silently disappearing"** stays. Delete is the only way a document disappears: user-initiated, confirmed, returns 204. Reword the anti-goal (Task 1) to say so.
- Hard delete, not soft (the owner's choice; don't re-ask).
- HTTP: `DELETE /documents/:id` → `204` empty body; `404 not_found` if the document doesn't exist; `400 bad_request` if `:id` is not a UUID. Errors use the existing `{ error, message }` shape.
- Every exported function gets a doc comment (guarantees, locks, why), plus inline why-comments. README is updated inside each task (memory `comment-and-document`).
- No new dependencies. No schema migration: the existing FKs (`ON DELETE RESTRICT` on children, `SET NULL` on `current_version_id`, `previous_value_id`, `carried_review_id`) are enough if the delete order is right.

## Review Focus

1. **Delete while the worker is mid-extraction.** The run stops before its next LLM call and ends `stale`. Nothing for the version is re-created (no run, chunk or value rows), and no 500 or FK error leaks. → Task 4 tests.
2. **Delete racing a review submit.** The review gets `404 not_found`, never a 500 from a `findUniqueOrThrow` on a row that just went away. → Task 1 test.
3. **Delete racing a new-version upload.** Either the upload wins and its version is deleted too, or it gets `not_found`. There's never a version row without its document. → Task 1 test.
4. **A PDF shared with another document** (same file uploaded under a different type) **must survive** the delete. An unshared PDF is removed. → Task 3 test.
5. **Double delete / double click.** The second call answers 404, and the UI treats 404 as "already gone" and still leaves the page. → Task 3 test (api). UI checked by hand in Task 5.

Known and documented, not fixed: the seed re-creates deleted fixture documents on the next `docker compose up` (it seeds v1 of each fixture on every boot). An upload of the same bytes during the instant between commit and file removal can lose its file, and that version then shows `failed` (retryable after re-upload). Both are written into decision 0010.

---

### Task 1: `deleteDocument` in `@lomi/db`, plus review hardening

**Files:**
- Create: `packages/db/src/delete.ts`
- Modify: `packages/db/src/index.ts` (export it)
- Modify: `packages/db/src/reviews.ts:45-58` (`reviewValue` returns `not_found` instead of throwing when rows vanish)
- Test: `packages/db/src/delete.int.test.ts`
- Docs: create `docs/decisions/0010-document-delete.md`; modify `docs/superpowers/specs/2026-11-26-extraction-review-design.md` (anti-goals + decisions list)

**Interfaces:**
- Produces:
  ```ts
  export type DeleteDocumentResult =
    | { kind: 'deleted'; versionCount: number; orphanedFileKeys: string[] }
    | { kind: 'not_found' };
  export async function deleteDocument(db: Db, documentId: string): Promise<DeleteDocumentResult>;
  ```
  `orphanedFileKeys` holds the deleted versions' distinct `fileKey`s that no remaining `document_versions` row references, checked inside the transaction after the deletes.

- [ ] **Step 1: Write the failing tests** in `delete.int.test.ts`. Use the same setup as `documents.int.test.ts` (`createDb(TEST_DATABASE_URL)`, `truncateAll` before each). Build the fixture with the real functions: `createDocumentWithV1` → `claimVersion` → `finishVersion` with 2 values → `reviewValue` approve one → `createVersion` (v2, different sha) → claim + finish v2 with the same values, so v2 carries the review (`carriedReviewId` set). Insert a `versionChunk` and a `chunkResult` for v1.
  - `deletes the document, both versions, runs, chunks, chunk results, values and reviews`: result `{ kind: 'deleted', versionCount: 2 }`. Afterwards `document`, `documentVersion`, `extractionRun`, `versionChunk`, `chunkResult`, `extractedValue` and `review` counts for these ids are all `0`.
  - `leaves other documents untouched`: a second document's rows have the same counts before and after.
  - `returns not_found for an unknown id, and on a second delete`.
  - `reports a file key as orphaned only when no other version uses it`: doc A (invoice, key `k1`) and doc B (lease, same `fileKey: 'k1'`, created via `createDocumentWithV1` with type `lease`). Deleting A gives `orphanedFileKeys: []`. Deleting B then gives `['k1']`.
  - `a review racing a delete answers not_found, never throws`: `Promise.all([deleteDocument(db, docId), reviewValue(db, valueId, { action: 'approve' }, { fields })])`. Delete resolves `deleted`. The review resolves to `kind` ∈ {`not_found`, `reviewed`} , and the promise does not reject. Run it in a loop of 10 to hit both orders.
  - `a new version racing a delete never leaves a version without its document`: `Promise.all([deleteDocument(...), createVersion(db, docId, { fileKey: 'b.pdf', sha256: 'b' })])`. Neither rejects, and afterwards `documentVersion.count({ where: { documentId: docId } })` is `0`. Loop 10 times.
  - `a finish racing a delete never fails with a foreign-key error`: claim v1, then `Promise.all([deleteDocument(...), finishVersion(db, v1, runId, values, { fields })])`. Neither rejects, and no values remain. Loop 10 times.

- [ ] **Step 2: Run to verify they fail**
  Run: `pnpm --filter @lomi/db test:integration -- delete.int.test.ts`
  Expected: FAIL, `deleteDocument` is not exported.

- [ ] **Step 3: Implement `deleteDocument`** in `delete.ts`. One `db.$transaction`, in this order (the order is the design; put the why of each step in comments):
  1. `SELECT id FROM documents WHERE id = $1::uuid FOR UPDATE` (via `$queryRaw`, as in `createVersion`). No row → `not_found`. This serializes with `createVersion` (`FOR UPDATE`) and `reviewValue` (`FOR SHARE`).
  2. `SELECT id, file_key FROM document_versions WHERE document_id = $1::uuid FOR UPDATE`. The worker never locks the document row, only version rows (claim/finish/renew UPDATEs, and FK checks on its inserts). Locking the versions makes a concurrent `finishVersion` either commit first, so its values get deleted below, or wait and then match 0 rows (`stale`). Without this lock a finish committing between steps 4 and 6 fails step 6 with an FK violation.
  3. `review.deleteMany` where `value.versionId in ids`. This breaks the values↔reviews cycle: `carried_review_id` is `SET NULL`.
  4. `extractedValue.deleteMany`, then `chunkResult`, `versionChunk`, `extractionRun` `deleteMany` by `versionId in ids`.
  5. `documentVersion.deleteMany` by id (`documents.current_version_id` clears via `SET NULL`), then `document.delete`.
  6. Orphaned keys: distinct deleted keys minus `documentVersion.findMany({ where: { fileKey: { in: keys } } })`.
  Lock order is document → versions everywhere (same as `createVersion`), so no deadlock with the worker.

- [ ] **Step 4: Harden `reviewValue`.** Replace the two `findUniqueOrThrow` reads that a concurrent delete can empty (the `version0` read before the lock, and the `document`/`version` re-reads after it) with `findUnique`, and return `{ kind: 'not_found' }` when any is null. Comment: "a delete may commit between the value read and the lock".

- [ ] **Step 5: Run to verify they pass**
  Run: `pnpm --filter @lomi/db test:integration`
  Expected: PASS, including the existing `reviews.int.test.ts` and `versions.int.test.ts`.

- [ ] **Step 6: Docs.** Write `docs/decisions/0010-document-delete.md` in the style of 0008/0009:
  - Hard delete of the whole document. Why this is compatible with the brief's "nothing from the old version is deleted": that rule covers re-extraction, and single-version delete deliberately doesn't exist.
  - The lock order, and the delete order with the cycle it breaks.
  - PDFs removed after commit only when orphaned.
  - Prompts and raw responses go with the document.
  - The worker stops at the next chunk.
  - The two known gaps from Review Focus.
  In the spec, reword the anti-goal to "A document stuck in `extracting` forever, or disappearing without a user's confirmed delete", and add a decision line linking 0010.

- [ ] **Step 7: Commit**
  ```bash
  git add packages/db/src/delete.ts packages/db/src/delete.int.test.ts packages/db/src/index.ts packages/db/src/reviews.ts docs/decisions/0010-document-delete.md docs/superpowers/specs/2026-11-26-extraction-review-design.md
  git commit -m "feat(db): hard-delete a document and all its versions in one locked transaction"
  ```

### Task 2: `FileStore.remove`

**Files:**
- Modify: `packages/files/src/index.ts`
- Test: `packages/files/src/index.test.ts`

**Interfaces:**
- Produces: `FileStore.remove(key: string): Promise<void>`. Idempotent: a missing file resolves. An invalid key rejects, as in `pathFor`.

- [ ] **Step 1: Write failing tests:** `remove deletes a stored file` (put → remove → `read` rejects); `remove of a missing key resolves`; `remove rejects an invalid key` (`'../x.pdf'` → rejects with `/Invalid file key/`).
- [ ] **Step 2: Run** `pnpm --filter @lomi/files test`. Expected: FAIL, `remove` is not a function.
- [ ] **Step 3: Implement** with `rm(this.pathFor(key), { force: true })`. `pathFor`'s throw must become a rejection: wrap it the way `read` does. Doc comment: content-addressed, so callers must first check that no row uses the key (`deleteDocument`'s `orphanedFileKeys`).
- [ ] **Step 4: Run** `pnpm --filter @lomi/files test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(files): idempotent remove`

### Task 3: `DELETE /documents/:id`

**Files:**
- Modify: `apps/api/src/routes/documents.ts`
- Test: `apps/api/src/documents.int.test.ts` (new `describe('DELETE /documents/:id')`)
- Docs: `README.md` (API section: add the route and its codes)

**Interfaces:**
- Consumes: `deleteDocument` (Task 1), `FileStore.remove` (Task 2).
- Produces: `DELETE /documents/:id` → 204 / 404 / 400.

- [ ] **Step 1: Write failing tests** (use the file's `upload()` helper and the temp `files` store):
  - `deletes an uploaded document: 204, then GET 404, gone from GET /documents`: `res.statusCode === 204`, `res.body === ''`, the follow-up `GET /documents/:id` is 404, and the list doesn't contain the id.
  - `removes the PDF when no other document uses it`: after delete, `files.read(key)` rejects. Get the key from `db.documentVersion` before deleting.
  - `keeps a PDF another document still uses`: upload the same bytes as `type=invoice` and as `type=lease`, delete the invoice, and `files.read(key)` still resolves.
  - `answers 404 for an unknown id and on a second delete; 400 for a malformed id`: body `{ error: 'not_found' }` / `{ error: 'bad_request' }`.
  - `never enqueues`: `enqueue` was not called by the delete.
- [ ] **Step 2: Run** `pnpm --filter @lomi/api test:integration -- documents.int.test.ts`. Expected: the new tests FAIL with 404 (route missing).
- [ ] **Step 3: Implement the route** in `documentRoutes`, with a doc comment in the existing style (codes, "no Redis", file removal after commit). The 404 `HttpError` message is `'document not found'`. After `deleted`, remove each orphaned key with `deps.files.remove(key)` in a loop and **catch and `req.log.warn` each failure**: the rows are already gone, and an orphan file is harmless (content-addressed, reused by a later upload). Then `reply.code(204).send()`.
- [ ] **Step 4: Run** `pnpm --filter @lomi/api test:integration`. Expected: PASS.
- [ ] **Step 5: README.** Add the route to the API list. Add a line under consistency: "delete is one PG transaction; PDFs are removed after commit, only when no other version uses them".
- [ ] **Step 6: Commit** `feat(api): DELETE /documents/:id`

### Task 4: Worker stops on delete

**Files:**
- Modify: `apps/worker/src/pipeline.ts` (per-chunk ownership check)
- Modify: `packages/db/src/coordination.ts` (`claimVersion`: tolerate the document vanishing right after the claim)
- Test: `apps/worker/src/pipeline.int.test.ts`
- Docs: `README.md` (failure table row "Document deleted mid-extraction"; remove the delete bullet from the TODO list)

**Interfaces:**
- Consumes: `deleteDocument` (Task 1), existing `renewLease(db, versionId, runId, leaseMs): Promise<boolean>`.
- Produces: no new exports. `processVersion` returns `'stale'` for a deleted version, and `'skipped'` if the delete committed before the claim.

- [ ] **Step 1: Write failing tests** in `describe('processVersion')`. Add an optional `onCall?: (n: number) => Promise<void>` constructor hook to `SpyExtractor`, awaited at the start of `extract` with the 1-based call number.
  - `checks ownership before each chunk: a takeover after chunk 1 makes no further calls`: `SMALL_CHUNKS`, `chunkConcurrency: 1`, `renewMs: 60_000` (the timer must not be what stops it). The `onCall(1)` hook sets the version's `activeRunId` to a fresh `crypto.randomUUID()`. Expect result `'stale'`, `spy.calls.length === 1`, and the chunk plan has more than 1 chunk (assert via `versionChunk.count`).
  - `a delete mid-extraction stops the run and leaves no rows behind`: same deps. `onCall(1)` runs `deleteDocument(db, documentId)`. Expect result `'stale'`, `spy.calls.length === 1`, and `documentVersion`, `extractionRun`, `chunkResult`, `versionChunk` and `extractedValue` counts for the version all `0`.
  - `a job for an already-deleted version is skipped`: seed, `deleteDocument`, then `processVersion` resolves `'skipped'` and the spy has no calls.
- [ ] **Step 2: Run** `pnpm --filter @lomi/worker test:integration -- pipeline.int.test.ts`. Expected: the first two FAIL (`calls.length` > 1). The third may already pass; keep it as a guard.
- [ ] **Step 3: Implement.** In the chunk task, after the `runSignal.aborted` early return and before `buildPrompt`: `if (!(await renewLease(db, versionId, runId, deps.leaseMs ?? LEASE_MS))) { lost.abort(new Error('lease lost')); return; }`. The comment says why: one cheap UPDATE per chunk means a delete or takeover costs at most the calls already in flight, not the rest of the document, and the 10 s timer still covers long single calls. In `claimVersion`, replace the post-claim `db.document.findUniqueOrThrow` with `findUnique`, and return `{ kind: 'skipped' }` when it's null (comment: deleted between claim and read; the version and run went with it).
- [ ] **Step 4: Run** `pnpm --filter @lomi/worker test:integration && pnpm --filter @lomi/db test:integration`. Expected: PASS, with existing lease/SIGTERM tests unchanged.
- [ ] **Step 5: README.** Add the failure-table row: "Document deleted mid-extraction | the run's next ownership check (before each chunk) or lease renewal (≤ 10 s) fails; it writes nothing more and ends stale". Remove the "Delete a document (deferred)" TODO bullet.
- [ ] **Step 6: Commit** `feat(worker): stop a run at the next chunk once its version is gone`

### Task 5: Delete button in the review UI

**Files:**
- Modify: `apps/web/src/api.ts` (`apiDelete`; make `request` accept 204)
- Modify: `apps/web/src/pages/DocumentDetail.tsx` (button + confirm modal listing the versions)
- Modify: `apps/web/src/lib/versions.ts` (`deleteSummary`)
- Test: `apps/web/src/lib/versions.test.ts`
- Docs: `README.md` (UI section: one line)

**Interfaces:**
- Consumes: `DELETE /documents/:id` (Task 3).
- Produces: `export function apiDelete(path: string): Promise<void>`. In `request`, a `204` returns `undefined` without parsing JSON.

- [ ] **Step 1: Write the failing unit tests** in `apps/web/src/lib/versions.test.ts` for `deleteSummary`:
  - `counts and lists versions newest first`: input v1 `superseded`, v2 `extracted` (any order) → `{ heading: '2 versions will be deleted:', lines: [{ label: 'v2', status: 'extracted', current: true }, { label: 'v1', status: 'superseded', current: false }] }` when `currentVersionNo` is 2 (use `toMatchObject`; each line also carries the input's `createdAt`).
  - `singular for one version`: heading `'1 version will be deleted:'`.
  - `empty list`: heading `'All versions will be deleted.'`, `lines: []`. That's the fallback while loading, or when the list fails.
- [ ] **Step 2: Run** `pnpm --filter @lomi/web test -- versions.test.ts`. Expected: FAIL, `deleteSummary` is not exported.
- [ ] **Step 3: Implement** `apiDelete` and the 204 branch in `request`. Also implement `deleteSummary` in `apps/web/src/lib/versions.ts`:
  ```ts
  export interface DeleteSummaryLine { label: string; status: VersionStatus; createdAt: string; current: boolean }
  export function deleteSummary(versions: VersionSummaryDto[], currentVersionNo: number): { heading: string; lines: DeleteSummaryLine[] };
  ```
  `label` is `v{versionNo}`, `createdAt` is passed through, and lines are sorted by `versionNo` descending. Run the Step 1 tests: PASS.
- [ ] **Step 4: Implement the UI** in the detail page header, next to the title (follow memory `review-ui-choices`: Mantine components):
  - `<Button color="red" variant="light" size="xs">Delete</Button>` opens a Mantine `Modal` titled `Delete "{title}"?`.
  - The modal lists the versions from the existing `GET /documents/:id/versions`. Use the same query key as `VersionBar`, `['versions', id]`, so the cache is shared, with `enabled: opened`. Call `refetch()` when the modal opens, so a version uploaded since page load (e.g. from another tab) appears. Body: `deleteSummary(...)`'s heading, then one row per line: `StatusPill` for the status, `v2` in bold, `(current)` when `current`, and the upload date (`new Date(createdAt).toLocaleString()`). Below it: `Their extracted values, reviews and extraction history are deleted too. This can't be undone.` While the list is loading, show a `Loader` in place of the rows and keep `Delete` enabled: the server deletes every version regardless of what the list shows.
  - Buttons: `Cancel` and a red `Delete {n} version(s)`, or just `Delete` while the count is unknown, `loading` while pending. The mutation error shows inside the modal.
  - `useMutation` calls `apiDelete(`/documents/${id}`)`. Success, and an `ApiRequestError` with `code === 'not_found'` (already gone, e.g. double click or another tab), both do the same four things: `queryClient.removeQueries({ queryKey: ['document', id] })` (stops the detail poll from fetching a 404), `removeQueries({ queryKey: ['versions', id] })`, `invalidateQueries({ queryKey: ['documents'] })`, then `navigate('/')`.
  - Available on any status and version, including while `extracting`: the worker stops by itself (Task 4).
- [ ] **Step 5: Verify:** `pnpm --filter @lomi/web lint && pnpm --filter @lomi/web typecheck && pnpm --filter @lomi/web test`. Expected: PASS. Then run the app (`run` skill / `pnpm dev`) and check by hand with Playwright: open a document with v1 and v2 (upload `invoice-001.v2.pdf`) → Delete → the modal lists `v2 (current)` and `v1` with their statuses and the button reads `Delete 2 versions`; Cancel keeps the document. Delete → Delete lands on the list with the document gone. Upload a doc and delete it while `extracting`: the worker log shows `lease lost; stopping this run` or `stale`, and no new `chunk N done` lines after that. A double-click on the confirm button still lands on the list.
- [ ] **Step 6: README.** UI section: "Delete (detail page) removes the document and all its versions after a confirmation; there is no per-version delete, since earlier versions must stay queryable." Mention that the seed re-adds deleted fixture documents on the next boot.
- [ ] **Step 7: Final check:** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`. Expected: all PASS.
- [ ] **Step 8: Commit** `feat(web): delete a document from the detail page`
