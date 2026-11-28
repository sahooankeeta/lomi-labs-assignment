# Design: PDF extraction & review (Lomi Labs take-home)

Date: 2026-11-26 · Deadline: Sat 2026-11-28 23:59 UTC · Brief: github.com/Lomi-Labs/take-home-assignment

## Intent

A take-home that is judged on design decisions as much as on code. PDFs go in, Claude extracts
per-type fields with verbatim evidence, a human approves or corrects every value, and a revised
version carries over reviews whose evidence didn't change. The graders will deliberately break it
(container restarts mid-extraction, `FLUSHALL`, double uploads, v2 during v1), so robustness of the
required behaviors beats breadth. Every choice below must be defensible in an interview and is
written up in the README.

## Goals

- All five routes from the brief, plus a retry route, behaving as specified.
- Required behaviors hold under the graders' tests: instant upload, restart-safe, `FLUSHALL`-safe,
  no duplicate values, failure is a visible retryable state, evidence validated verbatim against
  the version's own text, gaps carry reasons.
- Uploading `invoice-001.v2.pdf` leaves exactly the two changed fields pending; the other three are
  carried over.
- A reviewer understands what needs attention within five seconds of opening a document.
- `docker compose up` gives a clickable app with v1 of every fixture seeded **and extracted**
  (given an API key).

## Non-goals

- Deployment and the walkthrough video (not now).
- Auth, multi-tenant, users/reviewer identity.
- OCR / scanned PDFs, multi-page layout reasoning, highlighting quotes _on the rendered PDF_
  (the PDF is shown; the quote is highlighted in the parsed-text panel).
- External object storage (Supabase/S3/MinIO): files stay on a compose volume behind `FileStore`.
- Editing field definitions; new document types beyond the three fixtures' types.
- Visual polish.

## Anti-goals (would fail even if it "works")

- Any state a user can see living only in Redis.
- A document stuck in `extracting` forever, or disappearing without a user's confirmed delete.
- A value kept whose evidence isn't verbatim in its version's text, or a "best guess" for a missing
  field.
- A re-run, retry or crash recovery producing duplicate or mixed (two runs interleaved) values.
- Overwriting or deleting earlier versions, values or reviews (by re-extraction or a new version).

## Constraints

- Stack: pnpm + Turborepo, Fastify 5, **Prisma 7.10 (stable; 8.0 is still RC) + Postgres 16**,
  BullMQ 6 on Redis 7 (ioredis client instances), Anthropic SDK, unpdf,
  Vite + React 19 + TanStack Query. The skeleton's Drizzle db package is replaced by Prisma in phase 1.
- Packages: `apps/{api,worker,web}`, `packages/{db,shared,extraction,queue,config}`. The api never
  calls the LLM or parses PDFs; `packages/extraction` stays pure (no I/O).
- Model from `ANTHROPIC_MODEL`, default **`claude-sonnet-5-5`** (user's call: no costlier model
  unless Sonnet misses the criteria; Opus is a one-line env change). Missing `ANTHROPIC_API_KEY` must
  surface as a visible `failed` version, not a crash.

## Approaches (phasing)

- **A. Vertical slices, each phase demoable — chosen.** Phase 1 holds the behaviors the graders
  test; every later phase leaves a submittable app.
- B. Whole backend first, then UI. Faster to backend-complete, but nothing is visible until late and
  a time crunch cuts the review UI — the part graders open first. Rejected.

## Decisions made with the user

- Vertical phases (A).
- Corrections live **beside** the extracted value (annotation model): the LLM's value is immutable;
  a review row carries `corrected_value`. "Effective value" = corrected value if the latest review
  is a correction, else the extracted value.
