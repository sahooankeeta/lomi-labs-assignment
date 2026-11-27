# 0002. Claim with a lease, finish with a guard, reconcile from Postgres

## Context

A worker can be restarted (SIGTERM), killed (SIGKILL) or lose Redis. A document must never be
stuck in `extracting`, and a re-run must never produce duplicate or interleaved values.

## Decision

- **Claim:** one conditional update moves `queued` (or `extracting` with an expired lease) to
  `extracting`, sets `active_run_id`, a lease and `attempts + 1`. No row updated: do nothing.
- **Lease:** 30 s, renewed every 10 s on its own timer. **Finish:** one transaction, guarded by
  `active_run_id` and `status = 'extracting'`; a stale run writes nothing. Values are written only
  here, from the merged result, and `unique(version_id, field)` is the backstop.
- **SIGTERM:** the worker hands its versions back (`extracting -> queued`, no attempt spent). It is
  resumed by the next reconciler pass (at most 10 s) or the restarted worker's startup pass; no job
  is enqueued at handoff. SIGKILL falls back to lease expiry.
- **Attempt cap:** attempt 4 fails the version visibly instead of looping.
- **Reconciler:** every 10 s, re-enqueues `queued` and expired-lease versions.

## Where the lease helps

- **Crash, kill or OOM mid-extraction:** nobody renews, the lease expires, and the reconciler resumes the version.
- **`FLUSHALL` or a lost job:** Postgres still records `extracting`, so the job is rebuilt from it after expiry.
- **Stalled worker:** another run takes over, the stalled run's renewal fails, and it stops. No double writes.
- **Duplicate jobs:** only one claim succeeds while the lease is live.

Code: `LEASE_MS` and `renewLease` in `packages/db/src/coordination.ts`, the renewal timer in
`apps/worker/src/pipeline.ts`, and `findReconcilable` with `apps/worker/src/reconciler.ts`.

## Alternatives

- Heartbeat rows per worker. Rejected: the lease is enough.
- BullMQ retries and stalled-job handling. Rejected: two places deciding failure; BullMQ uses
  `attempts: 1` and Postgres decides.

## Consequences

- After a SIGKILL a document resumes in about 40 s (lease plus reconciler tick).
- Chunk results saved before a crash are reused, so a resumed run redoes only missing chunks.
