# 0008. Reviews: append-only, locked against supersede, typed corrections

## Context

A reviewer approves, corrects or confirms absent each value. Phase 3 versions supersede the
current one, so a review must never land on a version that just stopped being current.

## Decision

- **Append-only annotations.** Each click inserts a `reviews` row; the latest row per value is
  its state. Nothing is updated, so the history is kept.
- **`FOR SHARE` on the document row** before the checks. Supersede takes `FOR UPDATE` on the
  same row, so a review commits first or waits and then sees the new current version.
- **Gaps are reviewable:** "Confirm absent" approves a gap; a gap can also be corrected.
- **Typed validation.** A correction must parse as the field's type (`"abc" is not a valid
  money`). The typed text is stored, not the normalized form.
- **Progress counts each value once;** `gaps` overlaps the other buckets (a view, not a bucket).
- **Click flow:** each click saves at once (MVP). **UI library:** Mantine; the owner asked for a
  component library, it needs no Tailwind setup, and it supports React 19.

## Alternatives

- Drafts in localStorage, submitted all-or-nothing via `POST /documents/:id/reviews` with a
  sticky submit bar. Deferred (README TODO).
- A mutable review column on the value. Rejected: loses history.

## Consequences

- A reviewer cannot type free text into a money field (`about 5k` is refused). Accepted:
  clean data over flexibility.