- A new version arriving while the previous one is still queued/extracting **supersedes** it.
- UI **polls**, only while something is `queued` or `extracting`.
- Deployment and video out of scope for now.
- **Prisma instead of Drizzle**, chosen after reading the JD ("we use Prisma heavily"). Prisma 7
  with the `prisma-client` generator and `@prisma/adapter-pg` driver adapter (no Rust engine, ESM).
  How the coordination rules map onto it:
  - claim / finish guarded updates → `updateMany({ where: { id, status, activeRunId, ... } })` and
    check `count === 1` (no `RETURNING` needed);
  - finish + values + carry-over → interactive `$transaction`;
  - backstop against duplicates → `createMany({ skipDuplicates: true })` (= `ON CONFLICT DO NOTHING`)
    plus the `@@unique([versionId, field])`;
  - locking the document row for a new version → one `$queryRaw` `SELECT … FOR UPDATE` inside the
    transaction;
  - the value-xor-gap `CHECK` constraint isn't expressible in `schema.prisma` → hand-added to the
    generated migration SQL.
    Migrations via `prisma migrate dev` locally and `prisma migrate deploy` in the compose `migrate`
    service; `prisma generate` runs in the db package's `build` so turbo orders it before dependents.
- **Strict evidence check.** Besides the quote appearing verbatim in the version's text, the
  value must appear in its own quote, compared per type: money/number/percent by digits
  (`5230.29` ~ `$5,230.29`), dates by parsed date (`2026-03-15` ~ `March 15, 2026`), strings by
  case-insensitive substring. Failure → gap "value not found in its quote". Accepted cost:
  occasional false gaps, which the reviewer fixes with a correction.
- Frontend stays **Vite** (not Next.js), re-confirmed after reading the JD.
- **Structured outputs, not a forced tool call.** The response is constrained with
  `output_config.format` (JSON schema); forced `tool_choice` is rejected by current models.
- **Chunking (text PDFs only):** token-based, paragraph/section boundaries preferred, no text
  ever dropped between chunks, bounded concurrency, restart can't duplicate values, parsed text
  and chunks stored per version. Details under Extraction → Chunking.
