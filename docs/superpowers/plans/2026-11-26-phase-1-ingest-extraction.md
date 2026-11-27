# Phase 1 — Ingest & Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload a PDF (or boot with the seeded fixtures) and have the worker extract every field
with verbatim evidence into Postgres — restart-safe, `FLUSHALL`-safe, duplicate-free, with failure
as a visible, retryable state.

**Architecture:** Postgres is the source of truth; a BullMQ job `{ versionId }` is only a hint.
The worker claims a version with a guarded update + 30 s lease, parses the PDF per page, plans
token-counted chunks, runs bounded-concurrency structured-output Claude calls per chunk (results
stored per chunk), validates evidence strictly, merges per field, and writes values once in a
guarded finish transaction. A reconciler re-enqueues anything Postgres says is unfinished.

**Tech Stack:** pnpm + Turborepo, TypeScript (ESM, NodeNext), Fastify 5, Prisma 7.10.1 +
`@prisma/adapter-pg`, BullMQ 6 + ioredis, `@anthropic-ai/sdk` (`messages.parse` +
`zodOutputFormat`, `messages.countTokens`), unpdf, Zod 4, Vitest, pino (`@lomi/logger`).

**Spec:** `docs/superpowers/specs/2026-11-26-extraction-review-design.md` (read it first; this
plan implements its Phase 1 and argues from it).

## Global Constraints

- Model from `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`. Never force `tool_choice`; use
  structured outputs (`output_config.format`).
- Missing `ANTHROPIC_API_KEY` → version `failed` with `ANTHROPIC_API_KEY is not set`, never a crash.
- `packages/extraction` stays pure: no `fs`, network, DB, env reads, or clock.
- The api never calls the LLM and never parses PDFs.
- Lease `30_000` ms, renewed every `10_000` ms; reconciler every `10_000` ms; max attempts `3`;
  Claude request timeout `60_000` ms.
- Chunking: target `6000` tokens, hard max `8000`, overlap ≤ `200` tokens, max `50` chunks;
  `CHUNK_CONCURRENCY=3`, `LLM_MAX_INFLIGHT=4`, BullMQ worker concurrency `2`, BullMQ job
  `attempts: 1`.
- Upload cap 20 MB → `413`. Scanned check: < 20 non-whitespace chars → `failed`:
  `No text layer found (scanned PDF?); OCR is not supported`.
- Too many chunks → `failed`: `Document too long (N chunks; limit 50)`.
- Interrupted 3 times → `failed`: `extraction was interrupted 3 times`.
- Gap reasons (exact strings): `not returned by model`, `evidence not found in document text`,
  `value not found in its quote`, `not found in document`, and
  `conflicting values found: A (p.X), B (p.Y)`.
- API errors are JSON `{ error, message }`, `error` ∈ `bad_request | not_found | conflict |
  payload_too_large | internal`.
- File key = `<sha256>.pdf`; file written **before** the DB transaction.
- Every task's unit tests run with nothing else up (`pnpm --filter <pkg> test`). Integration tests
  (`*.int.test.ts`, `test:integration`) need `docker compose up -d postgres redis` and fail loudly
  if Postgres is unreachable.
- Turbo is blocked by Windows Application Control on this machine: run checks with
  `pnpm -r run build|lint|typecheck|test` or `pnpm --filter <pkg> <script>`.
- **Commit in small chunks**: every task commits after each sub-deliverable (the `Commit` steps
  below), never one commit at the end of a task. Messages use conventional prefixes
  (`feat:`, `test:`, `chore:`, `fix:`), end with the repo's `Co-Authored-By` trailer, and are
  pushed only when the user asks.

## Review Focus

1. **Redis down during upload** → `POST /documents` still returns `201`; the version stays
   `queued` and the reconciler enqueues it once Redis is back. Pinned in Task 7.
2. **Two identical uploads at the same instant** (double-click) → exactly one document. Pinned in
   Task 5 (`Promise.all` of two `createDocumentWithV1`).
3. **Model output with unknown or duplicated field names** → unknown ignored, first occurrence
   wins, missing fields become `not returned by model`. Pinned in Task 4.
4. **Quote that occurs twice in the document** → offsets/page of the occurrence inside the chunk
   the model saw, first occurrence within that chunk. Pinned in Task 4.
5. **PDF with an empty page** (equal consecutive page offsets) → `pageOf` still maps every offset
   to the right 1-based page. Pinned in Task 3.

## Execution order (what can run in parallel)

```
Wave 1:  T1 foundation
Wave 2:  T2 text+values   T3 chunker   T5 db documents   T6 db coordination   T8 extractors
Wave 3:  T4 validate+merge (needs T2,T3)        T7 api routes (needs T5)
Wave 4:  T9 worker pipeline (needs T3,T4,T6,T8)
Wave 5:  T10 compose, docs, end-to-end verification
```

