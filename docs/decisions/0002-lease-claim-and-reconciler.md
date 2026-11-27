# 0002. Claim with a lease, finish with a guard, reconcile from Postgres

## Context

A worker can be restarted (SIGTERM), killed (SIGKILL) or lose Redis. A document must never be
stuck in `extracting`, and a re-run must never produce duplicate or interleaved values.

## Decision

- **Claim:** one conditional update moves `queued` (or `extracting` with an expired lease) to
  `extracting`, sets `active_run_id`, a 30 s lease and `attempts + 1`. No row updated means do
  nothing, so duplicate jobs are harmless.
- **Lease:** renewed every 10 s on its own timer, so a slow LLM call cannot lose it.
- **Finish:** one transaction, guarded by `active_run_id` and `status = 'extracting'`. A stale run
  writes nothing. Values are written only here, from the merged result, and
  `unique(version_id, field)` is the backstop.
- **SIGTERM:** the worker hands its versions back (`extracting -> queued`, no attempt spent) so the
  next worker resumes at once. SIGKILL falls back to lease expiry.
- **Attempt cap:** a claim that would start attempt 4 fails the version visibly instead of looping.
- **Reconciler:** every 10 s, re-enqueues `queued` and expired-lease versions.

## Alternatives

- Heartbeat rows per worker. Rejected: `active_run_id` plus the lease needs no worker identity.
- BullMQ retries and stalled-job handling. Rejected: two places deciding failure; BullMQ uses
  `attempts: 1` and Postgres decides.

## Consequences

- After a SIGKILL a document resumes in about 40 s (lease plus reconciler tick).
- Chunk results saved before a crash are reused, so a resumed run redoes only missing chunks.
- Every restart-safety rule lives in a few guarded updates that are integration-tested.