- **Token counting uses Claude's own counter** (`messages.countTokens`), not a third-party
  tokenizer (user's call). Anthropic ships no local tokenizer for current models, so counts come
  from the API; tests inject a fake counter. See Chunking.
- Decisions are also written as short notes in `docs/decisions/` (one file per decision: context,
  choice, alternatives, consequences); the README stays short and links to them.
- **Delete is a hard delete of the whole document** (never a single version), user-confirmed, in
  one locked transaction. See [0010](../../decisions/0010-document-delete.md).

## Design

### Data model (changes to the skeleton schema)

- `document_versions.status` enum gains `superseded` (version-level; the brief's four statuses are
  what `GET /documents/:id` reports for the current version).
- `document_versions` gains: `active_run_id` (uuid, the run allowed to finish it),
  `lease_expires_at` (timestamptz), `attempts` (int), `page_offsets` (int[]), `total_tokens`
  (int, Claude's count for the whole text) and `chars_per_token` (float, derived from it and
  used to plan this version's chunks).
- New `version_chunks` (the chunk plan, written once per version): `version_id`, `chunk_index`,
  `start`, `end` (offsets into `parsed_text`; chunk text is always that exact slice, never a
  copy), `tokens` (Claude's count for that exact slice), `first_page`, `last_page`; `unique(version_id, chunk_index)`.
- New `chunk_results` (one LLM answer per chunk): `version_id`, `chunk_index`, `prompt_version`,
  `run_id` (who produced it), `prompt`, `raw_response`, parsed candidates (jsonb), timings;
  `unique(version_id, chunk_index, prompt_version)`. Not keyed by run, so a resumed run reuses
  chunks a dead run already finished. These are intermediate results, never shown as values.
- `extraction_runs` (one row per attempt): status `running | succeeded | failed | abandoned`,
  `prompt`, `raw_response`, `model`, `error`, timings. Kept forever for debugging.
- `extracted_values`: rename `carried_from_value_id` → `previous_value_id` (same field in the
  previous extracted version, set whenever one exists), add `carried_review_id` (the previous
  version's review that this value inherits; null if evidence changed or nothing to inherit).
  Add `evidence_page`, `evidence_start`, `evidence_end` (null for gaps).
  Keep `unique(version_id, field)` and the value-xor-gap check. Values are immutable.
- `reviews`: unchanged, append-only. Latest row per value = current review.
- Derived review state per value: latest own review → `approved`/`corrected`; else
  `carried_review_id` set → `carried_over`; else `pending`.

### Redis / Postgres line

Postgres holds everything a user can see: versions + status + error, runs, values, reviews.
A BullMQ job carries only `{ versionId }` and is a _hint_ that work exists. Losing every job is
recoverable because Postgres says what is unfinished.

- **Enqueue:** commit the version row (`queued`) first, then `queue.add`. If the add fails or Redis
  is flushed afterwards, the reconciler re-enqueues.
- **Claim (worker):** one conditional `UPDATE document_versions SET status='extracting',
active_run_id=:newRun, lease_expires_at=now()+interval, attempts=attempts+1 WHERE id=:v AND
(status='queued' OR (status='extracting' AND lease_expires_at < now())) RETURNING`. No row →
  ack the job and do nothing (already done, superseded, or someone else holds a live lease). This
  makes duplicate jobs harmless.
- **Lease:** 30 s, renewed every 10 s by the worker while it runs; a killed worker's lease
  just expires.
- **Finish:** (after every chunk has a `chunk_result`, merged as in Chunking) one transaction: `UPDATE ... SET status='extracted' WHERE id=:v AND
active_run_id=:run AND status='extracting' RETURNING`; if no row, roll back (stale run — lost
  lease or superseded) and mark the run `abandoned`. Otherwise insert values
  (`ON CONFLICT (version_id, field) DO NOTHING` as a backstop), compute carry-over, mark run
  `succeeded`, all in the same transaction. Values for a version are therefore written exactly
  once, by exactly one run.
- **Failure:** any parse/LLM/validation-infrastructure error → same guarded update to `failed` with
  a human-readable `error`; run `failed`. The SDK's built-in retries handle transient API errors;
  BullMQ `attempts: 1` so there is one place that decides failure.
- **Reconciler** (in the worker, at startup and every ~10 s): enqueue every version that is
  `queued`, or `extracting` with an expired lease. Job ids include `attempts` so a re-add isn't
  swallowed by a retained completed job of the same id; duplicates are safe anyway (claim).
- **Retry:** `POST /documents/:id/retry` moves the current version `failed → queued` and enqueues.
  Retry resets `attempts` to 0.
- **Graceful shutdown handoff (SIGTERM):** `docker compose restart/stop` sends SIGTERM and waits
  ~10 s before SIGKILL. On SIGTERM the worker stops taking jobs, and for each version it holds it
  runs a guarded update `extracting → queued` (`WHERE active_run_id = :run`), marks the run
  `abandoned`, and exits. The next worker re-claims immediately at startup instead of waiting for
  the lease to expire. SIGKILL/crash/power loss skip this; the lease expiry is the safety net.
- **Attempt cap (crash loops):** the claim increments `attempts`. If a claim would start attempt
  #4 (i.e. three runs were interrupted without finishing), it instead sets the version `failed`
  with "extraction was interrupted 3 times" — visibly retryable, never an endless
  claim → crash → re-queue loop. A graceful handoff does not count as an attempt (it decrements
  back).
- **Timeouts:** each Claude call has a request timeout (~60 s); a hang becomes an error → `failed`.
  Chunk results already saved survive the failure, so Retry only redoes the missing chunks.

### File storage

- `FileStore` interface (`put(bytes) → key`, `get(key) → stream`) with one implementation: the
  shared compose volume `uploads` at `/data/uploads` (api, worker, migrate). Key = `<sha256>.pdf`
  (content-addressed, so writes are idempotent). Postgres stores `file_path` (the key) + `sha256`.
- Write order: file first, then the DB transaction. A crash in between leaves an orphan file
  (harmless), never a row pointing at a missing file.
- Supabase Storage / S3 / GCS rejected for now: they'd need external credentials and break the
  self-contained `docker compose up`. README notes it is a one-class swap in production.

### Ingest and versions

- **Type is chosen by the user**, never detected (the brief: "upload a PDF (type + file)"). The
  upload form has a dropdown; the API validates `type` against the keys of `expected-fields.json`
  (`invoice | lease | market_report`) → `400` otherwise, before anything is stored. New versions
  inherit the document's type; the seed takes it from `documents.json`. No LLM classification
  (extra call, and a wrong type turns every field into a gap).
- **Ids are UUIDs everywhere**, generated server-side; the fixture ids in `documents.json`
  (`doc-invoice-001`, …) are not used as keys.
- `POST /documents` (multipart: `type`, optional `title`, `file`): validate type and PDF magic,
  write the file to `UPLOAD_DIR`, compute sha256, insert document + version 1 (`queued`) in one
  transaction, enqueue, respond `201` with the document. No parsing in the api.
- `POST /documents/:id/versions`: same, inside a transaction that locks the document row
  (`FOR UPDATE`), takes `max(version_no)+1`, marks any `queued`/`extracting` older version
  `superseded`, points `current_version_id` at the new one.
- Re-uploading a file whose sha256 equals the current version's returns the current version
  (`200`) without creating a new one. _(builder call — absorbs the impatient double-click)_
- Seed (compose `migrate`): for each entry in `documents.json`, hash the v1 PDF; if a document
  of that type whose v1 has that sha256 already exists, skip (same rule as the double-upload
  dedupe, so re-running the seed on every `compose up` creates nothing); else create it with a
  new UUID and v1 `queued`. The reconciler picks them up, so the graders see extraction happen
  on first boot.
- Dedupe is checked **in code inside the locked transaction**, not by a unique
  `(document_id, sha256)` constraint, so re-uploading an older file as a new version (a revert)
  stays possible.

### Extraction (worker + pure `packages/extraction`)

1. Parse PDF with unpdf (a server build of pdfjs-dist), **per page**: `parsed_text` = pages joined
   with a fixed separator, plus `page_offsets` (int[] of each page's start offset) on the version.
   Stored, not re-parsed: version N's text is fixed forever.
   - Parsed text shorter than ~20 non-whitespace characters → `failed`: "No text layer found
     (scanned PDF?); OCR is not supported".
   - Upload is capped at 20 MB (`413`); text length is bounded by the chunk cap below.
2. Plan chunks (see Chunking) and store the plan.
3. For each chunk not yet in `chunk_results`, build a prompt from the type's fields
   (`expected-fields.json`) and the chunk text; call Claude with **structured outputs**
   (`output_config.format`, JSON schema with one entry per field:
   `{ field, value: string|null, evidence: string|null, gap_reason: string|null }`). Store prompt +
   raw response + validated candidates in `chunk_results`. The prompt asks for the **shortest
   verbatim passage that contains the value** (e.g. `Issue Date: 2025-09-14`, not that line
   plus the next) — this keeps carry-over from failing on an unrelated neighbouring change.
4. Validate per field per chunk (pure function): missing/malformed entry → gap "not returned by model";
   value null → gap with the model's reason; evidence not found verbatim in the parsed text →
   gap "evidence not found in document text" (value discarded); value not supported by its own
   evidence (strict rule above) → gap "value not found in its quote". "Verbatim" is checked after
   normalizing both sides identically: Unicode NFKC, curly quotes/dashes to ASCII, whitespace runs
   collapsed. Nothing looser (no fuzzy matching). The quote is searched **inside its own chunk**
   (then mapped to version offsets), so a repeated phrase resolves to the place the model saw.
5. Merge chunk candidates into one value or gap per field (see Chunking).
6. For each kept value, the match position of its evidence gives `evidence_start` /
   `evidence_end` (offsets into `parsed_text`) and `evidence_page` (1-based, from
   `page_offsets`), stored on the value. Offsets refer to the original text, so matching keeps a
   map from normalized to original positions.
7. Values stored as returned (trimmed); a per-type normalizer (date → ISO, money/number/percent →
   canonical number) is used only for comparisons.

### Chunking (text-based PDFs only)

Every document goes through the same path; the three fixtures simply come out as one chunk each.

- **Token counting = Claude's `messages.countTokens`** (exact for the configured model; free,
  rate-limited). A `TokenCounter` interface lives in `packages/extraction` so the chunker stays
  pure; the worker passes the Claude-backed one, tests and `EXTRACTOR=fake` pass a deterministic
  fake (≈ 4 chars/token). Flow:
  1. Count the whole text once → `total_tokens`. At or under the target (~6k) → one chunk, done
     (all three fixtures: one call).
  2. Otherwise `chars_per_token = length / total_tokens` for _this_ document (numbers, tables
     and prose differ, so no global ratio), and the packer plans chunks to the target using it.
  3. Each planned chunk is counted with `countTokens`; one over the hard max (8k) is re-split at
     its next-weaker boundary and re-counted. Calls go through the same concurrency limiter as
     extraction calls.
  4. The plan with each chunk's exact `tokens` is stored, so a restart re-uses it and never
     re-counts.
     A failed count call (after the SDK's retries) fails the version like any other API error.
- **Boundaries, strongest first:** page break → heading-like line (short line, no final
  punctuation, followed by a blank line or all-caps/numbered) → blank line (paragraph) → line
  break → sentence end → whitespace. The packer fills a chunk greedily with whole units at the
  strongest level that fits; it only drops to a weaker level when one unit alone exceeds the max
  (e.g. a giant table). Never cuts inside a word.
- **Nothing discarded.** Chunks tile `parsed_text`: chunk _i_ starts where chunk _i−1_'s
  non-overlap part ended, the first starts at 0 and the last ends at `length`. A pure
  `assertTiling(plan, length)` checks it; a gap or a negative step throws (a bug, not a
  document problem). Each chunk also includes the previous chunk's last paragraph as
  **overlap** (≤ ~200 tokens) so a value whose label and number straddle a boundary is still seen
  whole.
- **Cap:** more than 50 chunks (~300k tokens) → `failed`: "Document too long (N chunks; limit
  50)". Replaces the earlier 100k-character cap.
- **Bounded concurrency.** Chunks of one version run through a limiter of `CHUNK_CONCURRENCY=3`;
  all LLM calls in a worker process also share one `LLM_MAX_INFLIGHT=4` semaphore, so two
  versions × many chunks never fan out unbounded. BullMQ worker concurrency stays 2.
- **Merge per field** (pure, deterministic, chunk order):
  - no chunk returned a value → gap; reason from the first chunk's `gap_reason`, else "not found
    in document";
  - one distinct normalized value (overlap often finds the same value twice) → that value, with
    the evidence from the earliest chunk;
  - two or more different normalized values → gap "conflicting values found: A (p.2), B (p.5)";
    the candidates are kept on the gap so the reviewer can correct to one of them.
- **Restart safety / no duplicates.** The chunk plan is written once (`unique(version_id,
chunk_index)`, insert-if-absent right after the claim). Chunk results are inserted with
  `skipDuplicates`, so two runs finishing the same chunk keep one row. Values are never written
  per chunk: they are written only in the guarded finish transaction from the merged result,
  with `unique(version_id, field)` as a backstop. A worker killed after 7 of 10 chunks resumes at
  chunk 8 under a new run.
- **Per version.** Parsed text, page offsets, chunk plan and chunk results all hang off
  `version_id` and are never rewritten, so v1's text and chunks stay available after v2 exists.

### Carry-over ("unchanged evidence")

Computed in the finish transaction, against the **latest `extracted` version older than this
one** (a superseded version has no values and is skipped). Per field:

- **Unchanged** ⇔ both are non-gap values, their normalized values are equal, **and** the previous
  version's evidence still appears verbatim (normalized) in the new version's parsed text.
  → `previous_value_id` set, `carried_review_id` = previous value's effective review (its own
  latest review, or what it had itself carried). If the previous value was never reviewed there is
  nothing to carry; it stays pending.
- **Otherwise** (value changed, evidence gone, either side a gap) → pending, `previous_value_id`
  set so the UI shows the old value and its review beside it.

Why this holds when text shifts: it compares quoted passages and values, never offsets or page
positions, and tolerates the model quoting a slightly different span on the second run because it
checks the _old_ quote against the _new_ text. Gaps never carry over _(builder call; documented)_.

### API

- `GET /documents` — list: id, title, type, current version no, status, progress counts.
- `GET /documents/:id` — current version (no, status, error, parsed text), values with evidence,
  gap reason, derived review state, latest review, and for values with `previous_value_id` the
  previous value + its review. `?version=N` returns an older version, read-only.
- `GET /documents/:id/versions` — version history with statuses.
- `GET /versions/:id/file` — streams that version's PDF (`application/pdf`), so v1's file is
  still viewable after v2 exists.
- `POST /values/:id/review` — `{ action: 'approve' }` or `{ action: 'correct', value, note? }`.
  Only values of the current, extracted version are reviewable (`409` otherwise). Appends a row.
  Correcting a gap is allowed (the reviewer supplies the missing value).
- `GET /documents/:id/progress` — `{ pending, approved, corrected, carried_over, gaps, total }` for
  the current version.
- `POST /documents/:id/retry` — see above.
- Errors are JSON `{ error, message }` with correct status codes; Zod validates every input.

### UI

- **List (`/`)**: table of documents — title, type, `vN`, status pill, progress ("3 pending · 2
  approved"); upload form (type + file). Polls every 2 s while any row is queued/extracting.
- **Detail (`/documents/:id`)**: header with status, version, progress and an "upload new version"
  control; failed → error text + Retry button. Left: values grouped attention-first (pending &
  gaps, then carried over, then approved/corrected). Each card: field, value (and correction),
  quoted evidence, state badge, Approve / Correct (value + optional note). Changed values show
  "was X in v1 (approved)". Each card shows "page N" from `evidence_page`. Right: a panel with two tabs —
  **PDF** (rendered with `react-pdf`; selecting a value jumps to its page; no on-PDF highlight) and
  **Text** (parsed text with the selected value's evidence highlighted via its offsets).
  Version switcher for read-only history.

### Tests (what is most likely to break)

- Pure chunker: tiling holds (no gaps) on random text, boundaries prefer pages/paragraphs,
  oversized paragraph falls back to sentences, overlap stays within budget, the plan is identical
  for the same text + counter, an over-max chunk is re-split, the 50-chunk cap; merge rules (none / same twice / conflicting).
- Pure (`packages/extraction`): evidence normalization + verbatim check (incl. hallucinated quote,
  whitespace/quote differences), value-in-quote per type (incl. real quote + wrong number → gap), LLM-output validation into values/gaps, carry-over decision table,
  and carry-over on the real parsed text of invoice v1 vs v2 → exactly two changed fields.
- Integration (api + worker logic against real Postgres from compose, LLM behind an `Extractor`
  interface with a fake): claim/finish idempotency (two runs → one set of values), stale-run
  finish is discarded, supersede during extraction, expired-lease recovery, resume skips finished
  chunks, concurrency limit is never exceeded, failure → `failed` →
  retry, review rules and progress counts.
- Phase 4 script `scripts/chaos.sh`: restart mid-extraction, `FLUSHALL` + restart, double upload,
  v2 during v1 — each asserts the end state via the API.

### Schema (Prisma, phase 1)

```prisma
enum DocumentType  { invoice  lease  market_report }
enum VersionStatus { queued  extracting  extracted  failed  superseded }
enum RunStatus     { running  succeeded  failed  abandoned }
enum ReviewAction  { approve  correct }

model Document {            // documents
  id               String  @id @default(uuid()) @db.Uuid
  type             DocumentType
  title            String
  currentVersionId String? @unique @db.Uuid        // -> DocumentVersion
  createdAt        DateTime @default(now())
}

model DocumentVersion {     // document_versions
  id             String @id @default(uuid()) @db.Uuid
  documentId     String @db.Uuid
  versionNo      Int
  fileKey        String                              // "<sha256>.pdf" in FileStore
  sha256         String
  status         VersionStatus @default(queued)
  error          String?
  parsedText     String?                             // fixed once parsed
  pageOffsets    Int[]
  totalTokens    Int?                                // Claude countTokens, whole text
  charsPerToken  Float?
  activeRunId    String?   @db.Uuid
  leaseExpiresAt DateTime?
  attempts       Int @default(0)
  createdAt      DateTime @default(now())
  @@unique([documentId, versionNo])
  @@index([status, leaseExpiresAt])                  // reconciler scan
}

model ExtractionRun {       // extraction_runs, one per attempt
  id String @id @db.Uuid; versionId String @db.Uuid; status RunStatus @default(running)
  model String; error String?; startedAt DateTime @default(now()); finishedAt DateTime?
}

model VersionChunk {        // version_chunks, the plan, written once
  versionId String @db.Uuid; chunkIndex Int
  start Int; end Int                                 // slice of parsedText
  tokens Int; firstPage Int; lastPage Int
  @@id([versionId, chunkIndex])
}

model ChunkResult {         // chunk_results, one LLM answer per chunk
  versionId String @db.Uuid; chunkIndex Int; promptVersion String
  runId String @db.Uuid; prompt String; rawResponse Json; candidates Json
  createdAt DateTime @default(now())
  @@id([versionId, chunkIndex, promptVersion])
}

model ExtractedValue {      // extracted_values, immutable
  id String @id @default(uuid()) @db.Uuid
  versionId String @db.Uuid; field String
  value String?; evidence String?; gapReason String?
  candidates Json?                                   // conflicting values on a gap
  evidencePage Int?; evidenceStart Int?; evidenceEnd Int?
  previousValueId String? @db.Uuid                   // same field, previous extracted version
  carriedReviewId String? @db.Uuid                   // inherited review, if unchanged
  createdAt DateTime @default(now())
  @@unique([versionId, field])                       // no duplicate values, ever
}

model Review {              // reviews, append-only
  id String @id @default(uuid()) @db.Uuid
  valueId String @db.Uuid; action ReviewAction
  correctedValue String?; note String?; createdAt DateTime @default(now())
  @@index([valueId, createdAt])                      // latest review per value
}
```

Columns map to snake_case (`@map`/`@@map`); relations as the comments say. Hand-added to the
migration SQL: `CHECK ((value IS NOT NULL AND evidence IS NOT NULL AND gap_reason IS NULL) OR
(value IS NULL AND gap_reason IS NOT NULL))` and `CHECK (action <> 'correct' OR corrected_value
IS NOT NULL)`. Prompt + raw response live per chunk in `chunk_results` (the run row holds
status/model/error/timings).

### Routes (summary)

| Method & path                  | Body / query                                              | Success                                                                                                                                              | Errors                              |
| ------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `GET /health`                  | –                                                         | `{pg, redis}`                                                                                                                                        | 503                                 |
| `GET /documents`               | –                                                         | `[{id, title, type, versionNo, status, progress}]`                                                                                                   | –                                   |
| `POST /documents`              | multipart `type`, `title?`, `file`                        | 201, or 200 existing (same type + v1 sha)                                                                                                            | 400 type / not PDF, 413             |
| `GET /documents/:id`           | `?version=N`                                              | doc + version (status, error, parsedText, pageOffsets) + values (evidence, page, offsets, gap reason, state, latest review, previous value + review) | 404                                 |
| `GET /documents/:id/versions`  | –                                                         | `[{id, versionNo, status, error, createdAt}]`                                                                                                        | 404                                 |
| `POST /documents/:id/versions` | multipart `file`                                          | 201 (older unfinished → superseded), or 200 if same as current                                                                                       | 400, 404, 413                       |
| `GET /versions/:id/file`       | –                                                         | PDF stream                                                                                                                                           | 404                                 |
| `POST /values/:id/review`      | `{action:'approve'}` / `{action:'correct', value, note?}` | 201 review + new state                                                                                                                               | 400, 404, 409 not current/extracted |
| `GET /documents/:id/progress`  | –                                                         | `{pending, approved, corrected, carried_over, gaps, total}`                                                                                          | 404                                 |
| `POST /documents/:id/retry`    | –                                                         | 202, back to `queued`                                                                                                                                | 404, 409 unless `failed`            |

Errors are `{error, message}`; inputs validated by Zod schemas in `packages/shared`.

### Fixture cross-check (parsed with unpdf)

Every fixture is one page (~1.7 KB) → one chunk. Invoice v1→v2 changes `due_date`
(2025-10-14 → 2025-11-13) and `total_amount` ($5,230.29 → $6,126.45); `invoice_number`,
`issue_date`, `vendor_name` are identical → exactly two pending. Lease `term_months` quote is
"twenty-four (24)\nmonths" (whitespace normalization + digit check handle it); `lease_start` is
"March 1, 2025" (date compare). Market report `median_household_income` is absent → a real gap.
Money compare must treat `1985` and `1985.00` as equal.

## Phases

1. **Ingest & extraction** — replace Drizzle with Prisma (schema, migration, seed, Docker),
   `FileStore`, ingest routes, GET document, worker (per-page parse, chunking + bounded
   concurrency, structured-output LLM calls, validate, merge, evidence
   page/offsets, claim/lease/finish, SIGTERM handoff, attempt cap), reconciler, retry, failure
   states, tests above for these.
2. **Review** — review + progress + list routes + file route; list and detail UI with
   approve/correct, gaps, page numbers, PDF viewer (react-pdf) with page jump, and text highlight.
3. **Re-extraction & carry-over** — version upload + supersede, carry-over in finish, UI for
   carried/changed values and version history.
4. **Hardening & README** — chaos script, remaining tests, README covering every section the brief
   asks for and every decision above.

## Calls made after the builder check (builder calls, adjustable)

- **Gaps are reviewable.** Approve on a gap = "confirmed absent from the document"; correct on a gap
  supplies the missing value. Progress counts every value once by review state
  (`pending/approved/corrected/carried_over`, summing to `total`); `gaps` is an extra informational
  count of gap values, overlapping the others. The list shows "N need review" = pending.
- **Double upload to `POST /documents`:** same `type` + same sha256 as an existing document's
  version 1 returns that document (`200`) instead of creating a second one. Different bytes = new
  document.
- **Tests split by what they need.** `test` (in `turbo test`) is pure/unit only and passes on a
  fresh clone with nothing running. `test:integration` is a separate turbo task needing Postgres
  (`docker compose up -d postgres redis`); it fails loudly if unreachable, never silently skips.
- **Fake extractor, opt-in only.** `EXTRACTOR=fake` (+ optional `FAKE_EXTRACTOR_DELAY_MS`) makes the
  worker return deterministic values from the fixtures' text, for the chaos script's
  "mid-extraction" timing and integration tests. Default is the real Claude extractor; without an
  API key versions go visibly `failed` with "ANTHROPIC_API_KEY is not set" and are retryable.
- **Multiple workers supported; fast recovery via short leases.** Lease 30 s, renewed every 10 s,
  reconciler every 10 s, so an interrupted extraction is re-claimed within ~40 s of the stack coming
  back. No worker-identity bookkeeping is needed beyond `active_run_id`.

## Left to the builder

Exact lease length and reconciler interval, exact chunk target/overlap sizes and the heading
heuristic, prompt wording, Prisma query style, component
structure, styling, file naming in `UPLOAD_DIR`, and the type normalizers' edge cases.
