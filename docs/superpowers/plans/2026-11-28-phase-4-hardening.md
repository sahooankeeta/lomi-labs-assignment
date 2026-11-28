# Phase 4: Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `scripts/chaos.sh` that breaks the running compose stack in the ways the spec lists and asserts the end state through the API, run green against freshly rebuilt images.

**Architecture:** Bash + curl + node (for JSON), same style as `scripts/verify-phase1.sh`. The helpers both scripts need move into `scripts/lib.sh`, which each script sources. The chaos script talks to the system only through the HTTP API and `docker compose` (no `psql`), as the spec asks ("each asserts the end state via the API").

**Tech Stack:** bash (Git Bash on Windows), curl, node, docker compose.

**Spec:** `docs/superpowers/specs/2026-11-26-extraction-review-design.md` (Phases §4; Tests: "Phase 4 script `scripts/chaos.sh`").

**Out of scope (owner's call, 2026-11-28):** README work. Do not edit `README.md` in this phase.

## Global Constraints

- Scenarios required by the spec: restart mid-extraction, `FLUSHALL` + restart, double upload, v2 during v1. Each asserts its end state via the API.
- Runs against the compose stack started with `EXTRACTOR=fake FAKE_EXTRACTOR_DELAY_MS=15000 docker compose up -d` (fake extractor, slow enough to break things mid-extraction), and restores the worker on exit like `verify-phase1.sh` does.
- Prints `PASS`/`FAIL` per check, exits 1 if any check failed. Fails fast with the start command if the worker is not on the fake extractor.
- Expected values per document type: invoice and lease 5 values, market_report 6 (from `verify-phase1.sh` check 6).
- Every upload uses fresh bytes (fixture + unique trailing comment), so reruns never hit the identical-file path by accident.
- Comments: a header saying what the script assumes and does, and a short "why" on every wait budget (lease 30 s, reconciler tick ≤ 10 s, fake extraction 15 s).
- Local dev runs a native Postgres 19 on host port 5432; the compose `postgres` service needs that port, so the native service must be stopped while the compose stack runs.

## Review Focus

1. **Superseded v1 leaves values behind.** v1's stale finish must write nothing: `GET /documents/:id?version=1` has `values: []` → Task 2 scenario D asserts it.
2. **v2 carries links from a v1 that never extracted.** Every v2 value has `previous: null` (decision table row 12) → Task 2 scenario D asserts it.
3. **Delete mid-extraction wedges the worker.** After `DELETE`, the document is 404 and the next upload still extracts → Task 2 scenario E.
4. **A check that passes because a request silently failed.** Every API read used in an assertion must have answered 200; an empty body must count as FAIL, never as "no duplicates" → `api_get` in Task 1 returns non-zero on a non-200, and Task 2's final sweep fails if it saw zero documents.
5. **Double upload under the restarted API creates a second version.** After scenario B's restart, the re-upload must still answer 200 with the same id → Task 2 scenario C runs after B.

---

### Task 1: Shared helpers in `scripts/lib.sh`

**Files:**
- Create: `scripts/lib.sh`
- Modify: `scripts/verify-phase1.sh` (delete its copies of the helpers, `source scripts/lib.sh` instead)

**Interfaces:**
- Produces (all from `verify-phase1.sh`, same behaviour): `API`, `TMP`, `FAILS`, `pass <msg>`, `fail <msg>`, `check <ok|bad> <msg> <detail>`, `jget <dotted.path>` (stdin JSON), `doc_status <id>`, `wait_status <id> <status> <seconds>`, `wait_health [seconds]`, `upload <pdf> [type]` (sets `UP_CODE`, `UP_ID`), `fresh_pdf <name> [fixture]` (fixture defaults to `invoice-001.v2.pdf`, so verify-phase1 is unchanged), `require_fake_worker` (the precondition block of check 0, exits 1 on failure), `restore_worker_on_exit` (installs the existing cleanup trap).
- New: `api_get <path>`: prints the body, returns 1 (and prints `api_get <path>: HTTP <code>` to stderr) on any non-200. `upload_version <doc_id> <pdf>`: `POST /documents/:id/versions`, sets `UP_CODE`, `UP_ID` (the new version's document id from the response) and `UP_BODY`. `jlen <dotted.path>`: like `jget` but prints the array length (empty if not an array).
- `psql_q` stays in `verify-phase1.sh`; the chaos script must not use it.

- [ ] **Step 1:** Move the helpers into `scripts/lib.sh`, add the three new ones, and make `verify-phase1.sh` source it (`. scripts/lib.sh` after its `cd`).
- [ ] **Step 2:** `bash -n scripts/lib.sh scripts/verify-phase1.sh`. Expected: no output.
- [ ] **Step 3:** With the stack up on the fake extractor, `bash scripts/verify-phase1.sh`. Expected: `ALL CHECKS PASSED`, same checks as before the move.
- [ ] **Step 4: Commit** `refactor(scripts): share verification helpers in scripts/lib.sh`

### Task 2: `scripts/chaos.sh`

**Files:**
- Create: `scripts/chaos.sh`

**Interfaces:**
- Consumes: everything Task 1 produces.

Scenarios, in this order (C depends on B's restart):

- [ ] **Step 1: Write the scenarios.** Each is one or more `check` lines:
  - **0. Preconditions:** `wait_health 60`, `require_fake_worker`, `restore_worker_on_exit`.
  - **A. Restart mid-extraction (SIGTERM handoff):** upload a fresh invoice, `wait_status … extracting 30`, `docker compose restart worker`, then `wait_status … extracted 60`. Assert `jlen values` of `api_get /documents/$ID` is `5`.
  - **B. `FLUSHALL` + restart worker and api mid-extraction:** fresh invoice, wait `extracting`, `redis-cli FLUSHALL`, `docker compose restart worker api`, `wait_health 60`, wait `extracted` 60 s (the reconciler re-enqueues from Postgres). Assert 5 values.
  - **C. Double upload after the restart:** re-upload B's file. Assert `UP_CODE=200`, `UP_ID` = B's id, and `jlen .` of `api_get /documents/$ID/versions` is `1`.
  - **D. v2 during v1:** upload a fresh `invoice-001.pdf` (v1), wait `extracting`, `upload_version $ID <fresh invoice-001.v2.pdf>` → assert `201`. Wait until `/documents/$ID` (current) is `extracted` (60 s: v1's run sees it is superseded at its next ownership check, v2 then extracts in ~15 s). Assert, via the API: current `version.versionNo` = 2 and `currentVersionNo` = 2; `/documents/$ID/versions` has length 2 with v1 `superseded` and v2 `extracted`; `/documents/$ID?version=1` has `values` length 0; v2 has 5 values and every `values[].previous` is null (node one-liner over the body).
  - **E. Delete mid-extraction:** fresh invoice, wait `extracting`, `DELETE /documents/$ID` → assert `204`; `GET /documents/$ID` → `404`. Then upload another fresh invoice and wait `extracted` 60 s: the worker is not stuck on the deleted run.
  - **F. Sweep:** for every document in `api_get /documents`, `api_get /documents/$id` must answer 200 with status `extracted` and value count 5 (invoice, lease) or 6 (market_report), with no field appearing twice. FAIL if the list was empty or any read failed (Review Focus 4).
  - Summary line and exit code as in `verify-phase1.sh`.
- [ ] **Step 2:** `bash -n scripts/chaos.sh`. Expected: no output.
- [ ] **Step 3: See it fail.** With the worker on its normal settings (not fake), `bash scripts/chaos.sh`. Expected: the precondition FAIL with the start command, exit 1.
- [ ] **Step 4: See it pass.** `EXTRACTOR=fake FAKE_EXTRACTOR_DELAY_MS=15000 docker compose up -d`, then `bash scripts/chaos.sh`. Expected: every check PASS, `ALL CHECKS PASSED`, exit 0, and the worker restored afterwards.
- [ ] **Step 5: Prove a check can fail.** Temporarily change D's expected v1 value count to 1, rerun D, see `FAIL  D…`, revert.
- [ ] **Step 6: Commit** `test(scripts): chaos.sh breaks the running stack and checks the end state via the API`

### Task 3: Rebuild the compose images and run both scripts on them

The compose images were last built before phase 3, so this is the first check of versions, carry-over and delete on the compose stack.

- [ ] **Step 1:** Stop the native Postgres service (`postgresql-x64-19`) so compose can bind 5432.
- [ ] **Step 2:** `for s in migrate api worker web; do docker compose build $s; done`. Expected: four successful builds.
- [ ] **Step 3:** `EXTRACTOR=fake FAKE_EXTRACTOR_DELAY_MS=15000 docker compose up -d`, then `bash scripts/verify-phase1.sh` and `bash scripts/chaos.sh`. Expected: both `ALL CHECKS PASSED`.
- [ ] **Step 4:** Any failure is a bug: reproduce it in the integration test closest to the code (`apps/worker/src/pipeline.int.test.ts`, `packages/db/src/*.int.test.ts` or `apps/api/src/*.int.test.ts`), see that test fail, fix, rerun the script. One commit per fix, `fix(<pkg>): …`.
- [ ] **Step 5:** Restart the native Postgres service if the owner wants local dev back.
