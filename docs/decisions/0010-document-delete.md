# 0010. Document delete: hard delete of the whole document, in one locked transaction

## Context
A user needs to remove a document. The brief says "nothing from the old version is deleted";
that covers re-extraction (a new file never destroys an older version). It does not forbid an
explicit, confirmed removal of the whole document.

## Decision
- **Hard delete of the whole document** (document, every version, runs, chunks, chunk results,
  values, reviews). No single-version delete exists, so old versions are never lost by
  re-extraction. Prompts and raw LLM responses go with the document.
- **Lock order: document row, then its version rows, both `FOR UPDATE`** (same order as
  `createVersion`). The document lock serializes with uploads (`FOR UPDATE`) and reviews
  (`FOR SHARE`). The worker never locks the document row, so the version locks are what make
  a concurrent `finishVersion` either commit first (its values are deleted) or wait and end
  `stale`.
- **Delete order: reviews, values, chunk results, chunks, runs, versions, document.** FKs are
  `RESTRICT`. Values and reviews form a cycle (review to value, carried value to review);
  deleting reviews first breaks it because `carried_review_id` is `SET NULL`.
  `current_version_id` also clears via `SET NULL`.
- **PDFs are removed after commit, and only when orphaned:** no remaining version references
  the file key (checked inside the transaction). Two documents may share a file.
- **The worker stops at the next chunk.** A deleted version fails every guarded write, and a
  per-chunk ownership check stops further LLM calls. Redis is untouched; leftover jobs are
  `skipped` at claim.
- **`reviewValue` answers `not_found`** when a delete empties rows between its reads.

## Alternatives
- Soft delete. Rejected: the owner wants the data gone, including prompts and responses.
- Delete only the document row with `ON DELETE CASCADE`. Rejected: needs a migration and hides
  the order the cycle requires.
- Lock only the document row. Rejected: a worker finish could commit mid-delete and fail the
  version delete with an FK violation.

## Consequences
- Known gap: the seed re-creates deleted fixture documents on the next boot (it seeds v1 of
  each fixture every time).
- Known gap: an upload of the same bytes in the instant between commit and file removal can
  lose its file; that version then shows `failed` and is retryable by re-uploading.
- Known gap: an identical re-upload that lands while a delete of that same document is in
  flight can dedupe onto the document being deleted. The upload returns that id, which then
  404s, and its file may be removed as orphaned. The user simply uploads again.