Tasks in one wave touch disjoint files except the barrel `index.ts` of a package, where each task
only **appends** its own `export * from './x.js'` line.

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/shared/src/status.ts` | add `VersionStatus` | T1 |
| `packages/shared/src/api.ts` | API DTO Zod schemas | T1 |
| `packages/shared/src/extraction.ts` | `ExtractionOutput`, `Candidate`, `FinalValue` types | T1 |
| `packages/shared/src/node.ts` | `loadExpectedFields()` (Node-only subpath `@lomi/shared/node`) | T1 |
| `packages/files/src/index.ts` | `FileStore`, `LocalFileStore` | T1 |
| `packages/db/src/testing.ts` | test DB harness (`@lomi/db/testing`) | T1 |
| `packages/queue/src/index.ts` | job id with attempts, `enqueueExtraction`, `attempts: 1` | T1 |
| `Dockerfile` | copy `fixtures/` into node images | T1 |
| `packages/extraction/src/text.ts` | match normalization with offset map, `findQuote` | T2 |
| `packages/extraction/src/values.ts` | `normalizeValue`, `valueInQuote` | T2 |
| `packages/extraction/src/pages.ts` | `joinPages`, `pageOf` | T3 |
| `packages/extraction/src/chunker.ts` | `TokenCounter`, `planChunks`, `assertTiling` | T3 |
| `packages/extraction/src/prompt.ts` | `PROMPT_VERSION`, `buildPrompt` | T4 |
| `packages/extraction/src/validate.ts` | `validateChunkOutput` | T4 |
| `packages/extraction/src/merge.ts` | `mergeCandidates` | T4 |
| `packages/db/src/documents.ts` | create/dedupe, detail read, retry | T5 |
| `packages/db/src/coordination.ts` | claim, lease, chunk state, finish, fail, handoff, reconcile scan | T6 |
| `apps/api/src/errors.ts`, `apps/api/src/routes/documents.ts` | routes + error format | T7 |
| `apps/worker/src/limit.ts` | `createLimiter` | T8 |
| `apps/worker/src/extractors/*.ts` | `Extractor`, Claude, Fake, missing-key, factory | T8 |
| `apps/worker/src/pdf.ts` | `parsePdf` | T9 |
| `apps/worker/src/pipeline.ts` | `processVersion` | T9 |
| `apps/worker/src/reconciler.ts` | `startReconciler` | T9 |
| `apps/worker/src/index.ts` | wiring, SIGTERM handoff | T9 |
| `docs/decisions/*.md`, `README.md`, `docker-compose.yml`, `.env.example` | docs + config | T10 |

---

### Task 1: Foundation — shared contracts, FileStore, test DB harness, queue tweaks

**Files:**
- Modify: `packages/shared/src/status.ts`, `packages/shared/src/index.ts`, `packages/shared/package.json` (add `"./node"` export)
- Create: `packages/shared/src/api.ts`, `packages/shared/src/extraction.ts`, `packages/shared/src/node.ts`, `packages/shared/src/node.test.ts`
- Create: `packages/files/{package.json,tsconfig.json,tsconfig.build.json,eslint.config.js}` (copy `packages/logger`'s), `packages/files/src/index.ts`, `packages/files/src/index.test.ts`
- Create: `packages/db/src/testing.ts`, `packages/db/vitest.integration.config.ts`, `packages/db/src/harness.int.test.ts`; modify `packages/db/package.json` (export `"./testing"`, script `test:integration`), `turbo.json` (task `test:integration`: `dependsOn: ["^build"]`, `cache: false`, `env: ["TEST_DATABASE_URL"]`), root `package.json` (`"test:integration": "turbo run test:integration"`)
- Modify: `packages/queue/src/index.ts`, `Dockerfile` (node-app stage: `COPY fixtures ./fixtures`)
- Modify: unit `test` scripts in db/api/worker to exclude `**/*.int.test.ts` (`vitest run --exclude "**/*.int.test.ts" --passWithNoTests`)

**Interfaces — Produces:**
```ts
// @lomi/shared
export const VersionStatus: z.ZodEnum<['queued','extracting','extracted','failed','superseded']>;
export const ExtractionOutput = z.object({ fields: z.array(z.object({
  field: z.string(), value: z.string().nullable(),
  evidence: z.string().nullable(), gap_reason: z.string().nullable() })) });
export type Candidate =
  | { field: string; kind: 'value'; value: string; evidence: string; start: number; end: number } // offsets into version parsedText
  | { field: string; kind: 'gap'; reason: string };
