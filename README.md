# Lomi Labs take-home: PDF extraction & review

> **Status: Phase 2 complete (review UI and routes).** Phase 1 (ingest and extraction) survives worker restarts, SIGKILL, Redis `FLUSHALL` and double uploads (checked by `scripts/verify-phase1.sh`). Phase 2 adds review routes (approve, correct, confirm absent), progress, and a React UI with the PDF beside the values. Verified in a browser on the dev servers (`pnpm --filter @lomi/api dev` and `pnpm --filter @lomi/web dev`, UI on :5173); the compose web image now serves the pdf.js worker with the right MIME type, but the worker and migrate images have not been rebuilt with Phase 2 yet (see "Review UI"). Not yet built: version upload and carry-over. Design: [`docs/superpowers/specs/2026-11-26-extraction-review-design.md`](docs/superpowers/specs/2026-11-26-extraction-review-design.md). Decisions: [`docs/decisions/`](docs/decisions/).

PDFs go in, an LLM (Google Gemini; a fake extractor for tests) extracts structured values with quoted evidence, and a human approves or corrects each value. Reviews carry over across document versions when their evidence didn't change.

> The spec named Claude. The project owner removed it to avoid a paid API, so Gemini (free tier) is the only real provider. Adding another is one `Extractor` implementation plus a factory branch.

## Run it

```sh
cp .env.example .env        # then set a key, see below
docker compose up --build
```

Pick the extractor in `.env` (compose passes these to the worker):

