# Phase 2 — Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reviewer opens the app, sees every document with its status and review progress,
opens one, and approves or corrects every value (gaps included) next to its quoted evidence, with
the PDF page and the highlighted quote in the parsed text one click away.

**Architecture:** The review-state rule and progress counting become pure functions in
`@lomi/shared`, used by the `@lomi/db` read model and the new list/progress queries. Reviews are
appended by one guarded transaction in `@lomi/db`. It locks the document row `FOR SHARE`, so a
Phase 3 supersede (`FOR UPDATE`) can't run alongside it. The api adds four routes. The web app
uses TanStack Query against them, polls only while something is `queued`/`extracting`, and shows
the PDF with `react-pdf` and the quote in a parsed-text panel.

**Tech Stack:** pnpm monorepo, TypeScript ESM, Fastify 5, Prisma 7.10.1, Zod 4, Vitest,
Vite 8 + React 19 + TanStack Query 5 + react-router 8, **Mantine 9.8.2** (`@mantine/core` +
`@mantine/hooks`, the UI component library: the owner asked for one), and `react-pdf` 11.1.0
(with `pdfjs-dist` 6.5.438, the exact version it depends on).

**Spec:** `docs/superpowers/specs/2026-11-26-extraction-review-design.md`. Read the sections
API, UI, Routes (summary), Data model and "Calls made after the builder check" first. This plan
implements the spec's Phase 2.

## Global Constraints

- The api never calls the LLM and never parses PDFs (`@lomi/extraction` is pure and may be
  imported for normalizers).
- Derived review state per value: latest own review → `approved`/`corrected`; else
  `carried_review_id` set → `carried_over`; else `pending`.
- Progress counts every value once by review state (`pending/approved/corrected/carried_over`,
  summing to `total`); `gaps` is an extra informational count of gap values, overlapping the
  others. The list shows "N need review" = pending.
- Gaps are reviewable: approve on a gap = "confirmed absent from the document"; correct on a gap
  supplies the missing value.
- `POST /values/:id/review`: `{ action: 'approve' }` or `{ action: 'correct', value, note? }`.
  Only values of the current, `extracted` version are reviewable (`409` otherwise). Appends a row;
  values and reviews are never updated or deleted.
- Errors are JSON `{ error, message }`, `error` ∈ `bad_request | not_found | conflict |
  payload_too_large | internal`; Zod validates every input, with the schemas in `@lomi/shared`.
- The UI polls every `2000` ms, only while something shown is `queued` or `extracting`.
- No highlight on the rendered PDF (spec non-goal): the PDF tab jumps to the page, and the Text
  tab highlights the quote via `evidenceStart`/`evidenceEnd`.
- Out of scope here, because they are Phase 3: `POST /documents/:id/versions`,
  `GET /documents/:id/versions`, the version switcher, "was X in v1", and carry-over in finish.
- Turbo is blocked on this machine: use `pnpm -r run build|lint|typecheck|test` or
  `pnpm --filter <pkg> <script>`. Integration suites (`test:integration`) need Postgres (the
  native PG 19 on 5432 via `.env`) and must run **one package at a time** (they share `lomi_test`).
- Every task adds doc comments on new exports plus "why" comments, and updates the README
  section it touches (user rule: comment and document every task).
- UI is built from **Mantine** components (`@mantine/core` 9.8.2), not hand-styled HTML: `Table`,
  `Badge` (status pills and review-state badges), `Button`, `Select`, `TextInput`, `FileInput`,
  `Textarea`, `Card`, `Tabs`, `Alert` (errors), `Loader`, `Group`/`Stack`/`Grid` (layout),
  `Blockquote` (evidence), `Mark` (highlight). No other UI library and no Tailwind. Styling beyond
  Mantine props stays minimal (visual polish is a spec non-goal).
- Commit after each sub-deliverable with conventional prefixes and the repo's `Co-Authored-By`
  trailer. Never push.

## Review Focus

1. **Double-click Approve** → two review rows; the value still counts once in progress
   (`approved: 1`, `total` unchanged). Pinned in Task 2.
2. **Reviewing a value that isn't on the current `extracted` version** (an old version's value,
   or the version was re-queued by Retry) → `409 conflict`, no row written. Pinned in Task 2.