export interface FinalValue {
  field: string; value: string | null; evidence: string | null; gapReason: string | null;
  candidates: { value: string; page: number }[] | null;
  evidencePage: number | null; evidenceStart: number | null; evidenceEnd: number | null;
}
export const UploadFields = z.object({ type: DocumentType, title: z.string().trim().min(1).max(200).optional() });
export const ApiError = z.object({ error: z.enum(['bad_request','not_found','conflict','payload_too_large','internal']), message: z.string() });
export const ReviewDto, ValueDto, VersionDto, DocumentDetailDto, DocumentSummaryDto; // fields exactly as in the spec's API section:
//  ValueDto: id, field, fieldType, value, evidence, gapReason, candidates, evidencePage, evidenceStart, evidenceEnd, reviewState, latestReview
//  VersionDto: id, versionNo, status, error, parsedText, pageOffsets, createdAt (ISO string)
//  DocumentDetailDto: id, title, type, status (DocumentStatus of the shown version), version: VersionDto, values: ValueDto[]
//  DocumentSummaryDto: id, title, type, versionNo, status
// @lomi/shared/node
export function loadExpectedFields(dir?: string /* default process.env.FIXTURES_DIR ?? 'fixtures' resolved from cwd */): ExpectedFields;
// @lomi/files
export interface FileStore { put(bytes: Uint8Array): Promise<{ key: string; sha256: string }>; read(key: string): Promise<Uint8Array>; stream(key: string): NodeJS.ReadableStream; }
export class LocalFileStore implements FileStore { constructor(dir: string) }
// @lomi/db/testing
export const TEST_DATABASE_URL: string; // process.env.TEST_DATABASE_URL ?? 'postgres://lomi:lomi@localhost:5432/lomi_test'
export function prepareTestDatabase(): Promise<void>; // CREATE DATABASE if missing, then `prisma migrate deploy` against it
export function truncateAll(db: Db): Promise<void>;   // TRUNCATE every app table ... RESTART IDENTITY CASCADE
// @lomi/queue
export const extractionJobId: (versionId: string, attempts: number) => string; // `extract-${versionId}-${attempts}`
export function enqueueExtraction(queue: Queue<ExtractionJob>, versionId: string, attempts: number): Promise<void>; // add with jobId; never throws (logs nothing, returns) — callers rely on the reconciler
```

- [ ] **Step 1: Write failing tests**
  - `packages/shared/src/node.test.ts`: `loadExpectedFields(path to repo fixtures)` returns 5 invoice fields with `total_amount` type `money`; throws a message containing the path when the dir has no `expected-fields.json`.
  - `packages/files/src/index.test.ts` (tmp dir via `fs.mkdtemp`): `put(bytes)` returns `key === sha256 + '.pdf'` and sha256 of the bytes; `put` twice same bytes → same key, no error; `read(key)` round-trips; `read('missing.pdf')` rejects.
  - `packages/db/src/harness.int.test.ts`: after `prepareTestDatabase()`, a `createDb(TEST_DATABASE_URL)` client can insert a `Document` and `truncateAll` leaves `document.count() === 0`.
- [ ] **Step 2: Run them, expect FAIL** — `pnpm --filter @lomi/shared test`, `pnpm --filter @lomi/files test` (module not found).
- [ ] **Step 3: Implement shared contracts + `loadExpectedFields`** (parse with `ExpectedFields`). Commit: `feat(shared): api DTOs, extraction types, expected-fields loader`.
- [ ] **Step 4: Implement `LocalFileStore`** — write to `<dir>/.<key>.tmp` then `rename` (atomic); skip write if the key exists. Commit: `feat(files): content-addressed local FileStore`.
- [ ] **Step 5: Implement the test DB harness** — `prepareTestDatabase` connects to the `postgres` maintenance DB to create `lomi_test` if absent, then spawns the Prisma CLI (`createRequire(import.meta.url).resolve('prisma/build/index.js')`) with `migrate deploy` and `DATABASE_URL=TEST_DATABASE_URL`. `vitest.integration.config.ts`: `include: ['src/**/*.int.test.ts']`, `globalSetup` calling `prepareTestDatabase`, `fileParallelism: false`. Commit: `test(db): integration test harness on lomi_test`.
- [ ] **Step 6: Queue + Docker** — job options `attempts: 1` (drop backoff), new `extractionJobId`, `enqueueExtraction` (catches and swallows add errors). Dockerfile copies `fixtures` into `node-app`. Commit: `chore: fixtures in node images, queue job ids carry attempts`.
- [ ] **Step 7: Verify all** — `pnpm -r run build && pnpm -r run typecheck && pnpm -r run lint && pnpm -r run test` all green; `docker compose up -d postgres && pnpm --filter @lomi/db test:integration` green.

**You verify:** `pnpm --filter @lomi/files test` and `pnpm --filter @lomi/db test:integration` pass;
`docker compose build worker && docker compose run --rm worker ls /app/fixtures` lists `expected-fields.json`.

---

### Task 2: Text matching and value comparison (pure)

**Files:**
- Create: `packages/extraction/src/text.ts`, `text.test.ts`, `values.ts`, `values.test.ts`
- Modify: `packages/extraction/src/index.ts` (replace the skeleton `normalizeText`/`evidenceAppearsIn` and its test with `export * from './text.js'; export * from './values.js';`)

**Interfaces — Consumes:** `FieldType` from `@lomi/shared`. **Produces:**
```ts
export function normalizeForMatch(text: string): { text: string; map: number[] };
// NFKC; ‘’‚‛ → ', “”„‟ → ", ‐‑‒–—― → -, NBSP and every whitespace run → one space; trimmed.
// map[i] = index in the ORIGINAL string of normalized char i; map[text.length] = original end.
export function findQuote(quote: string, haystack: string): { start: number; end: number } | null;
// first occurrence; offsets into the original haystack; null for empty/whitespace quote.
export function normalizeValue(value: string, type: FieldType): string | null;
// money/number/percent → canonical decimal ('$5,230.29'→'5230.29', '1,985.00'→'1985', '4.2%'→'4.2');
// date → 'YYYY-MM-DD' from ISO, 'March 1, 2025', '1 March 2025', 'Mar 1, 2025'; string → normalizeForMatch(...).text lower-cased.
// null when unparseable.
export function valueInQuote(value: string, quote: string, type: FieldType): boolean;
// numeric types: normalizeValue(value) equals the normalized value of some number token in the quote;
// date: equals some date parsed from the quote; string: case-insensitive substring after normalizeForMatch.
```

- [ ] **Step 1: Write failing tests** (`text.test.ts`)
  - `findQuote('Total Due: $5,230.29', 'Subtotal…\nTotal Due:   $5,230.29\n')` → offsets whose slice of the original is `'Total Due:   $5,230.29'`.
  - curly vs straight: quote `"Harborview Residential LP (\"Landlord\")"` matches text with `“Landlord”`.
  - quote spanning a line break: `'twenty-four (24) months'` matches `'twenty-four (24)\nmonths'`.
  - hallucinated quote `'Total Due: $5,300.00'` → `null`; `'   '` → `null`.
  - duplicate occurrence → the first one's offsets.
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @lomi/extraction test`.
- [ ] **Step 3: Implement `text.ts`.** Run tests → PASS. Commit: `feat(extraction): verbatim quote matching with offset map`.
- [ ] **Step 4: Write failing tests** (`values.test.ts`), table-driven:
  - `normalizeValue`: `('$5,230.29','money')→'5230.29'`, `('1985','money')` and `('$1,985.00','money')` → `'1985'`, `('4.2%','percent')→'4.2'`, `('24','number')→'24'`, `('March 1, 2025','date')→'2025-03-01'`, `('2025-09-14','date')→'2025-09-14'`, `('abc','money')→null`.
  - `valueInQuote`: `('5230.29','Total Due: $5,230.29','money')→true`; `('5230.30', same)→false`; `('4.2','vacancy rate declined to 4.2%, down from 4.9%','percent')→true`; `('24','twenty-four (24)\nmonths','number')→true`; `('2025-03-01','commencing on March 1, 2025','date')→true`; `('Dana Okafor','and Dana Okafor ("Tenant")','string')→true`; `('Meridian Office Supplies LLC','MERIDIAN OFFICE SUPPLIES LLC','string')→true`; `('INV-2025-0848','Invoice Number: INV-2025-0847','string')→false`.
- [ ] **Step 5: Implement `values.ts`.** Run → PASS. Commit: `feat(extraction): per-type value normalization and value-in-quote check`.

**You verify:** `pnpm --filter @lomi/extraction test` → all green.

---

### Task 3: Pages and chunk planner (pure)

**Files:**
- Create: `packages/extraction/src/pages.ts`, `pages.test.ts`, `chunker.ts`, `chunker.test.ts`
- Modify: `packages/extraction/src/index.ts` (append two exports)

**Interfaces — Produces:**
```ts
export const PAGE_SEPARATOR = '\n\n';
export function joinPages(pages: string[]): { text: string; pageOffsets: number[] }; // pageOffsets[i] = start of page i+1
export function pageOf(offset: number, pageOffsets: number[]): number; // 1-based; last page whose start <= offset
export interface TokenCounter { count(text: string): Promise<number>; }
export const CHUNK_DEFAULTS = { targetTokens: 6000, maxTokens: 8000, overlapTokens: 200, maxChunks: 50 } as const;
export interface PlannedChunk { index: number; start: number; end: number; tokens: number; firstPage: number; lastPage: number; }
// chunk text = text.slice(start, end); start may reach back into the previous chunk (overlap).
export interface ChunkPlan { chunks: PlannedChunk[]; totalTokens: number; charsPerToken: number; }
export class DocumentTooLongError extends Error { constructor(public chunkCount: number) } // message `Document too long (${n} chunks; limit 50)`
export function planChunks(text: string, pageOffsets: number[], counter: TokenCounter, opts?: Partial<typeof CHUNK_DEFAULTS>): Promise<ChunkPlan>;
export function assertTiling(chunks: PlannedChunk[], length: number): void; // throws on violation
```

