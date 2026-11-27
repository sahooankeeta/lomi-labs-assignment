# 0009. Versions and carry-over: quote evidence, latest extracted baseline, supersede under lock

## Context

A new file for a document creates version N+1. Reviewers should not redo values whose evidence did
not change, and a version still extracting when a newer one arrives is wasted work.

## Decision

- **Unchanged = same normalized value and v1's quote found in v2's text** (`isUnchanged`). Offsets
  and pages are never compared, so text that shifted still carries.
- **Baseline is the latest `extracted` older version.** Superseded and failed versions have no
  values and are skipped. Carry-over runs inside `finishVersion` (`carryLinks`).
- **The effective review is carried,** a correction included; a value that was itself carried
  passes the original review along. Reviews are never copied, only linked (`carriedReviewId`).
- **Gaps never carry.** A gap has no quote to verify, and the model may have missed a value.
- **Supersede under `FOR UPDATE`** on the document row: unfinished versions become `superseded`,
  their running runs `abandoned`, `currentVersionId` moves. A review takes `FOR SHARE` on the same
  row ([0008](0008-reviews.md)), so it commits first or sees the new current version.
- **Dedupe against the current version only,** so re-uploading an older file (a revert) makes a
  new version.

## Alternatives

- Compare offsets or pages. Rejected: any edit above a value shifts everything.
- Compare only values, not quotes. Rejected: the reviewed passage may have changed.
- Copy review rows into v2. Rejected: duplicates history; a link keeps one source.

## Consequences

- An unrelated edit inside a quoted passage makes that value pending again. Accepted: a spurious
  re-review is safer than a wrongly carried approval.
- A value that was a gap in v1 always needs review in v2.