3. **A correction that isn't a valid value of the field's type** (`abc` for money, `2025-02-30`
   for a date, blank) → `400 bad_request` naming the type, no row written. Pinned in Tasks 2 and 3.
4. **The version's PDF missing from `UPLOAD_DIR`** → `404 not_found` JSON, not a 500 or a hung
   stream. Pinned in Task 3.
5. **Evidence offsets null (a gap) or past the end of the text** → the Text tab renders the plain
   text without throwing; polling stops once nothing is busy. Pinned in Task 4
   (`highlightSegments`, `pollInterval`).

## Execution order

```
T1 shared rules + DTOs → T2 db reviews/list/progress → T3 api routes
→ T4 web client + list → T5 web detail + review → T6 evidence panel → T7 compose, docs, browser check
```

Strictly sequential: each task consumes the previous one's interfaces.

## File map

| File                                             | Task | Responsibility                                       |
| ------------------------------------------------ | ---- | ---------------------------------------------------- |
| `packages/shared/src/review.ts` (+ test)         | 1    | `deriveReviewState`, `computeProgress`               |
| `packages/shared/src/api.ts`                     | 1    | `ProgressDto`, `ReviewInput`, list/review DTOs       |
| `packages/db/src/reviews.ts` (+ int test)        | 2    | `reviewValue`, `listDocuments`, `getProgress`        |
| `packages/db/src/documents.ts`                   | 1, 2 | uses `deriveReviewState`; detail gains `progress`    |
| `apps/api/src/routes/reviews.ts`                 | 3    | `POST /values/:id/review`                            |
| `apps/api/src/routes/documents.ts`               | 3    | `GET /documents`, `GET /documents/:id/progress`      |
| `apps/api/src/routes/files.ts`                   | 3    | `GET /versions/:id/file`                             |
| `apps/api/src/reviews.int.test.ts`               | 3    | route integration tests                              |
| `apps/web/src/api.ts`                            | 4    | typed fetch helpers, `ApiRequestError`               |
| `apps/web/src/lib/*.ts` (+ tests)                | 4–6  | pure UI helpers                                      |
| `apps/web/src/pages/DocumentList.tsx`            | 4    | table, upload form, polling                          |
| `apps/web/src/pages/DocumentDetail.tsx`          | 5    | header, grouped value cards, retry                   |
| `apps/web/src/components/ValueCard.tsx`          | 5    | one value: evidence, badge, approve/correct          |
| `apps/web/src/components/EvidencePanel.tsx`      | 6    | PDF / Text tabs                                      |
| `README.md`, `docs/decisions/0008-reviews.md`    | 7    | docs                                                 |

---

### Task 1: Shared review rules and DTOs

**Files:**
- Create: `packages/shared/src/review.ts`, `packages/shared/src/review.test.ts`
- Modify: `packages/shared/src/api.ts`, `packages/shared/src/index.ts`, `packages/db/src/documents.ts`
  (use `deriveReviewState`; add `progress` to the detail)

**Interfaces:**
- Produces:
  - `deriveReviewState(v: { latestReviewAction: ReviewAction | null; carriedReviewId: string | null }): ValueReviewState`
  - `computeProgress(values: { reviewState: ValueReviewState; isGap: boolean }[]): ProgressDto`
  - `ProgressDto = { pending, approved, corrected, carried_over, gaps, total }` (all non-negative ints; keys exactly as the spec writes them)
  - `ReviewInput` = Zod discriminated union on `action`: `{ action: 'approve' }` |
    `{ action: 'correct', value: string (trimmed, 1..1000), note?: string (trimmed, ≤2000; empty → undefined) }`
  - `ReviewResultDto = { review: ReviewDto, reviewState: ValueReviewState, progress: ProgressDto }`
  - `DocumentListItemDto = DocumentSummaryDto.extend({ progress: ProgressDto, createdAt: string })`
  - `DocumentDetailDto` gains `progress: ProgressDto` (for the shown version)