Algorithm (the part the signature doesn't decide):
1. `totalTokens = await counter.count(text)`. If `<= targetTokens` → one chunk `[0, length)`.
2. Else `charsPerToken = length / totalTokens`; `budgetChars = targetTokens * charsPerToken`.
3. Split into boundary candidates with a strength: page start (from `pageOffsets`) 5, heading-like
   line start 4 (line ≤ 80 chars, no final `.,;:`, and ALL CAPS or `^\d+[.)]` or followed by a
   blank line), blank line 3, line break 2, sentence end (`[.!?]\s`) 1, whitespace 0.
4. Greedy: from the current core start, choose the end as the **strongest** boundary in
   `(coreStart, coreStart + budgetChars]`, latest among equals; if none, the strongest boundary
   after it (a single oversized unit). Never cut inside a word.
5. Overlap: a chunk's `start` = the start of the previous chunk's last paragraph (blank-line
   boundary) if that paragraph is ≤ `overlapTokens * charsPerToken` chars, else the core start.
6. Count each chunk with `counter.count`; if `> maxTokens`, re-split that core at the next-weaker
   strength (same procedure, half the budget) and recount. Then if `chunks.length > maxChunks`
   throw `DocumentTooLongError`. Then `assertTiling`.

Tiling invariant: `chunks[0].start === 0`, `ends` strictly increasing, last `end === length`,
`chunks[i].start <= chunks[i-1].end` and `chunks[i].start >= chunks[i-1].start`.

- [ ] **Step 1: Failing tests** `pages.test.ts`: `joinPages(['a','bb'])` → `{ text: 'a\n\nbb', pageOffsets: [0, 3] }`; `pageOf(4,[0,3])===2`; **empty page** `joinPages(['a','','c'])` → `pageOf` of `'c'`'s offset is `3`, never `2`.
- [ ] **Step 2: Implement `pages.ts`**, tests PASS. Commit: `feat(extraction): page join and page lookup`.
- [ ] **Step 3: Failing tests** `chunker.test.ts` with `const fake: TokenCounter = { count: async t => Math.ceil(t.length / 4) }`:
  - short text → exactly 1 chunk `{start:0,end:length,tokens:…,firstPage:1}`; counter called once.
  - 3 pages of ~10k chars each, `targetTokens: 1000` → every chunk boundary (core end) is a page start or blank line when one exists in budget; `assertTiling` passes.
  - random text (seeded generator of words/lines/paragraphs, 200 runs) → tiling holds and `chunks.map(c=>text.slice(c.start,c.end)).join` covers every character of `text` at least once.
  - one 40k-char paragraph without blank lines, `targetTokens: 1000, maxTokens: 1500` → falls back to sentence/line boundaries, every chunk `tokens <= 1500`.
  - overlap: chunk 2 `start` < chunk 1 `end` and overlap length ≤ `200*4` chars.
  - determinism: same input twice → deep-equal plans.
  - cap: `maxChunks: 2` on a 3-chunk input → rejects with `DocumentTooLongError` message `Document too long (3 chunks; limit 2)`.
  - `assertTiling` throws on a gap (`[{0,10},{12,20}]`).
- [ ] **Step 4: Implement `chunker.ts`**, tests PASS. Commit: `feat(extraction): token-counted chunk planner with tiling guarantee`.

**You verify:** `pnpm --filter @lomi/extraction test` → green; open `chunker.test.ts` and confirm the tiling and cap cases exist.

---

### Task 4: Prompt, per-chunk validation, merge (pure)

**Files:**
- Create: `packages/extraction/src/prompt.ts`, `validate.ts`, `validate.test.ts`, `merge.ts`, `merge.test.ts`, `fixtures.test.ts`
- Modify: `packages/extraction/src/index.ts` (append exports)
- Dev dep for `fixtures.test.ts` only: `unpdf` in `@lomi/extraction` devDependencies (test-time I/O is fine; source stays pure)

**Interfaces — Consumes:** T1 `ExtractionOutput`, `Candidate`, `FinalValue`, `FieldDef`, `DocumentType`; T2 `findQuote`, `normalizeValue`, `valueInQuote`; T3 `pageOf`, `joinPages`. **Produces:**
```ts
export const PROMPT_VERSION = 'v1';
export function buildPrompt(type: DocumentType, fields: FieldDef[], chunkText: string, ctx: { chunkIndex: number; chunkCount: number }): { system: string; user: string };
export function validateChunkOutput(output: unknown, fields: FieldDef[], chunk: { text: string; start: number }): Candidate[]; // one per field, in `fields` order
export function mergeCandidates(fields: FieldDef[], perChunk: Candidate[][], pageOffsets: number[]): FinalValue[]; // one per field, in `fields` order
```

Prompt rules the system text must state: extract only the listed fields; for each, `value` exactly
as written, `evidence` = the **shortest verbatim passage** from the text that contains the value
(e.g. `Issue Date: 2025-09-14`, not that line plus the next); if the field is absent, `value` and
`evidence` null and a short `gap_reason`; never guess or compute; the text may be one part of a
longer document (`part i of n`). The user text holds the field list (`name (type)`) and the chunk
between clear delimiters.

Validation order per field: not in output (or output fails `ExtractionOutput.safeParse`) → gap
`not returned by model`; value null → gap with `gap_reason` (fallback `not returned by model`);
`findQuote(evidence, chunk.text)` null → `evidence not found in document text`;
`!valueInQuote` → `value not found in its quote`; else value with `start/end = chunk.start + match`.
Unknown fields ignored; duplicate field → first wins; value trimmed.

Merge per field: no value candidates → gap, reason = first chunk's gap reason that isn't
`not returned by model`, else `not found in document`; all value candidates share one
`normalizeValue` → value from the earliest chunk (its evidence, offsets, `pageOf(start)`);
otherwise gap `conflicting values found: ` + distinct values joined `, ` as `V (p.N)` in chunk
order, with `candidates` set.

- [ ] **Step 1: Failing tests** `validate.test.ts` (chunk = invoice v1 text literal from the spec's fixture cross-check):
  - correct output for all 5 invoice fields → 5 value candidates; `total_amount` offsets slice to `Total Due: $5,230.29`.
  - hallucinated evidence → gap `evidence not found in document text`.
  - real quote, wrong number (`5230.30` with `Total Due: $5,230.29`) → gap `value not found in its quote`.
  - `value: null, gap_reason: 'not present'` → gap `not present`.
  - output missing `due_date`, plus an unknown field `foo`, plus `invoice_number` twice → `due_date` gap `not returned by model`, no `foo`, first `invoice_number` kept.
  - output `null` / malformed → all gaps `not returned by model`.
  - **quote occurring twice in the chunk** → first occurrence offsets; with `chunk.start = 1000`, offsets are shifted by 1000.
  - `buildPrompt` user text contains every field name and the chunk text; system text contains `shortest verbatim passage`.
- [ ] **Step 2: Implement `prompt.ts` + `validate.ts`**, PASS. Commit: `feat(extraction): prompt builder and strict per-chunk validation`.
- [ ] **Step 3: Failing tests** `merge.test.ts`: none → `not found in document`; same value from chunks 0 and 1 (`'$1,985'` and `'1985.00'`) → one value from chunk 0 with `evidencePage` from `pageOf`; conflicting `4.2%` (chunk 0, page 1) vs `4.9%` (chunk 1, page 2) → gap `conflicting values found: 4.2% (p.1), 4.9% (p.2)` and `candidates` `[{value:'4.2%',page:1},{value:'4.9%',page:2}]`; output order equals `fields` order.
- [ ] **Step 4: Implement `merge.ts`**, PASS. Commit: `feat(extraction): deterministic per-field merge across chunks`.
- [ ] **Step 5: Fixture test** `fixtures.test.ts`: parse all four fixture PDFs with unpdf (`extractText(pdf,{mergePages:false})` → `joinPages`) and assert each one-page text contains `Total Due: $5,230.29` / `Total Due: $6,126.45` / `$2,350.00` / `4.2%` respectively, and that a hand-written correct output for invoice v1 validates to 5 values. Commit: `test(extraction): validate against real fixture text`.

**You verify:** `pnpm --filter @lomi/extraction test` → green, including `fixtures.test.ts`.

---

### Task 5: DB — document creation, detail read, retry

**Files:**
- Create: `packages/db/src/documents.ts`, `packages/db/src/documents.int.test.ts`
- Modify: `packages/db/src/index.ts` (append export), `packages/db/src/seed.ts` (use `createDocumentWithV1`)

**Interfaces — Consumes:** T1 DTOs, `ExpectedFields`, harness. **Produces:**
```ts
export function createDocumentWithV1(db: Db, input: { type: DocumentType; title: string; fileKey: string; sha256: string }):
  Promise<{ documentId: string; versionId: string; attempts: number; created: boolean }>;
// one transaction; first statement `SELECT pg_advisory_xact_lock(hashtext(${type + ':' + sha256}))`;
// existing document of that type whose v1 sha256 matches → { created: false } with its ids.
export function getDocumentDetail(db: Db, documentId: string, opts: { fields: ExpectedFields; versionNo?: number }): Promise<DocumentDetailDto | null>;
// values in the type's field order; reviewState: latest own review → approved/corrected; carriedReviewId → carried_over; else pending.
// status: the shown version's status, except `superseded` is reported as its own value only in VersionDto.
export function retryCurrentVersion(db: Db, documentId: string):
  Promise<{ kind: 'retried'; versionId: string; attempts: 0 } | { kind: 'not_found' } | { kind: 'not_failed'; status: string }>;
// guarded updateMany failed → queued, error null, attempts 0, activeRunId null, leaseExpiresAt null.
```

- [ ] **Step 1: Failing int tests**: create → `created:true`, document `currentVersionId === versionId`, version `queued`, `versionNo 1`; same type+sha again → `created:false` same ids; same sha, different type → new document; **`Promise.all` of two identical creates → exactly 1 document row**; `getDocumentDetail` of a fresh doc → `status:'queued'`, `values: []`; with seeded values + reviews (insert via Prisma in the test) → `reviewState` approved/corrected/pending correct and values in field order; unknown id → `null`; `?versionNo=2` absent → `null`; retry on `queued` → `not_failed`; on `failed` → `retried` and row shows `queued, attempts 0, error null`.
- [ ] **Step 2: Run** `pnpm --filter @lomi/db test:integration` → FAIL.
- [ ] **Step 3: Implement `createDocumentWithV1` + switch seed to it.** Tests for create PASS. Commit: `feat(db): create document with v1, deduped under advisory lock`.
- [ ] **Step 4: Implement `getDocumentDetail` + `retryCurrentVersion`.** All PASS. Commit: `feat(db): document detail read model and retry`.

**You verify:** `docker compose up -d postgres && pnpm --filter @lomi/db test:integration` → green;
`docker compose run --rm migrate` twice → second run logs `v1 already present` for all three.

---

### Task 6: DB — worker coordination (claim, lease, chunks, finish, fail, handoff, reconcile)

**Files:**
- Create: `packages/db/src/coordination.ts`, `packages/db/src/coordination.int.test.ts`
- Modify: `packages/db/src/index.ts` (append export)

**Interfaces — Consumes:** T1 `FinalValue`, harness. **Produces:**
```ts
export const LEASE_MS = 30_000; export const MAX_ATTEMPTS = 3;
export interface ClaimedVersion { id: string; documentId: string; type: DocumentType; fileKey: string; parsedText: string | null; pageOffsets: number[]; attempts: number; }
export function claimVersion(db: Db, versionId: string, opts: { model: string; leaseMs?: number; now?: Date }):
  Promise<{ kind: 'claimed'; runId: string; version: ClaimedVersion } | { kind: 'skipped' } | { kind: 'capped' }>;
// eligible = status 'queued' OR (status 'extracting' AND leaseExpiresAt < now).
// eligible AND attempts < MAX_ATTEMPTS → extracting, activeRunId = new uuid, lease = now+leaseMs, attempts+1, create ExtractionRun(running).
// eligible AND attempts >= MAX_ATTEMPTS → failed, error 'extraction was interrupted 3 times', activeRunId null → 'capped'.
export function renewLease(db: Db, versionId: string, runId: string, leaseMs?: number): Promise<boolean>;
export function saveParsedText(db: Db, versionId: string, runId: string, parsed: { parsedText: string; pageOffsets: number[] }): Promise<void>; // only when parsedText is null and run is active
export function saveChunkPlan(db: Db, versionId: string, plan: { chunks: { index: number; start: number; end: number; tokens: number; firstPage: number; lastPage: number }[]; totalTokens: number; charsPerToken: number }): Promise<void>; // createMany skipDuplicates; totals set only if null
export function getChunkState(db: Db, versionId: string, promptVersion: string): Promise<{ chunks: VersionChunk[]; results: Map<number, ChunkResult> }>;
export function saveChunkResult(db: Db, row: { versionId: string; chunkIndex: number; promptVersion: string; runId: string; prompt: string; rawResponse: unknown; candidates: Candidate[] }): Promise<void>; // createMany skipDuplicates
export function finishVersion(db: Db, versionId: string, runId: string, values: FinalValue[]): Promise<'finished' | 'stale'>;
// tx: guarded updateMany (id, activeRunId=runId, status 'extracting') → extracted, lease null; count 0 → rollback, then run 'abandoned', 'stale'.
// else values createMany skipDuplicates, run 'succeeded' + finishedAt. (Carry-over is Phase 3; leave previousValueId/carriedReviewId null.)
export function failVersion(db: Db, versionId: string, runId: string, error: string): Promise<boolean>; // guarded → failed; run failed
export function handOffVersion(db: Db, versionId: string, runId: string): Promise<boolean>; // guarded → queued, attempts-1, lease/activeRunId null; run abandoned
export function findReconcilable(db: Db, now?: Date): Promise<{ id: string; attempts: number }[]>; // queued, or extracting with expired lease
```

- [ ] **Step 1: Failing int tests** (create versions with `createDocumentWithV1` or direct Prisma):
  - claim queued → `claimed`, row `extracting`, `attempts 1`, one run `running`; second claim while lease live → `skipped`.
  - claim with `now` past the lease → `claimed` with a **new** `runId`, `attempts 2`.
  - old run's `finishVersion` after re-claim → `'stale'`, zero values, old run `abandoned`; new run finishes → `'finished'`, values written.
  - **two runs both call `finishVersion` with valid ids** (simulate by re-claim) → only the active one writes; `extractedValue.count() === fields.length`.
  - `finishVersion` called twice by the active run → second is `'stale'`, still one set of values.
  - value-xor-gap: `finishVersion` with a gap `FinalValue` succeeds; DB CHECK rejects a hand-made row with both value and gap reason.
  - `attempts` already 3 and lease expired → `capped`, row `failed` with exact error.
  - `handOffVersion` → `queued`, `attempts` decremented, run `abandoned`; immediate `claimVersion` succeeds.
  - `failVersion` with a stale run → `false`, row unchanged.
  - `findReconcilable` returns queued + expired-lease extracting, not live-lease, extracted, failed or superseded.
  - `saveChunkResult` twice same key → one row; `saveChunkPlan` twice → plan unchanged.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement claim/renew/handoff/fail/findReconcilable.** Their tests PASS. Commit: `feat(db): lease-based claim, renew, fail, handoff, reconcile scan`.
- [ ] **Step 4: Implement chunk state + `finishVersion`.** All PASS. Commit: `feat(db): chunk plan/results and guarded finish transaction`.

**You verify:** `pnpm --filter @lomi/db test:integration` → green; read the test names — each anti-goal
in the spec ("never duplicate", "stale run can't write") has a test.

---

### Task 7: API — upload, read, retry

**Files:**
- Create: `apps/api/src/errors.ts`, `apps/api/src/routes/documents.ts`, `apps/api/src/documents.int.test.ts`, `apps/api/vitest.integration.config.ts` (same shape as db's)
- Modify: `apps/api/src/app.ts` (extend `Deps`, register routes + error handler), `apps/api/src/index.ts` (wire real deps), `apps/api/package.json` (deps `@lomi/files`; script `test:integration`)

**Interfaces — Consumes:** T1 (`UploadFields`, DTOs, `FileStore`, `loadExpectedFields`, `enqueueExtraction`), T5. **Produces:**
```ts
export interface Deps {
  pingDb(): Promise<void>; pingRedis(): Promise<void>; close(): Promise<void>;
  db: Db; files: FileStore; fields: ExpectedFields;
  enqueue(versionId: string, attempts: number): Promise<void>; // never throws (wraps enqueueExtraction)
}
// errors.ts
export class HttpError extends Error { constructor(public status: number, public code: ApiError['error'], message: string) }
```
Routes: `POST /documents` (multipart: read fields, validate with `UploadFields` → 400; file must
start with `%PDF-` → 400 `file is not a PDF`; multipart `fileSize` limit → 413; title defaults to
the filename without `.pdf`), `files.put` → `createDocumentWithV1` → if created, `enqueue` →
`201 DocumentSummaryDto`, else `200` with the existing one. `GET /documents/:id` (`?version=N`,
uuid param validated → 400; missing → 404) → `DocumentDetailDto`. `POST /documents/:id/retry` →
`202 DocumentSummaryDto` and `enqueue(versionId, 0)`; `not_failed` → 409; `not_found` → 404.
One `setErrorHandler`: `HttpError`/Zod → their status, everything else → 500 `internal` (logged).

- [ ] **Step 1: Failing int tests** (`buildApp` with real test DB, `LocalFileStore` on a tmp dir, `enqueue` spy, `fields` from `loadExpectedFields`), uploading `fixtures/documents/invoice-001.pdf` via `form-data` in `app.inject`:
  - upload → 201, body `{ type:'invoice', versionNo:1, status:'queued' }`, enqueue called once with the new version id and `0`, file exists under `<sha>.pdf`.
  - same upload again → 200, same `id`, enqueue not called again.
  - title omitted → title `invoice-001`.
  - `type=receipt` → 400 `{ error:'bad_request' }`; text file → 400 `file is not a PDF`; 21 MB → 413 `payload_too_large`.
  - **`enqueue` that rejects (Redis down)** → still 201 and the version is `queued` (reconciler's job).
  - `GET /documents/<id>` → 200 status `queued`, `values: []`; random uuid → 404; `not-a-uuid` → 400.
  - retry on queued → 409 `conflict`; set version `failed` in DB → retry 202 and status `queued`.
- [ ] **Step 2: Run** `pnpm --filter @lomi/api test:integration` → FAIL.
- [ ] **Step 3: Implement errors + upload route.** Upload tests PASS. Commit: `feat(api): POST /documents with dedupe and enqueue-after-commit`.
- [ ] **Step 4: Implement GET + retry; wire `index.ts`** (`LocalFileStore(env.UPLOAD_DIR)`, `loadExpectedFields()`, queue). All PASS; `pnpm --filter @lomi/api test` (unit health tests) still green. Commit: `feat(api): GET /documents/:id and POST /documents/:id/retry`.

**You verify:** with the stack up,
`curl -F type=invoice -F file=@fixtures/documents/invoice-001.pdf localhost:3000/documents` → 200
(the seed already created it) and `curl localhost:3000/documents/<id>` shows the version.

---

### Task 8: Worker — limiter and extractors

**Files:**
- Create: `apps/worker/src/limit.ts`, `limit.test.ts`, `apps/worker/src/extractors/{types.ts,claude.ts,fake.ts,missing-key.ts,index.ts,fake.test.ts,factory.test.ts}`, `apps/worker/scripts/smoke-claude.ts`
- Modify: `apps/worker/package.json` (script `"smoke:claude": "tsx --env-file-if-exists=../../.env scripts/smoke-claude.ts"`)

**Interfaces — Consumes:** T1 `ExtractionOutput`, `FieldDef`, `DocumentType`. **Produces:**
```ts
export function createLimiter(n: number): { run<T>(fn: () => Promise<T>): Promise<T>; readonly active: number; readonly maxSeen: number };
export interface ExtractRequest { type: DocumentType; fields: FieldDef[]; chunkText: string; prompt: { system: string; user: string } }
export interface Extractor {
  readonly model: string;
  countTokens(text: string): Promise<number>;
  extract(req: ExtractRequest, opts?: { signal?: AbortSignal }): Promise<{ output: unknown; raw: unknown }>;
}
export class ClaudeExtractor implements Extractor { constructor(opts: { apiKey: string; model: string; timeoutMs?: number; maxInflight?: number }) }
export class FakeExtractor implements Extractor { constructor(opts?: { delayMs?: number }) }      // model 'fake'
export class MissingKeyExtractor implements Extractor {}                                         // every call rejects 'ANTHROPIC_API_KEY is not set'
export function createExtractor(env: NodeJS.ProcessEnv): Extractor; // EXTRACTOR=fake → Fake(FAKE_EXTRACTOR_DELAY_MS); no key → MissingKey; else Claude(ANTHROPIC_MODEL ?? 'claude-sonnet-5-5')
```
`ClaudeExtractor`: one `new Anthropic({ apiKey, timeout: timeoutMs })`; both methods go through
one `createLimiter(maxInflight ?? 4)`. `countTokens` → `client.messages.countTokens({ model,
messages: [{ role: 'user', content: text }] }).input_tokens`. `extract` →
`client.messages.parse({ model, max_tokens: 4096, system, messages: [{ role:'user', content: user }],
output_config: { format: zodOutputFormat(ExtractionOutput) } }, { signal })`; if
`stop_reason` is `refusal` or `max_tokens`, or `parsed_output` is null, throw
`Error('model response unusable (stop_reason: X)')`; return `{ output: parsed_output, raw: response }`.
`FakeExtractor`: `countTokens = ceil(len/4)`; `extract` sleeps `delayMs` (abortable) and fills each
field from a regex table over `chunkText` (quote = full match, value = capture), e.g.
`invoice_number: /Invoice Number:\s*(\S+)/`, `total_amount: /Total Due:\s*(\$[\d,.]+)/`,
`monthly_rent: /monthly rent of (\$[\d,.]+)/`, `vacancy_rate: /vacancy rate declined to ([\d.]+%)/`;
fields with no rule or no match → `value: null, gap_reason: 'not found by fake extractor'`.

- [ ] **Step 1: Failing tests**: `limit.test.ts` — 10 tasks through `createLimiter(3)` → `maxSeen === 3`, all resolve, a rejection doesn't leak a slot. `fake.test.ts` — on the invoice v1 text literal, output validates (via `ExtractionOutput.parse`) and gives `total_amount` `$5,230.29` with quote `Total Due: $5,230.29`; aborting the signal during `delayMs` rejects. `factory.test.ts` — `{EXTRACTOR:'fake'}` → Fake; `{}` → MissingKey whose `extract` rejects with exactly `ANTHROPIC_API_KEY is not set`; `{ANTHROPIC_API_KEY:'x'}` → Claude with model `claude-sonnet-5-5`.
- [ ] **Step 2: Implement `limit.ts`**, PASS. Commit: `feat(worker): bounded concurrency limiter`.
- [ ] **Step 3: Implement extractors + factory**, PASS. Commit: `feat(worker): Claude structured-output extractor, fake and missing-key extractors`.
- [ ] **Step 4: Smoke script** — `smoke-claude.ts` parses `fixtures/documents/invoice-001.pdf`, prints `countTokens`, runs one `extract` with `buildPrompt` and prints the validated candidates (`validateChunkOutput`). Commit: `chore(worker): live Claude smoke script`.

**You verify:** `pnpm --filter @lomi/worker test` → green. With a key in `.env`:
`pnpm --filter @lomi/worker smoke:claude` prints 5 invoice values with quotes (costs a few cents).

---

### Task 9: Worker — pipeline, reconciler, SIGTERM handoff

**Files:**
- Create: `apps/worker/src/pdf.ts`, `pipeline.ts`, `reconciler.ts`, `apps/worker/src/pipeline.int.test.ts`, `apps/worker/vitest.integration.config.ts`
- Modify: `apps/worker/src/index.ts`, `apps/worker/package.json` (deps `@lomi/files`; devDep `pdf-lib` for a blank-PDF test fixture; script `test:integration`)

**Interfaces — Consumes:** T3 `planChunks`, `joinPages`, `DocumentTooLongError`; T4 `buildPrompt`, `validateChunkOutput`, `mergeCandidates`, `PROMPT_VERSION`; T6 all; T8 `Extractor`, `createLimiter`; T1 `FileStore`, `enqueueExtraction`. **Produces:**
```ts
export function parsePdf(bytes: Uint8Array): Promise<{ text: string; pageOffsets: number[] }>; // unpdf per page → joinPages
export interface PipelineDeps {
  db: Db; files: FileStore; extractor: Extractor; fields: ExpectedFields; log: Logger;
  leaseMs?: number; renewMs?: number; chunkConcurrency?: number; chunkOptions?: Partial<typeof CHUNK_DEFAULTS>;
  signal?: AbortSignal; // aborted on SIGTERM
}
export type ProcessResult = 'finished' | 'stale' | 'skipped' | 'capped' | 'failed' | 'handed_off';
export function processVersion(deps: PipelineDeps, versionId: string): Promise<ProcessResult>;
export function startReconciler(deps: { db: Db; enqueue(versionId: string, attempts: number): Promise<void>; log: Logger; intervalMs?: number }): { stop(): void; runOnce(): Promise<number> };
```
`processVersion` order: `claimVersion` (skipped/capped → return) → start renew timer every
`renewMs` (renew returning `false` aborts this run as stale) → parsed text from the row, else
`parsePdf(files.read(fileKey))`, scanned check, `saveParsedText` → chunk state; if no plan,
`planChunks` with `{ count: extractor.countTokens }` + `saveChunkPlan` → for each chunk without a
result, through `createLimiter(chunkConcurrency ?? 3)`: `buildPrompt` → `extractor.extract(…,{signal})`
→ `validateChunkOutput` → `saveChunkResult` → `mergeCandidates` over all results in chunk order →
`finishVersion`. Any thrown error → `failVersion(error.message)` → `'failed'`. If `signal`
aborted at any await → `handOffVersion` → `'handed_off'`. Always clear the renew timer. Every
step logs through `log.child({ versionId, runId })` at `info` (claimed, parsed N pages, planned
N chunks, chunk i done, finished/failed/handed off).

`index.ts`: `Worker(EXTRACTION_QUEUE, job => processVersion(deps, job.data.versionId), { concurrency: 2 })`;
`startReconciler` at startup (`runOnce` immediately) and every 10 s; on SIGTERM/SIGINT: abort the
controller, `reconciler.stop()`, `await worker.close()` (in-flight jobs hand off), quit redis,
disconnect prisma, exit 0.

- [ ] **Step 1: Failing int tests** (test DB, tmp `LocalFileStore` holding the fixture PDFs, `FakeExtractor`, versions created with `createDocumentWithV1`):
  - invoice v1 → `'finished'`, version `extracted`, 5 values, `total_amount` `$5,230.29` `evidencePage 1`; market report → `median_household_income` is a gap.
  - `Promise.all` of two `processVersion` on the same version → one `'finished'`, one `'skipped'`; value count 5.
  - blank PDF (pdf-lib, one empty page) → `'failed'`, error `No text layer found (scanned PDF?); OCR is not supported`.
  - `MissingKeyExtractor` → `'failed'`, error `ANTHROPIC_API_KEY is not set`; `retryCurrentVersion` then `processVersion` with Fake → `'finished'`.
  - resume: `chunkOptions: { targetTokens: 60, maxTokens: 120 }` (several chunks), extractor that throws on chunk index 1 → `'failed'`, chunk 0 result stored; retry with a counting Fake → `'finished'` and chunk 0 **not** re-extracted.
  - concurrency: 8 chunks, Fake with `delayMs: 50` that records in-flight → max in-flight `<= 3`.
  - handoff: Fake `delayMs: 2000`, abort the signal after 100 ms → `'handed_off'`, version `queued`, attempts back to 0, no values.
  - stale: claim with a short `leaseMs`, a second worker re-claims after expiry, the first finishes → `'stale'`, value count from the second only.
  - `DocumentTooLongError` (`chunkOptions.maxChunks: 1` on a multi-chunk plan) → `'failed'` with `Document too long (N chunks; limit 1)`.
  - reconciler: `runOnce` enqueues queued + expired-lease versions with their attempts; FLUSHALL-equivalent (empty queue spy) still gets them.
- [ ] **Step 2: Run** `pnpm --filter @lomi/worker test:integration` → FAIL.
- [ ] **Step 3: Implement `pdf.ts` + `pipeline.ts`** (finish/fail/scanned/resume/concurrency tests PASS). Commit: `feat(worker): extraction pipeline with resume and bounded chunk concurrency`.
- [ ] **Step 4: Handoff + lease renewal + stale** tests PASS. Commit: `feat(worker): lease renewal and graceful SIGTERM handoff`.
- [ ] **Step 5: `reconciler.ts` + `index.ts` wiring**, all PASS, `pnpm -r run build typecheck lint test` green. Commit: `feat(worker): reconciler and job wiring`.

**You verify:** `pnpm --filter @lomi/worker test:integration` → green. Then
`docker compose up -d --build` and `docker compose logs -f worker`: the three seeded versions go
claimed → finished (with a key) or failed `ANTHROPIC_API_KEY is not set` (without).

---

### Task 10: Compose config, decision notes, end-to-end verification

**Files:**
- Modify: `docker-compose.yml` (worker env: `EXTRACTOR`, `FAKE_EXTRACTOR_DELAY_MS`, `ANTHROPIC_MODEL`, `CHUNK_CONCURRENCY`, `LLM_MAX_INFLIGHT`; `stop_grace_period: 15s` on worker), `.env.example` (same keys, documented), `README.md` (Phase 1 status, how to run with/without a key, how to verify)
- Create: `docs/decisions/0001-postgres-source-of-truth.md`, `0002-lease-claim-and-reconciler.md`, `0003-strict-evidence-check.md`, `0004-chunking-and-token-counting.md`, `0005-structured-outputs-and-model.md`, `0006-prisma.md` (each: Context, Decision, Alternatives, Consequences — ≤ 30 lines, taken from the spec), `scripts/verify-phase1.sh`

**Interfaces — Consumes:** everything above.

`scripts/verify-phase1.sh` (bash, uses `curl` + `docker compose exec postgres psql`), run with
`EXTRACTOR=fake FAKE_EXTRACTOR_DELAY_MS=15000`:
1. wait for `/health` 200; all three seeded docs reach `extracted` within 60 s.
2. upload `invoice-001.v2.pdf` as a **new** document type `invoice` → 201; while it is
   `extracting`, `docker compose restart worker` → it ends `extracted` within 60 s.
3. upload `invoice-001.v2.pdf` again (double upload) → `200` with the same id, and the database
   still has one document for it.
4. while a fresh upload is `extracting`, `docker compose exec redis redis-cli FLUSHALL` +
   `docker compose restart worker api` → it ends `extracted`.
5. `docker compose kill -s SIGKILL worker` mid-extraction, `docker compose up -d worker` → ends
   `extracted` within ~45 s (lease expiry).
6. for every version: `select version_id, count(*) from extracted_values group by 1 having count(*) <> <field count>` returns no rows (no duplicates).
Prints `PASS`/`FAIL` per check; exits non-zero on any failure.

- [ ] **Step 1: Compose + env.** `docker compose up -d --build` healthy. Commit: `chore: worker extraction settings in compose and env example`.
- [ ] **Step 2: Decision notes + README.** Commit: `docs: phase 1 decision notes and README run/verify`.
- [ ] **Step 3: Verification script**; run it, all PASS. Commit: `test: phase 1 end-to-end verification script`.
- [ ] **Step 4: Live check with a real key** (`EXTRACTOR` unset): the three fixtures extract; invoice values match the spec's fixture cross-check; market report `median_household_income` is a gap. Record the result in the README's verification section. Commit: `docs: record live extraction check`.

**You verify:**
```bash
EXTRACTOR=fake FAKE_EXTRACTOR_DELAY_MS=15000 docker compose up -d --build
bash scripts/verify-phase1.sh          # every line PASS
curl localhost:3000/documents/<id>     # values with evidence + evidencePage
```

---

## Self-review notes

- Spec coverage (Phase 1): Prisma (done earlier), FileStore (T1), ingest + GET + retry (T5, T7),
  per-page parse + scanned check (T9), chunking + cap + bounded concurrency (T3, T8, T9),
  structured outputs + Sonnet default (T8), strict validation + offsets/page (T2, T4), merge (T4),
  claim/lease/finish/failure/attempt cap/handoff/reconciler (T6, T9), failure states visible (T6,
  T9, T7), tests (each task), decisions (T10). Deferred by the spec to later phases: list route,
  review/progress routes, file route, UI (Phase 2); version upload, supersede, carry-over
  (Phase 3); chaos script polish (Phase 4 — T10 ships a first version).
- Types shared across tasks are defined once in T1 (`Candidate`, `FinalValue`,
  `ExtractionOutput`, DTOs) so parallel tasks agree.