- **Gemini (the default, free tier):** set `GEMINI_API_KEY=...` (key from https://aistudio.google.com/apikey); `EXTRACTOR` can stay unset. Without a key every version fails visibly with `GEMINI_API_KEY is not set` and can be retried.
- **Fake (offline, no key):** `EXTRACTOR=fake`, optional `FAKE_EXTRACTOR_DELAY_MS=15000`. Deterministic values from the fixtures.

After changing `.env`, run `docker compose up -d worker` to recreate the worker.

**Low on memory?** Build one service at a time instead of one parallel build:

```sh
for s in migrate api worker web; do docker compose build $s; done
docker compose up -d
```

- Web UI: http://localhost:8080
- API: http://localhost:3000/health

Compose starts Postgres and Redis, runs migrations, seeds version 1 of each fixture, and then starts the api, worker, and web services.

### Without Docker (local dev)

You need Postgres (16+; a native Windows Postgres 19 service works) and Redis 7 running locally, or point `DATABASE_URL` / `REDIS_URL` in `.env` at hosted ones. Any role that can create databases works (e.g. `postgresql://postgres:<password>@localhost:5432/lomi`); create the `lomi` database once with `CREATE DATABASE lomi`.

A native Postgres on port 5432 and the compose `postgres` service both want host port 5432: stop one before starting the other.

```sh
pnpm install
pnpm db:seed      # builds deps, runs migrations, then seeds
pnpm dev          # api :3000, worker, web :5173 (proxies /api -> :3000)
```

Relative `UPLOAD_DIR` and `FIXTURES_DIR` (the `./uploads` and `./fixtures` in `.env.example`) resolve against the repo root, not each app's folder, so the api, worker and seed share one `uploads/`. Absolute paths (compose uses `/data/uploads`) are used as given.

### Checks

```sh
pnpm -r run build && pnpm -r run typecheck && pnpm -r run lint && pnpm -r run test
pnpm --filter @lomi/db test:integration   # needs Postgres; uses TEST_DATABASE_URL
pnpm --filter @lomi/api test:integration  # needs Postgres; run after (not alongside) the db suite, they share lomi_test
pnpm --filter @lomi/worker test:integration # needs Postgres, no Redis, fake extractor only; run alone (shares lomi_test)
pnpm --filter @lomi/worker smoke:gemini   # check a Gemini key: lists models, one extraction on the invoice; needs GEMINI_API_KEY (free tier)
```

(`pnpm turbo …` does the same where Windows Application Control doesn't block the turbo binary.)

Unit tests (`*.test.ts`) need nothing running. Integration tests (`*.int.test.ts`) read `TEST_DATABASE_URL` from `.env`, create that database if it's missing, apply migrations, and truncate tables between tests; they never touch the dev database.

### Extractor settings (worker)

| Variable                  | Default                    | Effect                                                                                                                                                                        |
| ------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_MAX_INFLIGHT`        | `4`                        | Max concurrent LLM calls (Gemini extractions).                                                                                                                                |
| `EXTRACTOR`               | `gemini`                   | `gemini` or `fake`. Any other value makes every version fail with a clear message.                                                                                            |
| `GEMINI_API_KEY`          | none                       | Required unless `EXTRACTOR=fake` (free tier: https://aistudio.google.com/apikey). Missing: the worker still starts, but every version fails with `GEMINI_API_KEY is not set`. |
| `GEMINI_MODEL`            | `gemini-3.6-flash`         | Primary Gemini model.                                                                                                                                                         |
| `GEMINI_FALLBACK_MODELS`  | `gemini-flash-lite-latest` | Comma-separated models tried in order when the primary is busy (429/503/timeout twice) or retired (404).                                                                      |
| `EXTRACTOR=fake`          | unset                      | Deterministic offline extractor for tests/e2e; ignores the API keys.                                                                                                          |
| `FAKE_EXTRACTOR_DELAY_MS` | `0`                        | Simulated latency per fake extraction.                                                                                                                                        |
| `CHUNK_CONCURRENCY`       | `3`                        | Chunks of one document extracted at once.                                                                                                                                     |

The Gemini extractor runs on Google's free tier, which has rate limits and models that are sometimes overloaded: a busy model is retried once, then the next fallback model is used, and stored results record which model answered. Token counts are a local estimate (length / 4), so Gemini uses no quota for them. Answers go through the same evidence check as the fake's.

## API

Errors are always `{ "error": "<code>", "message": "..." }`. The api only validates, writes to Postgres and enqueues a hint; it never parses PDFs or calls the LLM.

| Route                         | Success                                                                                                                                      | Errors                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /documents`             | `201` new document (v1 `queued`); `200` the existing one if the same file was uploaded                                                       | `400` bad `type`, no file, or not a PDF; `413` over 20 MB                                                                                                          |
| `GET /documents/:id`          | `200` document, current version (or `?version=N`) and its values                                                                             | `400` id not a UUID or bad `version`; `404` unknown document or version                                                                                            |
| `POST /documents/:id/retry`   | `202` failed version back to `queued`                                                                                                        | `400` id not a UUID; `404` unknown document; `409` current version is not `failed`                                                                                 |
| `GET /documents`              | `200` every document, newest first, with its current version's status and review progress                                                    | none                                                                                                                                                               |
| `GET /documents/:id/progress` | `200` review counts (`pending`, `approved`, `corrected`, `carried_over`, `gaps`, `total`) of the current version                             | `400` id not a UUID; `404` unknown document                                                                                                                        |
| `POST /values/:id/review`     | `201` review appended (`{ "action": "approve" }` or `{ "action": "correct", "value", "note"? }`); returns the value's new state and progress | `400` id not a UUID, bad body, or a correction that is not valid for the field's type; `404` unknown value; `409` value is not of the current, `extracted` version |
| `GET /versions/:id/file`      | `200` the version's PDF, inline, cached as immutable                                                                                         | `400` id not a UUID; `404` unknown version or file missing from the store                                                                                          |

```sh
curl -F type=invoice -F file=@fixtures/documents/invoice-001.pdf localhost:3000/documents
# {"id":"<uuid>","title":"invoice-001","type":"invoice","versionNo":1,"status":"queued"}
curl localhost:3000/documents/<uuid>
curl -X POST localhost:3000/documents/<uuid>/retry
```

## Review UI

Run `pnpm --filter @lomi/api dev` and `pnpm --filter @lomi/web dev`, then open http://localhost:5173. This is where the flow below was verified in a browser; the api starts and serves seeded PDFs with the stock relative paths from `.env.example`.

For the compose stack (http://localhost:8080), rebuild the images one service at a time first, so the new UI is served: `docker compose build api`, then `worker`, `web`, `migrate`, then `docker compose up -d`. On :8080, the pdf.js worker (`assets/pdf.worker.*.mjs`) is checked to come back as `application/javascript` and `/api/documents` to return JSON; the full flow has not been clicked through there in a browser.

1. **List.** Every document with its status and review progress. Upload a PDF with the type picker; the list polls while anything is queued or processing and stops once all are extracted. A non-PDF shows `file is not a PDF`.
2. **Detail.** Click a document. Values are grouped into cards (Needs review, Carried over, Done), with the evidence quote and "page N". The header shows progress.
3. **Approve or correct.** Approve moves a card to Done. Correct opens an inline field; a value that does not fit the field type (`abc` for a money field) shows `"abc" is not a valid money`. A corrected card shows the new value with the original struck through. A gap offers "Confirm absent".
4. **Evidence.** Clicking a value jumps the PDF to its page without switching tabs; if the Text tab is open, it scrolls to the quote, highlighted in `<mark>`.

The UI uses Mantine; the review model and that choice are in [0008](docs/decisions/0008-reviews.md).

## Worker

Postgres is the truth; BullMQ jobs are only hints (`{ versionId }`). A job runs `processVersion`:
claim (lease) -> parse the PDF once and store the text -> plan chunks -> extract each missing chunk
(3 at a time) -> merge -> finish. Finish also links each value to the previous version's value for the same field and carries that value's review when its evidence is unchanged. Every write is guarded by the run id, so a run that lost its lease
writes nothing. The lease is renewed on its own timer, so a slow LLM call cannot lose it.

| Event                   | What happens                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Worker killed / restart | Lease expires (30 s); the reconciler (every 10 s) re-enqueues; the next run reuses stored text and chunk results.                     |
| SIGTERM                 | In-flight runs stop, the version goes back to `queued` without spending an attempt, and the next reconciler pass (≤ 10 s) resumes it. |
| Redis `FLUSHALL`        | Jobs vanish; the reconciler re-adds every `queued` or expired version from Postgres within 10 s.                                      |
| Missing key             | Version `failed` with `GEMINI_API_KEY is not set`; `POST /documents/:id/retry` once it is set.                                        |
| Scanned PDF / too long  | Version `failed` with a clear message (`No text layer found...`, `Document too long (N chunks; limit 50)`).                           |

Env: `EXTRACTOR` (`gemini` default, `fake`), `GEMINI_API_KEY` / `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `LLM_MAX_INFLIGHT`, `CHUNK_CONCURRENCY` (default 3), `UPLOAD_DIR`, `FIXTURES_DIR`, `REDIS_URL`, `DATABASE_URL`.

## Layout

```
apps/
  api/         Fastify HTTP API. Validates, writes to Postgres, enqueues jobs. Never calls the LLM.
  worker/      BullMQ worker. Parses the PDF, calls the configured LLM (Gemini or fake), validates evidence, writes values to Postgres.
  web/         Vite + React review UI (TanStack Query, React Router).
packages/
  db/          Prisma schema, SQL migrations (incl. hand-written CHECKs), seed script,
               document create/read/retry (documents.ts), worker claim/lease/finish (coordination.ts),
               test DB harness (@lomi/db/testing).
  files/       Content-addressed file store: files saved as <sha256>.pdf, written atomically.
  shared/      Zod schemas and types shared by API, worker, and UI (statuses, field defs).
  extraction/  Pure logic, no I/O: quote matching (text.ts), per-type value comparison (values.ts),
               page offsets (pages.ts), token-counted chunk planner (chunker.ts), prompt (prompt.ts),
               per-chunk validation (validate.ts), merge across chunks (merge.ts).
  queue/       BullMQ queue name, Redis connection, and job payload contract.
  config/      Shared tsconfig and ESLint flat config.
fixtures/      Sample PDFs and manifests from the assignment.
```

**Why these boundaries:**

- **api and worker are separate processes.** An upload never waits on the LLM, and each can crash or restart on its own.
- **`extraction` is pure.** The logic most likely to break (the hallucination check, carry-over matching) is unit-tested without Docker.
- **`db` and `queue` are shared.** The api, worker, and seed script agree on one schema and one job contract.

**Turbo pipeline:**

- `build`, `lint`, `typecheck`, and `test` all depend on `^build`, so a package's dependencies are built before it runs.
- `db:seed` depends on `db:migrate`.
- Outputs are cached. A second run with no changes is fully cached.

**Docker:** one `Dockerfile` uses `turbo prune` per app, so each image installs only its own dependency graph.

## Stack

| Concern      | Choice                   | Why                                                                                                                                                                                                                                                  |
| ------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP         | Fastify 5                | Built-in schema validation, `onClose` hooks for clean shutdown, pino logging, streaming multipart uploads                                                                                                                                            |
| DB           | Postgres 16 + Prisma 7   | Prisma 7 (`prisma-client` generator + `pg` driver adapter). Guarded `updateMany` + count checks, interactive transactions and `createMany({ skipDuplicates })` cover the idempotency rules; one raw `SELECT … FOR UPDATE` where row locks are needed |
| Queue        | BullMQ on Redis 7        | Coordinates work only. Postgres is the source of truth                                                                                                                                                                                               |
| LLM          | Gemini (default), fake   | JSON-schema structured outputs; the same evidence check applies to both ([0005](docs/decisions/0005-structured-outputs-and-model.md))                                                                                                                |
| PDF text     | unpdf                    | Maintained, pure JS                                                                                                                                                                                                                                  |
| UI           | Vite + React 19, Mantine | Plain SPA, no SSR needed. Mantine: the owner asked for a component library, it needs no Tailwind setup, and it supports React 19                                                                                                                     |
| Tests / lint | Vitest, ESLint, Prettier |                                                                                                                                                                                                                                                      |

## Verify

```sh
EXTRACTOR=fake FAKE_EXTRACTOR_DELAY_MS=15000 docker compose up -d   # build services one at a time first
bash scripts/verify-phase1.sh        # PASS/FAIL per check, non-zero exit on failure; restores the worker itself
```

The script needs bash (Git Bash on Windows), `curl`, `node` and `docker compose`, and the worker running with the fake extractor (it fails fast otherwise). It checks: the three seeded documents extract; a worker restart mid-extraction; a double upload (200, same id, one row); `FLUSHALL` plus restart of worker and api; `SIGKILL` of the worker (lease recovery); no duplicate values per version. When it ends (pass or fail) it restores the worker to your normal settings (`env -u EXTRACTOR -u FAKE_EXTRACTOR_DELAY_MS docker compose up -d worker`, i.e. from `.env` and compose defaults); a failure of that step does not change the exit code.

### Live extraction check

Run with Gemini (free tier) on 2026-11-27: the three fixtures were uploaded as new documents and extracted by `gemini-3.6-flash` (no fallback needed, one attempt each, 33 to 42 s per document). Result: **16 of 16 fields correct**, including the expected gap.

| Fixture       | Time   | Values                                                                                                                                                                                                                  |
| ------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| invoice       | 35.7 s | `invoice_number` INV-2025-0847, `issue_date` 2025-09-14, `due_date` 2025-10-14, `vendor_name` MERIDIAN OFFICE SUPPLIES LLC, `total_amount` $5,230.29                                                                    |
| lease         | 42.3 s | `tenant_name` Dana Okafor, `monthly_rent` $2,350.00, `security_deposit` $3,525.00, `lease_start` March 1, 2025, `term_months` 24                                                                                        |
| market report | 32.9 s | `report_quarter` Q3 2025, `market_area` Eastport-Harborview Submarket, `vacancy_rate` 4.2%, `average_rent_1br` $1,985, `year_over_year_rent_growth` 3.8%, `median_household_income` **gap** ("not stated in this part") |

`median_household_income` is a real gap: the report does not contain it, and the model returned no value instead of guessing.

History: an earlier run (before the numeric fix) was 15/16. The lease `term_months` came back as "twenty-four (24)" and failed the strict check. Since `e5dd89f` (prompt v2 and one-distinct-number rule, see [0007](docs/decisions/0007-numeric-values.md)) `term_months` is `24` and the run is 16/16. If every Gemini model is busy (429/503/timeouts) the versions go `failed` with a clear error and `POST /documents/:id/retry` re-runs only the missing chunks; no retry loop is built in beyond one retry per model.

## Schema

Full model in `packages/db/prisma/schema.prisma`.

- `documents` → has many `document_versions`. Each version stores its file key, sha256, **parsed text** (never rewritten), page offsets, status, and the lease fields the worker uses to claim it.
- `extraction_runs`: one per attempt (`running | succeeded | failed | abandoned`).
- `version_chunks` / `chunk_results`: the chunk plan and one stored LLM answer (prompt + raw response) per chunk, so a resumed run skips finished chunks.
- `extracted_values`: **unique (version_id, field)**, so a re-run can't duplicate values. A gap is `value = null` with a `gap_reason`, enforced by a CHECK constraint. `previous_value_id` / `carried_review_id` link to the previous version.
- `reviews`: append-only. The latest row per value is its current review.

## Decisions

Short notes (context, decision, alternatives, consequences) in [`docs/decisions/`](docs/decisions/): Postgres as source of truth, lease and reconciler, strict evidence check, chunking, structured outputs and model choice, Prisma, numeric values, reviews ([0008](docs/decisions/0008-reviews.md)).

## TODO (documented as they're decided)

- Delete a document (deferred). The plan is a hard delete of the document and all its versions in one locked transaction, keeping PDFs another document still uses. The worker would check before each chunk that its run still owns the version, so a delete stops LLM calls at the next chunk; in-flight calls are cut by the next lease renewal.
- Draft → submit review flow. Decisions held as drafts in localStorage per version, a sticky submit bar, a before/after summary, and an all-or-nothing `POST /documents/:id/reviews`. Deferred: the MVP saves each click.
- What happens when a new version arrives mid-extraction
- How "unchanged evidence" is matched across versions
- Polling vs streaming in the UI
- What was cut, and what changes at 10k documents