- [ ] **Step 1: Write the failing tests** in `review.test.ts`:
  - `deriveReviewState`: `('approve', null) → 'approved'`, `('correct', 'r1') → 'corrected'` (own review beats carried), `(null, 'r1') → 'carried_over'`, `(null, null) → 'pending'`.
  - `computeProgress` on `[pending gap, approved, corrected, carried_over, approved gap]` →
    `{ pending: 1, approved: 2, corrected: 1, carried_over: 1, gaps: 2, total: 5 }`; on `[]` → all zeros.
  - `ReviewInput.parse({ action: 'correct', value: '  12  ', note: '' })` →
    `{ action: 'correct', value: '12' }` (no `note` key); `{ action: 'correct', value: '   ' }` throws;
    `{ action: 'delete' }` throws.
- [ ] **Step 2:** `pnpm --filter @lomi/shared test` → FAIL (module not found).
- [ ] **Step 3:** Implement `review.ts` and the DTO additions; export from `index.ts`.
- [ ] **Step 4:** `pnpm --filter @lomi/shared test` → PASS.
- [ ] **Step 5:** In `getDocumentDetail`, replace the inline state ternary with `deriveReviewState`
  and add `progress: computeProgress(...)` over the returned values (`isGap = value === null`).
  Add one assertion to the existing `orders values by field order...` int test:
  `progress` equals `{ pending: 1, approved: 1, corrected: 1, carried_over: 0, gaps: 0, total: 3 }`.
  Run `pnpm --filter @lomi/db test:integration` → PASS, then `pnpm -r run typecheck` → exit 0.
- [ ] **Step 6: Commit** `feat(shared): review state, progress and review DTOs`.

### Task 2: DB — append a review, list documents, progress

**Files:**
- Create: `packages/db/src/reviews.ts`, `packages/db/src/reviews.int.test.ts`
- Modify: `packages/db/src/index.ts` (append export), `packages/db/package.json` (add `@lomi/extraction: workspace:*`)

**Interfaces:**
- Consumes: Task 1's `deriveReviewState`, `computeProgress`, `ReviewInput`, DTOs; `normalizeValue(value, type)` from `@lomi/extraction` (returns `null` when the value isn't a valid value of that type).
- Produces:
  - `reviewValue(db: Db, valueId: string, input: ReviewInput, opts: { fields: ExpectedFields }): Promise<ReviewValueResult>`
  - `type ReviewValueResult = { kind: 'reviewed'; result: ReviewResultDto } | { kind: 'not_found' } | { kind: 'not_reviewable'; reason: string } | { kind: 'invalid_value'; message: string }`
  - `listDocuments(db: Db): Promise<DocumentListItemDto[]>`: newest document first, current version's `versionNo`/`status`, progress of the current version
  - `getProgress(db: Db, documentId: string): Promise<ProgressDto | null>` (`null` = unknown document)

`reviewValue` is one interactive `$transaction`, in this order:
1. Load the value with its version and document. If it is missing → `not_found`.
2. `SELECT 1 FROM documents WHERE id = $doc FOR SHARE`. This serializes the review against Phase
   3's supersede, which holds `FOR UPDATE`.
3. After the lock, re-read the document's `currentVersionId` and the version's status. If the value
   isn't on the current version, or that version isn't `extracted` → `not_reviewable`. Use the
   reasons `value belongs to version N, not the current version` and
   `version is <status>, not extracted`.
4. For `correct`, look up the field's type in `opts.fields[document.type]`. If
   `normalizeValue(value, type)` is null → `invalid_value` with `"<value>" is not a valid <type>`.
5. Insert the review row, then return the new state and the version's progress.

A `string` field accepts any non-blank text.

- [ ] **Step 1: Write the failing int tests.** Create versions and values directly through
  Prisma, as `documents.int.test.ts` does:
  - `approve appends a row and returns approved with progress`
  - `correct stores the trimmed value and note; state corrected`
  - `double approve keeps two rows and counts the value once`: `progress.approved === 1`,
    `progress.total === 1`, `db.review.count() === 2`
  - `approve on a gap is allowed (confirmed absent)`
  - `correct on a gap supplies the value`
  - `rejects a value of a non-current version`: v1 value, v2 current → `not_reviewable`, 0 rows
  - `rejects a value whose version is not extracted` (`queued`) → `not_reviewable`
  - `rejects an invalid correction`: money `abc` → `invalid_value` with message `"abc" is not a valid money`; date `2025-02-30` → `invalid_value`; 0 rows
  - `not_found for an unknown value id`
  - `listDocuments orders newest first and carries progress`; `getProgress` returns zeros for a
    queued version and `null` for an unknown document
