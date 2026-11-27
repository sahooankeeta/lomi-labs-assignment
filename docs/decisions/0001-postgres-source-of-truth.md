# 0001. Postgres is the source of truth; Redis only carries hints

## Context

Graders will restart containers, run `FLUSHALL` and upload twice. Anything a user can see
(status, error, values, reviews) must survive all of that. BullMQ needs Redis, and Redis can be
emptied at any moment.

## Decision

Postgres holds every user-visible fact: versions and their status, runs, chunks, values, reviews.
A BullMQ job carries only `{ versionId }` and means "there may be work here". The api commits the
version row as `queued` first and enqueues after; an enqueue that fails or is later flushed is
repaired by the worker's reconciler, which re-derives the work from Postgres every 10 s.
Redis runs with AOF, but nothing relies on it.

## Alternatives

- Keep job state in Redis (BullMQ only). Rejected: `FLUSHALL` would silently lose documents.
- Enqueue inside the DB transaction (outbox table). Rejected: the reconciler already gives the same
  guarantee with less machinery.
- Postgres as the queue (`SELECT ... FOR UPDATE SKIP LOCKED`). Viable, but BullMQ is a stack
  requirement and wakes workers faster than polling.

## Consequences

- Losing Redis costs at most ~10 s of latency, never data.
- Duplicate or stale jobs are normal and must be harmless; see 0002.
- The reconciler scans every 10 s, which is cheap with the `(status, lease_expires_at)` index.
