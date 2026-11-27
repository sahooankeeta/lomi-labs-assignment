# Lomi Labs take-home: PDF extraction & review

> **Status: phase 1 in progress.** Done: shared contracts, file store, test DB harness, the pure extraction logic (quote matching, value comparison, chunking, prompt, validation, merge), the document read/write layer and worker coordination (claim, lease, chunks, finish, handoff) in `db`, the worker's LLM boundary (concurrency limiter; Claude, Gemini, fake and missing-key extractors). Next: API routes, the worker pipeline. Design: [`docs/superpowers/specs/2026-11-26-extraction-review-design.md`](docs/superpowers/specs/2026-11-26-extraction-review-design.md).

PDFs go in, Claude extracts structured values with quoted evidence, and a human approves or corrects each value. Reviews carry over across document versions when their evidence didn't change.

## Run it

```sh
cp .env.example .env        # add ANTHROPIC_API_KEY
docker compose up --build
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

### Checks

```sh
pnpm -r run build && pnpm -r run typecheck && pnpm -r run lint && pnpm -r run test
pnpm --filter @lomi/db test:integration   # needs Postgres; uses TEST_DATABASE_URL
pnpm --filter @lomi/worker smoke:claude   # live Claude call on the invoice fixture; needs ANTHROPIC_API_KEY, costs a few cents
pnpm --filter @lomi/worker smoke:gemini   # check a Gemini key: lists models, one extraction on the invoice; needs GEMINI_API_KEY (free tier)
```

(`pnpm turbo …` does the same where Windows Application Control doesn't block the turbo binary.)

Unit tests (`*.test.ts`) need nothing running. Integration tests (`*.int.test.ts`) read `TEST_DATABASE_URL` from `.env`, create that database if it's missing, apply migrations, and truncate tables between tests; they never touch the dev database.

### Extractor settings (worker)

| Variable                  | Default                    | Effect                                                                                                                                        |
| ------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | none                       | Without it the worker still starts, but every version fails with `ANTHROPIC_API_KEY is not set`.                                              |
| `ANTHROPIC_MODEL`         | `claude-sonnet-5-5`        | Model used for extraction and token counting.                                                                                                 |
| `LLM_MAX_INFLIGHT`        | `4`                        | Max concurrent LLM calls (Claude: token counts and extractions share the cap; Gemini: extractions).                                           |
| `EXTRACTOR`               | `claude`                   | `claude`, `gemini` or `fake`. Any other value makes every version fail with a clear message.                                                  |
| `GEMINI_API_KEY`          | none                       | Needed for `EXTRACTOR=gemini` (free tier: https://aistudio.google.com/apikey). Missing: every version fails with `GEMINI_API_KEY is not set`. |
| `GEMINI_MODEL`            | `gemini-3.6-flash`         | Primary Gemini model.                                                                                                                         |
| `GEMINI_FALLBACK_MODELS`  | `gemini-flash-lite-latest` | Comma-separated models tried in order when the primary is busy (429/503/timeout twice) or retired (404).                                      |
| `EXTRACTOR=fake`          | unset                      | Deterministic offline extractor for tests/e2e; ignores the API keys.                                                                          |
| `FAKE_EXTRACTOR_DELAY_MS` | `0`                        | Simulated latency per fake extraction.                                                                                                        |

`EXTRACTOR=gemini` runs on Google's free tier, which has rate limits and models that are sometimes overloaded: a busy model is retried once, then the next fallback model is used, and stored results record which model answered. Token counts are a local estimate (length / 4), so Gemini uses no quota for them. Answers go through the same evidence check as Claude's.

## Layout

```
apps/
  api/         Fastify HTTP API. Validates, writes to Postgres, enqueues jobs. Never calls the LLM.
  worker/      BullMQ worker. Parses the PDF, calls Claude, validates evidence, writes values to Postgres.
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
| LLM          | Anthropic Claude         | Tool use with a JSON schema gives structured output                                                                                                                                                                                                  |
| PDF text     | unpdf                    | Maintained, pure JS                                                                                                                                                                                                                                  |
| UI           | Vite + React 19          | Plain SPA, no SSR needed                                                                                                                                                                                                                             |
| Tests / lint | Vitest, ESLint, Prettier |                                                                                                                                                                                                                                                      |

## Schema

Full model in `packages/db/prisma/schema.prisma`.

- `documents` → has many `document_versions`. Each version stores its file key, sha256, **parsed text** (never rewritten), page offsets, status, and the lease fields the worker uses to claim it.
- `extraction_runs`: one per attempt (`running | succeeded | failed | abandoned`).
- `version_chunks` / `chunk_results`: the chunk plan and one stored LLM answer (prompt + raw response) per chunk, so a resumed run skips finished chunks.
- `extracted_values`: **unique (version_id, field)**, so a re-run can't duplicate values. A gap is `value = null` with a `gap_reason`, enforced by a CHECK constraint. `previous_value_id` / `carried_review_id` link to the previous version.
- `reviews`: append-only. The latest row per value is its current review.

## TODO (documented as they're decided)

- Redis/Postgres consistency and FLUSHALL recovery
- What happens when a new version arrives mid-extraction
- How "unchanged evidence" is matched across versions
- Polling vs streaming in the UI
- What was cut, and what changes at 10k documents