- [ ] **Step 2:** `pnpm --filter @lomi/db test:integration` → FAIL (`reviewValue` not exported).
- [ ] **Step 3:** Implement `reviews.ts`. Reuse a private helper shared with `getDocumentDetail` that
  loads a version's values with their latest review, so progress is computed one way only.
- [ ] **Step 4:** `pnpm --filter @lomi/db test:integration` → PASS (all suites, old ones included).
- [ ] **Step 5: Commit** `feat(db): append reviews, list documents and progress`.

### Task 3: API routes

**Files:**
- Create: `apps/api/src/routes/reviews.ts`, `apps/api/src/routes/files.ts`, `apps/api/src/reviews.int.test.ts`
- Modify: `apps/api/src/routes/documents.ts`, `apps/api/src/app.ts` (register the new route modules), README "API" section

**Interfaces:**
- Consumes: Task 2's `reviewValue`, `listDocuments`, `getProgress`; `deps.files.read(key)` (rejects with `code === 'ENOENT'` if the file is missing).
- Produces (HTTP):
  - `GET /documents` → `200 DocumentListItemDto[]`
  - `GET /documents/:id/progress` → `200 ProgressDto`; `400` bad uuid; `404`
  - `POST /values/:id/review` → `201 ReviewResultDto`; `400` (bad uuid, body fails `ReviewInput`, `invalid_value`); `404`; `409 conflict` (`not_reviewable`, with its reason as `message`)
  - `GET /versions/:id/file` → `200`, `content-type: application/pdf`,
    `content-disposition: inline; filename="<title>-v<N>.pdf"`,
    `cache-control: private, max-age=31536000, immutable` (content-addressed: a version's bytes never change); `404` for an unknown version **or** a missing file

`/versions/:id/file` uses `files.read`, not `stream`: files are capped at 20 MB, and a read lets a
missing file turn into a clean `404` before any header is sent. The filename has to be safe in a
header, so replace any character outside `[A-Za-z0-9._-]` with `_`.

- [ ] **Step 1: Write the failing tests** in `reviews.int.test.ts`. Reuse the app/upload helpers
  pattern from `documents.int.test.ts`, and create values through Prisma:
  - `GET /documents` lists an uploaded document with `progress.total === 0` and status `queued`
  - `POST /values/:id/review approve → 201` with `reviewState: 'approved'`; a second `GET /documents/:id` shows `latestReview.action === 'approve'`
  - `correct with an invalid money → 400` and body `{ error: 'bad_request', message: '"abc" is not a valid money' }`
  - `body { action: 'correct' } without value → 400`
  - `review on a queued version → 409` with `error: 'conflict'`
  - `unknown value → 404`; `non-uuid id → 400`
  - `GET /documents/:id/progress → 200` with the counts; unknown → `404`
  - `GET /versions/:id/file` returns the uploaded bytes (`res.rawPayload.equals(invoicePdf)`) and the three headers above
  - `GET /versions/:id/file when the file was deleted from the store → 404 not_found`
- [ ] **Step 2:** `pnpm --filter @lomi/api test:integration` → FAIL (404 route not found).
- [ ] **Step 3:** Implement the routes, mapping each db result kind to the status above. Every
  route comment states its statuses, as the existing routes' comments do.
- [ ] **Step 4:** `pnpm --filter @lomi/api test:integration` → PASS (old suite included), then
  `pnpm --filter @lomi/api lint typecheck` → exit 0.
- [ ] **Step 5:** Update the README "API" route table; commit `feat(api): review, list, progress and file routes`.

### Task 4: Web — API client, pure helpers, document list with upload

**Files:**
- Modify: `apps/web/src/api.ts`, `apps/web/src/pages/DocumentList.tsx`, `apps/web/src/main.tsx`
  (wrap the app in `<MantineProvider>` and import `@mantine/core/styles.css` once),
  `apps/web/src/Layout.tsx` (rebuilt with Mantine `AppShell` or `Container size="xl"`, so the detail
  page's two columns fit; health indicator as a `Badge`), `apps/web/package.json` (add
  `@mantine/core@9.8.2` and `@mantine/hooks@9.8.2`; add a `vitest` devDependency if it doesn't resolve)
- Create: `apps/web/src/lib/poll.ts`, `apps/web/src/lib/highlight.ts`, `apps/web/src/lib/format.ts`, and a `*.test.ts` next to each

**Interfaces:**
- Consumes: Task 1/3 DTOs and routes, all under `/api` (Vite proxy in dev, nginx in docker).
- Produces:
  - `class ApiRequestError extends Error { status: number; code: ApiError['error'] | 'network' }`. Its `message` is the server's `message` when the body is an `ApiError`, else `"<status> <statusText>"`.
  - `apiGet<T>(path)`, `apiPost<T>(path, body?: unknown)` (JSON), `apiUpload<T>(path, form: FormData)`; all throw `ApiRequestError`
  - `pollInterval(statuses: VersionStatus[]): number | false` → `2000` if any is `queued` or `extracting`, else `false`
  - `highlightSegments(text: string, start: number | null, end: number | null): { before: string; match: string; after: string }`. Clamps to `[0, text.length]`; null or empty range → `{ before: text, match: '', after: '' }`.
  - `progressLabel(p: ProgressDto): string` → `"3 need review · 2 approved"`. It lists only the non-zero parts in the order need review, approved, corrected, carried over; `total === 0` → `"—"`.

- [ ] **Step 1: Write the failing unit tests**:
  - `pollInterval(['extracted','failed']) === false`; `pollInterval(['extracted','queued']) === 2000`; `pollInterval([]) === false`
  - `highlightSegments('abcdef', 2, 4)` → `{ before: 'ab', match: 'cd', after: 'ef' }`; `(text, null, null)` → all in `before`; `('abc', 1, 99)` → `{ before: 'a', match: 'bc', after: '' }`; `('abc', 5, 9)` → `{ before: 'abc', match: '', after: '' }`
  - `progressLabel({ pending: 3, approved: 2, corrected: 0, carried_over: 0, gaps: 1, total: 5 }) === '3 need review · 2 approved'`; all-zero → `'—'`
- [ ] **Step 2:** `pnpm --filter @lomi/web test` → FAIL.
- [ ] **Step 3:** Implement the helpers and `api.ts`.
- [ ] **Step 4:** `pnpm --filter @lomi/web test` → PASS.
- [ ] **Step 5:** Install Mantine (`pnpm --filter @lomi/web add @mantine/core@9.8.2 @mantine/hooks@9.8.2`),
  wire `MantineProvider` and the stylesheet into `main.tsx`, and rebuild `Layout` with Mantine.
- [ ] **Step 6:** Build `DocumentList` with Mantine components:
  - A `Table` with title (a link to `/documents/:id`), type, `vN`, a status `Badge` and `progressLabel`.
  - `useQuery(['documents'])` with `refetchInterval: (q) => pollInterval(q.state.data?.map(d => d.status) ?? [])`.
  - An upload form with a type `Select` from `DocumentType.options`, an optional title `TextInput`,
    a `FileInput` (`accept="application/pdf"`) and a submit `Button` showing `loading` while pending.
  - On `201`/`200`, navigate to the document. On error, show `err.message` in a red `Alert` under
    the form (413 → "file is larger than 20 MB").
  - Empty list → "No documents yet — upload one above."
  - Load error → an `Alert` with the message and a Retry `Button`.
- [ ] **Step 7:** `pnpm --filter @lomi/web build lint` → exit 0. Commit after Step 5
  (`chore(web): add Mantine`) and again here (`feat(web): document list with upload and polling`).

### Task 5: Web — detail page and review actions

**Files:**
- Modify: `apps/web/src/pages/DocumentDetail.tsx`
- Create: `apps/web/src/components/ValueCard.tsx` (a Mantine `Card`),
  `apps/web/src/components/StatusPill.tsx` (a Mantine `Badge` with one colour per status, moved out
  of the list), `apps/web/src/lib/values.ts`, `apps/web/src/lib/values.test.ts`

**Interfaces:**
- Consumes: `GET /documents/:id`, `POST /values/:id/review`, `POST /documents/:id/retry`; Task 4 helpers.
- Produces:
  - `groupValues(values: ValueDto[]): { attention: ValueDto[]; carried: ValueDto[]; done: ValueDto[] }`. `attention` = `pending` (gaps included), `carried` = `carried_over`, `done` = `approved`/`corrected`. Field order is kept inside each group.
  - `effectiveValue(v: ValueDto): string | null` → `latestReview.correctedValue` when state is `corrected`, else `v.value`
  - `<ValueCard value selected onSelect canReview />`. Task 6 relies on `onSelect(valueId)`.
  - The detail page keeps `selectedValueId` in state. It defaults to the first `attention` value, else the first value.

- [ ] **Step 1: Write the failing tests** (`values.test.ts`):
  - `groupValues` sorts `[approved a, pending gap b, carried c, pending d]` into `attention [b, d]`, `carried [c]`, `done [a]`
  - `effectiveValue` → the correction for a corrected value, the extracted value for an approved one, and `null` for a pending gap
- [ ] **Step 2:** `pnpm --filter @lomi/web test` → FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** Build the page:
  - **Header:** title, type, `vN`, status pill and `progressLabel`, polling with `pollInterval([status])`.
  - **Status messages:**
    - `failed` → the error text and a Retry button (`POST …/retry`; refetch on success, show the message on `409`).
    - `queued`/`extracting` → "Extracting…" in place of the cards.
    - `extracted` with no values → "No fields defined for this type."
  - **Cards:** grouped as "Needs review", "Carried over" and "Done", with a group's heading
    hidden when it is empty. Each card shows:
    - the field name and type;
    - the effective value (if corrected: the correction, with the original struck through);
    - the gap reason with a "Gap" badge, and candidate values as buttons that prefill Correct;
    - the evidence quote in a Mantine `Blockquote` with "page N";
    - the state `Badge`;
    - an Approve `Button`, labelled "Confirm absent" on a gap;
    - Correct, which opens an inline form (`TextInput` value, optional `Textarea` note, Save, Cancel).
    - Click flow (owner's MVP choice): each Approve or Save is sent immediately as one
      `POST /values/:id/review`, with no draft step. Reviewed cards in "Done" keep both buttons, so a
      decision can be changed later. That appends a new review, and the newest one wins. Approve on
      a corrected card goes back to the extracted value.
  - **Mutations:** invalidate `['document', id]` and `['documents']`. A `400`/`409` message shows
    on the card. Buttons are disabled while a mutation is pending and when `!canReview`
    (`status !== 'extracted'`).
  - **Layout:** a Mantine `Grid` with cards on the left (`span={6}`) and an empty right column for
    Task 6. `failed` errors show in an `Alert`, and `queued`/`extracting` show a `Loader` with "Extracting…".
- [ ] **Step 6:** `pnpm --filter @lomi/web build lint test` → exit 0. Commit `feat(web): detail page with approve and correct`.

### Task 6: Web — evidence panel (PDF page jump + text highlight)

**Files:**
- Create: `apps/web/src/components/EvidencePanel.tsx`, `apps/web/src/pdf.ts` (worker setup)
- Modify: `apps/web/src/pages/DocumentDetail.tsx` (render the panel in the right column), `apps/web/package.json`
  (`react-pdf@11.1.0`, `pdfjs-dist@6.5.438` exact, so the worker URL resolves under pnpm's strict layout)

**Interfaces:**
- Consumes: `VersionDto` (`id`, `parsedText`, `pageOffsets`), the selected `ValueDto`, `highlightSegments`, `GET /api/versions/:id/file`.
- Produces: `<EvidencePanel version selected />`, which takes `selected: ValueDto | null`.

Behaviour:
- **Tabs:** Mantine `Tabs`, PDF (default) and Text. Page controls are Mantine `Button`s; errors use `Alert`.
  - The tab choice survives selecting another value.
  - With no text layer yet (`parsedText === null`), the Text tab shows "Text not parsed yet".
- **PDF tab:** `<Document file={`/api/versions/${version.id}/file`}>` and one `<Page pageNumber>`
  with `renderTextLayer={false}` and `renderAnnotationLayer={false}` (no on-PDF highlight).
  - Prev/next buttons and "page X of N".
  - Selecting a value with `evidencePage` jumps to that page; a gap leaves the page as it is.
  - Width follows the column (a `ResizeObserver` on the container).
  - A load error shows "Could not load the PDF" with the error.
- **Text tab:** a `ScrollArea` holding `<pre style="white-space: pre-wrap">` with the
  before/match/after segments, the match in Mantine `<Mark>` (it renders a `<mark>` element). It scrolls the `<mark>` into view (`block: 'center'`) when the selection
  changes.
- **Worker:** `pdf.ts` sets `pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()`,
  imported once from `main.tsx`.

- [ ] **Step 1:** Add the dependencies (`pnpm --filter @lomi/web add react-pdf@11.1.0 pdfjs-dist@6.5.438`).
  Confirm that `node_modules/pdfjs-dist/build/pdf.worker.min.mjs` exists under `apps/web`.
- [ ] **Step 2:** Implement `pdf.ts` and `EvidencePanel.tsx`, then wire the panel in.
- [ ] **Step 3:** `pnpm --filter @lomi/web build lint test` → exit 0. The build output must include
  the worker as an emitted asset: `ls apps/web/dist/assets | grep -i worker` is non-empty.
- [ ] **Step 4: Commit** `feat(web): PDF and parsed-text evidence panel`.

### Task 7: Compose, docs, end-to-end browser check

**Files:**
- Create: `docs/decisions/0008-reviews.md` (≤ 30 lines: context, choice, alternatives, consequences)
- Modify: `README.md` (Phase 2 status, UI walkthrough, the new routes), `docker-compose.yml` only if needed

- [ ] **Step 1:** Write decision note 0008. It covers:
  - the append-only annotation model;
  - the `FOR SHARE` lock against supersede;
  - gaps being reviewable;
  - typed validation of corrections, and its cost (a reviewer can't type free text into a money field);
  - progress counting each value once, with `gaps` overlapping.
- [ ] **Step 2:** Update the README: mark Phase 2 done, describe the list and detail screens, and
  link 0008. Add to its TODO section: "Draft → submit review flow. Decisions held as drafts in
  localStorage per version, a sticky submit bar, a before/after summary, and an all-or-nothing
  `POST /documents/:id/reviews`. Deferred: the MVP saves each click." Note 0008 also records
  the click-flow choice and this alternative.
- [ ] **Step 3:** Host checks: `pnpm -r run build`, `pnpm -r run lint`, `pnpm -r run typecheck`,
  `pnpm -r run test` → all exit 0. Then run `pnpm --filter @lomi/db test:integration` and
  `pnpm --filter @lomi/api test:integration` one after the other → PASS.
- [ ] **Step 4:** Rebuild the images one service at a time (low memory on this machine):
  `docker compose build api`, then `docker compose build web`, then `docker compose up -d`.
  Wait until `curl -s localhost:3000/health` returns `{"pg":"ok","redis":"ok"}`.
- [ ] **Step 5: Browser check** (Playwright MCP on `http://localhost:8080`). Each item must hold:
  1. The list shows the seeded documents with status and progress, and polling stops once all are extracted (no `/api/documents` requests for 6 s).
  2. Opening the invoice shows grouped cards. Clicking a value jumps the PDF tab to its page, and the Text tab shows the quote in `<mark>`.
  3. Approve a value: its card moves to "Done" and the header progress updates.
  4. Correct `total_amount` with `abc`: an inline `"abc" is not a valid money` error appears. Correct it with `5230.29`: the card shows the correction, with the original struck through.
  5. "Confirm absent" on the market report's `median_household_income` gap moves it to Done.
  6. Uploading a non-PDF from the list shows `file is not a PDF`.

  Save screenshots for items 2 and 4 to the scratchpad and mention them in the report.
- [ ] **Step 6: Commit** `docs: phase 2 review UI, decision 0008`.
