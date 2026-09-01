# IMP-INDEX001 — Fast read/search model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use strict TDD and `superpowers:verification-before-completion` before any completion claim.

**Goal:** Add a fast, project-isolated, structured + lexical full-text Project OS read model that is asynchronously synchronized from canonical/Managed Document authority, exposes explicit freshness, and remains fully reconstructible from durable truth.

**Architecture:** Add an installation-scoped SQLite-backed `SearchIndexGuard` Durable Object with FTS5 behind Project OS search contracts. ProjectGuard remains the per-project source coordination boundary and records durable search-sync work after canonical and governed-document changes. Canonical synchronization sends a complete structured project snapshot for the newest requested revision; Managed Document synchronization sends ordered document batches identified by stable `document_id`, with a full-document snapshot only for initialization/recovery. Search queries always carry explicit project scope, hit the active search generation only, and return authoritative Project OS references. Rebuilds stage a new per-project generation and promote it only after source watermarks remain unchanged and the staged generation passes validation.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers, SQLite-backed Durable Objects, SQLite FTS5, existing provider-neutral Project OS persistence runtime, Zod 4, Vitest 4 with `@cloudflare/vitest-pool-workers`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-01-imp-index001-fast-read-search-model-design.md` at GitHub commit `c5e711824c94be3f06a2bfdb5203a6b549cfc231`.

**Validated against:** canonical `PRJ-0002` revision `130` after committed decision `DEC-INDEXSPEC001`, and GitHub `main` commit `c5e711824c94be3f06a2bfdb5203a6b549cfc231`.

## Current execution status

- Written INDEX001 specification: founder-approved and canonically recorded by `DEC-INDEXSPEC001`.
- Canonical Project OS revision at planning baseline: `130`.
- Implementation task: not created or started by this plan.
- Runtime implementation: not authorized by the specification approval alone.
- Start implementation only after explicit approval of this implementation plan and the normal Project OS task/start gate.
- Execute on a dedicated implementation branch `imp/index001-fast-read-search`, never directly on `main`.

## Global Constraints

- Search/index state is derived technical state and may never become canonical business truth.
- Do not bump canonical `ProjectState`, transaction, Managed Document, or business schema versions for INDEX001.
- Preserve ProjectGuard as the per-project serialization/correctness boundary for source-side synchronization requests.
- Preserve the provider-neutral runtime boundary. Search core may not import `DropboxClient`, Dropbox error classes, Dropbox IDs/revisions, or Dropbox search APIs.
- Dropbox remains the current production provider; INDEX001 adds no alternate provider and no local-filesystem dependency.
- Normal query execution must never recursively scan/download Dropbox/provider content.
- Every query must carry explicit project scope. Missing/empty scope is an error, never “all projects”.
- Project filtering must happen inside SQL/query execution before ranking.
- Index current canonical entities and current governed Managed Document/reference heads only; ordinary historical commit/version search is outside INDEX001.
- Generated canonical Markdown (`STATE.md`, `HANDOFF.md`, `ROADMAP.md`, generated entity notes, etc.) is not separately indexed.
- Active `INPUTS/` objects and unresolved MutationGate candidates are excluded from normal search.
- Binary/opaque governed content is metadata-only in INDEX001; add no OCR/general extraction service.
- Add no embeddings, vector index, semantic reranker, external search service, or LLM reranking.
- Raw query text, document bodies, and snippets must never be emitted to normal operational logs.
- Canonical and document freshness are separate watermarks.
- Canonical commit/document authority remains successful even when search synchronization fails; search reports lag instead.
- A SearchIndex loss or rebuild must not cause canonical history or Managed Document state to be rewritten.
- Continuity remains `stable`; INDEX001 does not change rollout authority or version-selection UX.
- Use bounded concurrency and bounded query/result sizes. Initial public search limits are `100` project IDs, query text `512` characters, `32` lexical terms, default `20` results, maximum `100` results.
- Rebuild must keep the last proven active project generation queryable until a staged generation is complete and validated.

---

## File map locked by this plan

### New source files

- `src/search/contract.ts` — search records, query/result/freshness/update contracts and Zod parsers.
- `src/search/hash.ts` — deterministic SHA-256 snapshot hashing for ordered search records.
- `src/search/canonical-records.ts` — pure `ProjectState -> CanonicalSearchRecord[]` projection.
- `src/search/document-records.ts` — governed Managed Document/reference head -> searchable current record projection.
- `src/search/project-sync-store.ts` — ProjectGuard-local durable requested/indexed watermarks and ordered document sync batches.
- `src/search/project-synchronizer.ts` — source-side canonical/document snapshot delivery to SearchIndexGuard.
- `src/search/query-compiler.ts` — safe bounded lexical tokenization and SQL/FTS query inputs.
- `src/search/sqlite-store.ts` — SearchIndex SQLite schema, active/staging generations, FTS rows, apply/query/status primitives.
- `src/search/rebuild.ts` — resumable staged project rebuild coordinator.
- `src/search/search-index-guard.ts` — installation-scoped Durable Object HTTP/alarm boundary.

### Existing source files modified

- `src/documents/repository.ts` — list governed document heads/IDs and verify/read immutable text payloads.
- `src/documents/reconciler.ts` — report exact changed `document_id` values after governed reconciliation.
- `src/documents/change-coordinator.ts` — preserve changed-document IDs in coordinator summary.
- `src/durable/project-guard-neutral.ts` — initialize/request/drain search sync, multiplex alarm work, expose sync status/reconciliation.
- `src/index-neutral.ts` — authenticated search/admin endpoints and fleet search reconciliation helper.
- `src/index.ts` — include search reconciliation in production scheduled maintenance.
- `src/index-mutation-gate.ts` — export `SearchIndexGuard` from the production Worker module.
- `wrangler.jsonc` — bind/export the new SQLite Durable Object.
- `docs/project-os-improvement-roadmap.md` — only after production proof, mark INDEX001 complete and preserve remaining sequence.
- `README.md` — add the search/read-model component to the current architecture/code map after implementation is proven.

### New tests

- `test/search-contract.spec.ts`
- `test/search-canonical-records.spec.ts`
- `test/search-document-records.spec.ts`
- `test/search-project-sync.spec.ts`
- `test/search-index-store.spec.ts`
- `test/search-query.spec.ts`
- `test/search-rebuild.spec.ts`
- `test/search-worker.spec.ts`
- `test/search-provider-neutral.spec.ts`

---

## Task 1 — Define typed search contracts and canonical structured records

**Files:**
- Create: `src/search/contract.ts`
- Create: `src/search/hash.ts`
- Create: `src/search/canonical-records.ts`
- Create: `test/search-contract.spec.ts`
- Create: `test/search-canonical-records.spec.ts`

**Interfaces:**
- Consumes: `ProjectState` from `src/domain/project-state.ts`.
- Produces: `CanonicalSearchRecord`, `ManagedDocumentSearchRecord`, `SearchRecord`, `SearchQuery`, `SearchHit`, `SearchAuthorityRef`, `CanonicalSnapshotRequest`, `DocumentBatchRequest`, `SearchIndexProjectStatus`, `buildCanonicalSearchRecords(state)`, `hashSearchRecords(records)`.

- [ ] **Step 1: Write failing contract/parser tests**

```ts
import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../src/search/contract";

describe("search contract", () => {
  it("requires explicit non-empty project scope", () => {
    expect(() => parseSearchQuery({ text: "pricing", project_ids: [] })).toThrow();
  });

  it("bounds normal query size and result limits", () => {
    expect(() => parseSearchQuery({ project_ids: ["PRJ-0002"], text: "x".repeat(513) })).toThrow();
    expect(() => parseSearchQuery({ project_ids: ["PRJ-0002"], limit: 101 })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
npx vitest run test/search-contract.spec.ts test/search-canonical-records.spec.ts
```

Expected: FAIL because `src/search/*` does not exist.

- [ ] **Step 3: Implement exact contracts**

`src/search/contract.ts` must define these stable types:

```ts
export type SearchRecordKind = "canonical_entity" | "managed_document";
export type SearchEntityType = "project" | "phase" | "task" | "decision" | "research" | "constraint" | "deliverable";
export type SearchZone = "references" | "working" | "review" | "deliverables";

export type SearchAuthorityRef =
  | {
      kind: "canonical_entity";
      project_id: string;
      entity_type: SearchEntityType;
      entity_id: string;
      canonical_revision: number;
    }
  | {
      kind: "managed_document";
      project_id: string;
      document_id: string;
      version_id: string;
      logical_path: string;
      content_sha256?: string;
    };

export interface CanonicalSearchRecord {
  project_id: string;
  record_id: string;
  record_kind: "canonical_entity";
  entity_type: SearchEntityType;
  entity_id: string;
  title: string;
  status?: string;
  phase_id?: string;
  body_text: string;
  content_hash: string;
  canonical_revision: number;
  updated_at?: string;
  authority_ref: Extract<SearchAuthorityRef, { kind: "canonical_entity" }>;
}

export interface ManagedDocumentSearchRecord {
  project_id: string;
  record_id: string;
  record_kind: "managed_document";
  document_id: string;
  version_id: string;
  title: string;
  logical_path: string;
  zone: SearchZone;
  stage_or_collection: string;
  reconciliation_status: "clean" | "conflict";
  body_text?: string;
  media_type?: string;
  content_hash: string;
  updated_at?: string;
  authority_ref: Extract<SearchAuthorityRef, { kind: "managed_document" }>;
}

export type SearchRecord = CanonicalSearchRecord | ManagedDocumentSearchRecord;
```

Use Zod to parse `SearchQuery` with these exact limits:

```ts
project_ids: 1..100 unique `PRJ-[0-9]{4,}` values
text: optional, max 512 chars
record_kinds: optional unique supported kinds
entity_types: optional unique supported entity types
zones: optional unique supported zones
statuses: optional unique non-empty strings, max 32 values
limit: integer 1..100, default 20
```

Define update envelopes with full snapshot hashes:

```ts
export interface CanonicalSnapshotRequest {
  project_id: string;
  canonical_revision: number;
  snapshot_hash: string;
  records: CanonicalSearchRecord[];
}

export interface DocumentBatchRequest {
  project_id: string;
  document_epoch: string;
  document_epoch_started_at: string;
  document_generation: number;
  full_snapshot: boolean;
  snapshot_hash: string;
  records: ManagedDocumentSearchRecord[];
  removed_document_ids: string[];
}
```

- [ ] **Step 4: Implement deterministic canonical projection**

`buildCanonicalSearchRecords(state)` returns records sorted by `record_id` and uses these IDs:

```ts
project:${state.project_id}
phase:${phase.phase_id}
task:${task.task_id}
decision:${decision.decision_id}
research:${research.research_id}
constraint:${constraint.constraint_id}
deliverable:${deliverable.deliverable_id}
```

Include all authoritative searchable text in `body_text`: project objective/framing/discovery; task description/blocker/result; phase objective/next actions; decision/reason/impacts/supersession; research body/source; constraint description; deliverable description/reference/outcome/owner/acceptance/supersession/abandonment. Do not render generated Markdown to build search text.

Compute `content_hash` from a canonical JSON representation of the record semantic fields, not from the project-wide revision. Implement `hashSearchRecords(records)` as SHA-256 over records sorted by `(project_id, record_id)`.

- [ ] **Step 5: Add canonical record tests**

Cover exact IDs, statuses, superseded decisions, archived project status, research text, deterministic sorting, deterministic content/snapshot hashes, and no generated-Markdown dependency.

- [ ] **Step 6: Run GREEN verification**

```bash
npx vitest run test/search-contract.spec.ts test/search-canonical-records.spec.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/search/contract.ts src/search/hash.ts src/search/canonical-records.ts test/search-contract.spec.ts test/search-canonical-records.spec.ts
git commit -m "feat: define structured search read model"
```

---

## Task 2 — Project governed document heads into searchable records and surface changed IDs

**Files:**
- Create: `src/search/document-records.ts`
- Modify: `src/documents/repository.ts`
- Modify: `src/documents/reconciler.ts`
- Modify: `src/documents/change-coordinator.ts`
- Create: `test/search-document-records.spec.ts`
- Modify: `test/document-reference-reconcile.spec.ts`
- Modify: `test/document-external-edits.spec.ts`
- Modify: `test/input-intake-service.spec.ts`

**Interfaces:**
- Consumes: `DocumentLedgerRepository`, `ManagedDocumentHead`, `DocumentVersionRecord`.
- Produces: `DocumentLedgerRepository.listHeadIds(projectId)`, `DocumentLedgerRepository.readVerifiedTextPayload(record)`, `buildManagedDocumentSearchRecord(ledger, projectId, documentId)`, `buildManagedDocumentSearchRecords(ledger, projectId, documentIds)`, and reconciliation `changed_document_ids`.

- [ ] **Step 1: Write failing document projection tests**

```ts
it("chooses the current logical work-product head before a published ancestor", async () => {
  const record = await buildManagedDocumentSearchRecord(ledger, projectId, documentId);
  expect(record).toMatchObject({ document_id: documentId, zone: "working" });
});

it("indexes a governed binary as metadata only", async () => {
  const record = await buildManagedDocumentSearchRecord(ledger, projectId, binaryDocumentId);
  expect(record?.body_text).toBeUndefined();
});
```

Also test reference collection routing, stable `document_id`, exact `version_id`, `reconciliation_status`, and text payload hash verification.

- [ ] **Step 2: Run RED tests**

```bash
npx vitest run test/search-document-records.spec.ts test/document-reference-reconcile.spec.ts test/document-external-edits.spec.ts
```

- [ ] **Step 3: Add ledger enumeration/payload helpers**

Add to `DocumentLedgerRepository`:

```ts
async listHeadIds(projectId: string): Promise<string[]>;
async readVerifiedTextPayload(record: CurrentDocumentVersionRecord): Promise<string | null>;
```

`listHeadIds` lists only `${machineDocumentRoot(projectId)}/heads`, accepts filenames matching `DOC-[A-F0-9]{24}.json`, sorts IDs, and does not inspect workspace file presence. `readVerifiedTextPayload` returns `null` when `content_sha256` is absent; otherwise it reads `record.immutable_payload_path`, recomputes Project OS SHA-256, and fails closed on missing/mismatching content.

- [ ] **Step 4: Implement current document record selection**

For references, use `reference_version_id` and zone `references`.

For work products, select current logical version in this exact precedence:

```ts
working_version_id ?? review_version_id ?? published_version_id
```

Map stages to zones:

```ts
working -> working
review -> review
published -> deliverables
reference -> references
```

Derive `title` from the final logical-path filename with the final extension removed. Use full verified text payload as `body_text` only when Project OS has canonical SHA-256 text payload evidence. Provider snapshot-only/binary versions remain metadata-only.

Use `record_id = document:${document_id}` and authority refs containing `project_id`, `document_id`, `version_id`, `logical_path`, and `content_sha256` when present.

- [ ] **Step 5: Make reconciliation report exact changed document IDs**

Extend `ManagedDocumentReconcileSummary` and `ManagedDocumentChangeSummary` with:

```ts
changed_document_ids: string[];
```

Internally accumulate a `Set<string>` and return it sorted. Change helper return values so successful governed head changes return their `document_id` rather than only `true`:

```ts
restoreDeletedWorkProduct(...): Promise<string | null>
captureWorkProductEdit(...): Promise<string | null>
captureReferenceEdit(...): Promise<string | null>
reconcilePublishedEdit(...): Promise<{ outcome: "working" | "conflict" | "ignored"; document_id?: string }>
```

For INPUTS ingestion, add `result.document_id` when `completed` creates/advances the governed reference. Do not add IDs for pure duplicate cleanup that does not change a head.

- [ ] **Step 6: Prove INPUTS/candidate semantics remain correct**

Tests must show active INPUTS never directly produce a search record; only the resulting governed reference head is projectable. Existing MutationGate tests remain unchanged and no candidate repository is imported by `document-records.ts`.

- [ ] **Step 7: Run GREEN verification**

```bash
npx vitest run test/search-document-records.spec.ts test/document-reference-reconcile.spec.ts test/document-external-edits.spec.ts test/input-intake-service.spec.ts
npm run check:persistence-boundary
```

- [ ] **Step 8: Commit**

```bash
git add src/search/document-records.ts src/documents/repository.ts src/documents/reconciler.ts src/documents/change-coordinator.ts test/search-document-records.spec.ts test/document-reference-reconcile.spec.ts test/document-external-edits.spec.ts test/input-intake-service.spec.ts
git commit -m "feat: project governed documents for search"
```

---

## Task 3 — Add ProjectGuard-local durable search synchronization state

**Files:**
- Create: `src/search/project-sync-store.ts`
- Create: `test/search-project-sync.spec.ts`

**Interfaces:**
- Produces: `initializeProjectSearchSyncSchema(storage)`, `ProjectSearchSyncStore`, `SearchSyncStatus`, `DocumentSyncBatch`.
- Later tasks consume `requestCanonical`, `requestDocuments`, `requestFullDocumentSnapshot`, `nextDocumentBatch`, `markCanonicalIndexed`, `markDocumentIndexed`, `markFailure`, `clearFailure`, `status`, `needsWork`.

- [ ] **Step 1: Write RED integration tests around durable requested/indexed state**

Use a ProjectGuard test stub and assert:

```ts
expect(status).toMatchObject({
  canonical_revision_requested: 1,
  canonical_revision_indexed: 0,
  document_generation_requested: 1,
  document_generation_indexed: 0,
  document_full_rebuild_required: true
});
```

Test duplicate canonical requests coalesce to the highest revision. Test document batches are FIFO and deduplicate document IDs inside a batch. Test a storage-initialized project begins with one full-document batch so historical governed heads are not silently considered current.

- [ ] **Step 2: Implement schema**

Create these ProjectGuard SQLite tables:

```sql
CREATE TABLE IF NOT EXISTS search_sync_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  canonical_revision_requested INTEGER NOT NULL,
  canonical_revision_indexed INTEGER NOT NULL,
  document_epoch TEXT NOT NULL,
  document_epoch_started_at TEXT NOT NULL,
  document_generation_requested INTEGER NOT NULL,
  document_generation_indexed INTEGER NOT NULL,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS search_document_batches (
  generation INTEGER PRIMARY KEY,
  full_snapshot INTEGER NOT NULL CHECK (full_snapshot IN (0, 1)),
  document_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
```

When no control row exists, insert a new opaque `document_epoch` using `crypto.randomUUID()`, `document_epoch_started_at = new Date().toISOString()`, `document_generation_requested = 1`, `document_generation_indexed = 0`, and a generation-1 `full_snapshot=1` pending batch.

- [ ] **Step 3: Implement exact store rules**

```ts
requestCanonical(revision): canonical_requested = max(current, revision)
requestDocuments(ids): increment requested generation; insert sorted unique IDs as full_snapshot=0
requestFullDocumentSnapshot(): increment requested generation; insert full_snapshot=1 with [] IDs
nextDocumentBatch(): return only generation = document_generation_indexed + 1
markDocumentIndexed(g): require g = indexed + 1; mark completed and advance indexed
markCanonicalIndexed(r): require r <= requested and r >= indexed; advance indexed
```

Failures increment attempts and preserve pending work. `needsWork()` is true when canonical requested > indexed or a next document batch exists.

- [ ] **Step 4: Add deterministic status tests**

Cover first deployment, retry, FIFO gaps, malformed batch JSON fail-closed behavior, canonical coalescing, and new-epoch initialization semantics.

- [ ] **Step 5: Run GREEN verification**

```bash
npx vitest run test/search-project-sync.spec.ts
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/search/project-sync-store.ts test/search-project-sync.spec.ts
git commit -m "feat: add durable search sync outbox"
```

---

## Task 4 — Add the SQLite/FTS5 SearchIndex store and Durable Object binding

**Files:**
- Create: `src/search/sqlite-store.ts`
- Create: `src/search/search-index-guard.ts`
- Modify: `wrangler.jsonc`
- Modify: `src/index-mutation-gate.ts`
- Modify: `src/index-neutral.ts` exports only
- Create: `test/search-index-store.spec.ts`

**Interfaces:**
- Produces: `initializeSearchIndexSchema(storage)`, `SearchIndexStore`, basic internal `SearchIndexGuard` routes `/apply-canonical`, `/apply-documents`, `/status`.

- [ ] **Step 1: Add the Durable Object binding and export in a RED test**

Extend test env expectation:

```ts
const search = (env as unknown as Env & { SEARCH_INDEX_GUARD: DurableObjectNamespace })
  .SEARCH_INDEX_GUARD.getByName("global");
```

Test `GET https://search-index.internal/status?project_id=PRJ-0002` returns an explicit `unknown`/missing-project state before any snapshot.

- [ ] **Step 2: Update Cloudflare config using current repository convention**

Add binding:

```json
{ "name": "SEARCH_INDEX_GUARD", "class_name": "SearchIndexGuard" }
```

Add export:

```json
"SearchIndexGuard": {
  "type": "durable-object",
  "state": "created",
  "storage": "sqlite"
}
```

Export `SearchIndexGuard` from the production module `src/index-mutation-gate.ts` and from `src/index-neutral.ts` for tests/alternate composition.

Run generated types before typecheck:

```bash
npm run types
```

- [ ] **Step 3: Implement SearchIndex SQLite schema**

Use one installation-scoped database with:

```sql
search_project_heads(
  project_id PRIMARY KEY,
  active_generation,
  canonical_revision_indexed,
  canonical_snapshot_hash,
  document_epoch,
  document_epoch_started_at,
  document_generation_indexed,
  document_snapshot_hash,
  rebuild_state,
  last_error,
  updated_at
)

search_records(
  project_id,
  generation,
  record_id,
  record_kind,
  entity_type,
  entity_id,
  document_id,
  version_id,
  title,
  status,
  zone,
  logical_path,
  stage_or_collection,
  reconciliation_status,
  content_hash,
  canonical_revision,
  body_text,
  authority_ref_json,
  updated_at,
  PRIMARY KEY(project_id, generation, record_id)
)
```

Create FTS5:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  project_id UNINDEXED,
  generation UNINDEXED,
  record_id UNINDEXED,
  title,
  body_text,
  tokenize = 'unicode61'
);
```

Add B-tree indexes for `(project_id, generation, record_kind)`, entity fields, document ID, zone, and status.

- [ ] **Step 4: Implement canonical snapshot application**

Rules:

- Create active generation `1` on first apply.
- If incoming revision is lower than indexed, return idempotent stale/no-op.
- If same revision + same snapshot hash, return idempotent success.
- If same revision + different snapshot hash, fail closed with `CANONICAL_SNAPSHOT_HASH_MISMATCH`.
- For a higher revision, in one SQLite transaction delete only prior `canonical_entity` rows/FTS rows in the active generation, insert the complete new canonical records, then advance canonical watermark/hash.
- Do not touch managed-document rows.

- [ ] **Step 5: Implement ordered document batch application**

Rules:

- Same epoch requires `document_generation = indexed + 1`; already-indexed equal hash is idempotent, forward gaps reject.
- New epoch requires `full_snapshot=true` and an `document_epoch_started_at` later than the stored epoch start; switch epoch only inside the full replacement transaction.
- `full_snapshot=true` replaces all `managed_document` rows/FTS rows for the active generation.
- Partial batches upsert provided document records and delete `record_id=document:<document_id>` for `removed_document_ids`.
- Advance document epoch/generation/hash only after row + FTS changes succeed.

- [ ] **Step 6: Add crash/idempotency store tests**

Cover duplicate apply, stale canonical snapshot, canonical coalesced jump, document generation gap, same-generation different hash, new-epoch full snapshot, old-epoch rejection, and project isolation with identical record IDs in two projects.

- [ ] **Step 7: Run GREEN verification**

```bash
npm run types
npx vitest run test/search-index-store.spec.ts
npm run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add src/search/sqlite-store.ts src/search/search-index-guard.ts wrangler.jsonc src/index-mutation-gate.ts src/index-neutral.ts test/search-index-store.spec.ts
git commit -m "feat: add sqlite search index guard"
```

---

## Task 5 — Implement safe structured + FTS query compilation and ranking

**Files:**
- Create: `src/search/query-compiler.ts`
- Extend: `src/search/sqlite-store.ts`
- Extend: `src/search/search-index-guard.ts`
- Create: `test/search-query.spec.ts`

**Interfaces:**
- Produces: `compileLexicalQuery(text)`, `SearchIndexStore.search(query)`, `POST /search` on SearchIndexGuard.

- [ ] **Step 1: Write RED query safety tests**

Cover:

```ts
"pricing"
"pricing strategy"
"' OR 1=1 --"
"NEAR(foo bar)"
"a:b*"
"   "
```

Assert raw FTS syntax/SQL injection never changes query structure, project scope cannot be omitted, and special punctuation is treated as data/token separators.

- [ ] **Step 2: Implement lexical compiler**

`compileLexicalQuery` must:

1. trim input;
2. reject text over 512 characters through the contract parser;
3. tokenize Unicode letters/numbers plus `_`/`-` using application code, not raw FTS syntax;
4. cap at 32 terms;
5. escape internal `"` if any tokenization path retains it;
6. produce a quoted `AND` expression such as `"pricing" AND "strategy"`;
7. return `null` when no lexical token remains.

Never concatenate project IDs/status/zone filters into SQL; use bound placeholders.

- [ ] **Step 3: Implement deterministic ranking**

Execute scoped candidate paths in this precedence:

1. exact case-insensitive `entity_id` / `document_id` match;
2. exact case-insensitive title match;
3. case-insensitive title prefix match;
4. FTS5 lexical match ordered by `bm25(search_fts)` ascending.

Merge candidates by `(project_id, record_id)`, keep the strongest match class, then stable-sort by match class, FTS score where applicable, `project_id`, `record_kind`, `record_id`. Return a numeric `score` plus `match_kind` so score semantics are inspectable rather than magical.

- [ ] **Step 4: Enforce SQL-level project isolation**

Every candidate query must include `project_id IN (...)` and active-generation membership before ranking. Add a negative test where another project has a stronger lexical match but cannot appear in a one-project query.

- [ ] **Step 5: Generate bounded snippets without logging content**

Use SQLite FTS snippet/highlight output or a deterministic local excerpt capped at 320 characters. Snippets are returned to the caller but never logged. Empty structured queries may return filtered records without snippets.

- [ ] **Step 6: Run GREEN verification**

```bash
npx vitest run test/search-query.spec.ts test/search-index-store.spec.ts
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/search/query-compiler.ts src/search/sqlite-store.ts src/search/search-index-guard.ts test/search-query.spec.ts
git commit -m "feat: add scoped lexical search queries"
```

---

## Task 6 — Deliver ProjectGuard source snapshots through the durable sync outbox

**Files:**
- Create: `src/search/project-synchronizer.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Extend: `test/search-project-sync.spec.ts`
- Modify: `test/project-guard-commit-recovery.spec.ts`
- Modify: `test/managed-document-acceptance.spec.ts`
- Modify: `test/document-change-coordinator.spec.ts`
- Modify: `test/artifact-repository.spec.ts` only for legacy managed-artifact sync evidence if needed

**Interfaces:**
- Consumes: Task 1/2 record builders, Task 3 sync store, `env.SEARCH_INDEX_GUARD`.
- Produces: `ProjectSearchSynchronizer.runNext(state)`, ProjectGuard `GET /search-sync-status`, `POST /reconcile-search`.

- [ ] **Step 1: Write RED tests for canonical commit decoupling**

Test a canonical transaction commits even when SearchIndex RPC fails. Assert search status becomes lagging/pending and the canonical receipt remains committed.

- [ ] **Step 2: Implement canonical delivery**

After a V2 canonical commit is durably written and local commit state persisted, call only the local outbox request:

```ts
this.searchSyncStore.requestCanonical(result.state.revision);
await this.ensureDerivedWorkAlarm();
```

Do not synchronously require SearchIndex success before returning the canonical receipt.

On `recoverCommittedRecord`, also ensure canonical requested revision is at least the recovered revision. This repairs loss between canonical authority and local search request.

`ProjectSearchSynchronizer.runNext(state)` builds the complete canonical snapshot for the current `state` when requested > indexed, sends it to `SEARCH_INDEX_GUARD/global/apply-canonical`, and marks local indexed only after a successful/index-idempotent response.

- [ ] **Step 3: Register exact Managed Document changes**

After a committed direct managed-document receipt, request a document batch containing `receipt.document_id`.

After `/reconcile-documents`, request one batch containing `summary.changed_document_ids` when non-empty.

After a committed legacy artifact write, request a conservative full-document snapshot batch because the legacy artifact route may create/update a managed work-product head without returning `document_id` in the artifact receipt.

- [ ] **Step 4: Implement document delivery**

For a normal partial batch, call `buildManagedDocumentSearchRecords` for the batch IDs. IDs with no current governed head become `removed_document_ids`.

For `full_snapshot=true`, enumerate `listHeadIds(projectId)` and build all current governed records.

Send `DocumentBatchRequest` with the ProjectGuard-local epoch/generation and deterministic snapshot hash. Mark the local generation indexed only after SearchIndex confirms application/idempotency.

- [ ] **Step 5: Multiplex ProjectGuard alarm without regressing materialization**

Replace materialization-only alarm scheduling with `ensureDerivedWorkAlarm()` that checks both materialization work and search sync work.

In `alarm()`:

1. serialize through the existing ProjectGuard queue;
2. load/recover current state;
3. attempt one search sync unit; search failure records lag/error but does **not** invalidate canonical/document authority;
4. run the existing materialization `runNext()` path with its existing retry/conflict behavior unchanged;
5. re-arm if either subsystem has work.

Preserve the existing materialization retry count/defer behavior exactly; do not convert a materialization conflict into a search error or vice versa.

- [ ] **Step 6: Add source status/reconciliation endpoints**

`GET /search-sync-status` returns:

```ts
{
  project_id,
  canonical_revision,
  canonical_revision_requested,
  canonical_revision_indexed,
  document_epoch,
  document_epoch_started_at,
  document_generation_requested,
  document_generation_indexed,
  document_full_rebuild_required,
  last_error
}
```

`POST /reconcile-search` must:

- ensure canonical requested >= current state revision;
- preserve existing pending document batches;
- optionally accept internal body `{ force_full: true }` to enqueue a full document snapshot and force a canonical snapshot resend after SearchIndex loss;
- ensure the shared derived-work alarm is armed.

- [ ] **Step 7: Test crash/replay boundaries**

Cover:

- canonical authority succeeds before outbox request: later `reconcile-search` repairs it;
- local request exists, RPC fails: retry remains pending;
- RPC applied but local indexed mark is lost: duplicate RPC is idempotent;
- direct managed document update produces one document generation;
- change-feed reconciliation reports and queues exact changed IDs;
- full-document initial generation indexes pre-existing heads;
- search failure cannot block materialization alarm progress;
- materialization failure cannot mark search work complete.

- [ ] **Step 8: Run GREEN verification**

```bash
npx vitest run test/search-project-sync.spec.ts test/project-guard-commit-recovery.spec.ts test/managed-document-acceptance.spec.ts test/document-change-coordinator.spec.ts test/materialization-coordinator.spec.ts
npm run check:persistence-boundary
```

- [ ] **Step 9: Commit**

```bash
git add src/search/project-synchronizer.ts src/durable/project-guard-neutral.ts test/search-project-sync.spec.ts test/project-guard-commit-recovery.spec.ts test/managed-document-acceptance.spec.ts test/document-change-coordinator.spec.ts
git commit -m "feat: synchronize project search read model"
```

---

## Task 7 — Add generation-safe, resumable rebuild

**Files:**
- Create: `src/search/rebuild.ts`
- Extend: `src/search/sqlite-store.ts`
- Extend: `src/search/search-index-guard.ts`
- Create: `test/search-rebuild.spec.ts`

**Interfaces:**
- Produces: `SearchRebuildCoordinator`, SearchIndexGuard `POST /rebuild-project`, `GET /rebuild-status`, and its Durable Object `alarm()`.

- [ ] **Step 1: Write RED rebuild generation tests**

Start with active generation `G1`, begin rebuild `G2`, then prove searches remain on `G1` until promotion. Inject a failure after some documents and prove already completed rebuild items stay recorded.

- [ ] **Step 2: Add rebuild tables**

```sql
CREATE TABLE IF NOT EXISTS search_rebuild_jobs (
  project_id TEXT PRIMARY KEY,
  staging_generation INTEGER NOT NULL,
  target_canonical_revision INTEGER NOT NULL,
  target_document_epoch TEXT NOT NULL,
  target_document_epoch_started_at TEXT NOT NULL,
  target_document_generation INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('enumerating', 'indexing', 'validating', 'failed')),
  started_at TEXT NOT NULL,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS search_rebuild_items (
  project_id TEXT NOT NULL,
  staging_generation INTEGER NOT NULL,
  document_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY(project_id, staging_generation, document_id)
);
```

- [ ] **Step 3: Capture source watermarks before staging**

`POST /rebuild-project` receives `{ project_id }`. `SearchRebuildCoordinator` calls that project's internal `GET /search-sync-status`, captures canonical/document source watermarks, allocates `staging_generation = active_generation + 1` (or `1` if none), writes canonical records into the staging generation, and enumerates only machine Managed Document head IDs through `DocumentLedgerRepository.listHeadIds` into rebuild items.

Do not infer documents from `WORKSPACE/` presence.

- [ ] **Step 4: Process document rebuild in bounded chunks**

`SearchIndexGuard.alarm()` processes at most `32` pending document IDs per invocation. For each ID, build the current governed record and upsert it into the staging generation; mark each rebuild item completed transactionally after its record write. Re-arm while pending items remain.

A restart repeats only pending/failed items; completed items remain verified in staging.

- [ ] **Step 5: Validate source watermarks immediately before promotion**

When no rebuild items remain, fetch ProjectGuard `search-sync-status` again. Promotion is forbidden if any of these changed from the captured target:

```text
canonical_revision_requested
document_epoch
document_epoch_started_at
document_generation_requested
```

If changed, mark the rebuild job failed with `SOURCE_CHANGED_DURING_REBUILD`, keep the old active generation, and require a fresh rebuild/retry.

- [ ] **Step 6: Validate staged generation and promote atomically**

Before promotion verify:

- no pending rebuild item;
- every row is bound to the target project/staging generation;
- canonical record snapshot exists at target canonical revision;
- staged document record count equals the number of current head IDs that produced searchable records;
- deterministic ordered `(record_id, content_hash)` root hash can be computed successfully;
- no duplicate `(project_id, generation, record_id)` exists by schema invariant.

Then one SQLite transaction updates `search_project_heads.active_generation` and indexed watermarks to the captured target. Old generation rows remain until post-promotion cleanup.

- [ ] **Step 7: Clean old generations incrementally**

After promotion, alarm cleanup deletes old `search_fts`/`search_records` rows in bounded batches. Cleanup failure cannot roll back the new active generation.

- [ ] **Step 8: Test deletion/loss recovery path**

Simulate an empty SearchIndex project head while ProjectGuard still has current authority. `POST /rebuild-project` must rebuild from canonical state + managed heads/payloads, not from previous index storage.

- [ ] **Step 9: Run GREEN verification**

```bash
npx vitest run test/search-rebuild.spec.ts test/search-index-store.spec.ts test/search-query.spec.ts
npm run typecheck
```

- [ ] **Step 10: Commit**

```bash
git add src/search/rebuild.ts src/search/sqlite-store.ts src/search/search-index-guard.ts test/search-rebuild.spec.ts
git commit -m "feat: add resumable search index rebuild"
```

---

## Task 8 — Expose authenticated search, freshness, admin rebuild, and bounded fleet reconciliation

**Files:**
- Modify: `src/index-neutral.ts`
- Modify: `src/index.ts`
- Create: `test/search-worker.spec.ts`

**Interfaces:**
- Produces public control-plane `POST /v1/search` plus admin `POST /v1/admin/search/rebuild`, `GET /v1/admin/search/status` and exported `reconcileSearchIndexes(env)`.

- [ ] **Step 1: Write RED worker API tests**

Cover authorization, explicit scope rejection, project-not-found, one-project search, explicit two-project portfolio search, bounded limit, and no implicit all-project behavior.

- [ ] **Step 2: Implement `POST /v1/search`**

Use the existing `INGRESS_TOKEN` authorization pattern. Parse `SearchQuery`, validate all project IDs exist in RegistryGuard, then:

1. fetch ProjectGuard `/search-sync-status` for scoped project IDs with bounded concurrency `8`;
2. call `SEARCH_INDEX_GUARD/global/search` with the parsed query;
3. combine source sync state with SearchIndex project status.

Freshness precedence per project:

```text
unknown      -> no index head or source status unavailable
rebuilding   -> active rebuild job exists
failed       -> pending lag plus recorded synchronization/rebuild error
lagging      -> canonical requested > indexed OR document requested > indexed
current      -> both source requested watermarks are acknowledged/indexed and no rebuild/failure condition
```

If the ProjectGuard indexed acknowledgement is behind because the SearchIndex apply succeeded before a source-side crash, report `lagging`; replay will converge safely.

- [ ] **Step 3: Implement admin rebuild/status**

`POST /v1/admin/search/rebuild` accepts a non-empty unique `project_ids` array, validates against registry, and starts one staged rebuild per requested project through SearchIndexGuard.

`GET /v1/admin/search/status?project_id=PRJ-xxxx` returns both ProjectGuard source status and SearchIndex active/rebuild status.

- [ ] **Step 4: Add fleet reconciliation**

Export `reconcileSearchIndexes(env)` that lists registry projects, processes at most four projects concurrently, and for each:

1. read SearchIndex status;
2. if index project head is missing, call ProjectGuard `/reconcile-search` with `{ force_full: true }`;
3. otherwise call ProjectGuard `/reconcile-search` normally to repair source requested/indexed divergence;
4. isolate one project's failure from siblings and return counts `{ scanned, scheduled, current, rebuilding, failed }`.

This is watermark/head reconciliation only; it must not recursively scan workspaces or download project corpora.

- [ ] **Step 5: Wire scheduled maintenance**

Add `reconcileSearchIndexes(env)` to both neutral scheduled maintenance and the production `src/index.ts` scheduled flow. Preserve the trigger-first rule: do not re-add Managed Document workspace scanning to the five-minute production cron.

- [ ] **Step 6: Ensure structured logging excludes sensitive query content**

Query logs may contain only:

```text
scope_kind
projects_in_scope
filters_present
limit
hits_returned
freshness counts
duration_ms
final_state
```

Do not log raw `text`, snippets, body content, or tokens.

- [ ] **Step 7: Run GREEN verification**

```bash
npx vitest run test/search-worker.spec.ts test/scheduled-business-priority.spec.ts test/dropbox-change-guard.spec.ts
npm run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add src/index-neutral.ts src/index.ts test/search-worker.spec.ts
git commit -m "feat: expose project os search api"
```

---

## Task 9 — Prove provider neutrality, authority semantics, and high-risk regressions

**Files:**
- Create: `test/search-provider-neutral.spec.ts`
- Modify: `package.json` only if the high-risk test command must include new search tests
- Modify: `scripts/check-persistence-boundary.mjs` only if its existing import rules do not automatically cover `src/search/**`

**Interfaces:**
- No new runtime API; this is a boundary/verification gate.

- [ ] **Step 1: Add static provider-neutrality assertions**

Fail if any `src/search/**` core file imports:

```text
src/persistence/providers/dropbox/**
DropboxClient
DropboxApiError
DropboxConflictError
DropboxCursorResetError
```

Allow the existing provider-neutral `ProjectOsPersistenceRuntime`, `ObjectPersistence`, `ProjectRepository`, and `DocumentLedgerRepository`.

- [ ] **Step 2: Add authority negative tests**

Prove:

- generated `STATE.md`/`HANDOFF.md` text is not inserted as independent records;
- active INPUTS file presence alone cannot create a search row;
- unresolved MutationGate candidate cannot create a normal search row;
- a managed-document result resolves by `document_id`/`version_id`, never provider file ID;
- a canonical search hit includes canonical revision/entity identity;
- an archived project can be queried when explicitly scoped but search cannot mutate it.

- [ ] **Step 3: Add fail-closed search outage tests**

When SearchIndexGuard is unavailable/rebuilding, `POST /v1/search` returns explicit unavailable/unknown/lagging semantics. It must not call Dropbox/provider recursive listing as a fallback.

- [ ] **Step 4: Run full high-risk verification**

```bash
npm run types
npm run typecheck
npm run check:persistence-boundary
npm run check:production-promotion-authority
npm run check:mutation-gate-repair-workflow
npm run test:persistence-high-risk
npx vitest run test/search-contract.spec.ts test/search-canonical-records.spec.ts test/search-document-records.spec.ts test/search-project-sync.spec.ts test/search-index-store.spec.ts test/search-query.spec.ts test/search-rebuild.spec.ts test/search-worker.spec.ts test/search-provider-neutral.spec.ts
```

- [ ] **Step 5: Run the complete suite**

```bash
npm test
npm run check
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add test/search-provider-neutral.spec.ts package.json scripts/check-persistence-boundary.mjs
git commit -m "test: prove search authority boundaries"
```

Only include `package.json`/script files in the commit when their content actually changed.

---

## Task 10 — Document, deploy in read-only stages, prove production, then close canonically

**Files:**
- Create: `docs/search.md`
- Modify: `README.md`
- Modify: `docs/project-os-improvement-roadmap.md` only after production proof and canonical completion is ready
- Canonical Project OS changes: typed transactions only after the corresponding user approvals; never edit generated PRJ-0002 Markdown directly.

**Interfaces:**
- Operational/admin endpoints from Task 8.
- Deployment/version identity from existing Project OS continuity tooling.

- [ ] **Step 1: Write operator documentation before deployment**

`docs/search.md` must document:

- derived/non-authoritative nature of the index;
- `SearchIndexGuard` architecture;
- indexed/excluded content policy;
- explicit project scope rules;
- canonical/document watermarks and freshness states;
- rebuild flow and active/staging generations;
- failure semantics;
- admin rebuild/status endpoints;
- no-provider-scan fallback rule;
- logging/privacy rule;
- rollback rule: disabling/removing the search read path does not rewind canonical state.

Update README architecture/code map with `src/search/` and `SEARCH_INDEX_GUARD`.

- [ ] **Step 2: Re-run pre-deploy verification on the exact candidate commit**

```bash
npm run check
```

Record the exact candidate SHA and CI run. Do not deploy a different tree.

- [ ] **Step 3: Stage A — structural deployment only**

Deploy the exact candidate with the new Durable Object/binding and search internals present, but keep normal ChatGPT/operator retrieval on the existing path until validation completes.

Verify:

```text
/health = ok + exact deployment identity
SearchIndexGuard internal status reachable
existing transactions/documents/inbox/materialization remain healthy
no canonical revision changes caused solely by index startup
```

- [ ] **Step 4: Stage B — controlled rebuild/backfill**

Start rebuild for `PRJ-0002` and one real project with richer governed content. Poll admin status until complete. Validate canonical/document record counts, project isolation, zones, watermarks, and authoritative references.

- [ ] **Step 5: Stage C — shadow/read-only query proof**

Run known searches covering:

```text
exact task/decision/research IDs
canonical title search
full-text governed reference/document search
WORKING vs REVIEW vs DELIVERABLES labels
two-project explicit portfolio scope
negative project leakage
negative INPUTS hit
negative MutationGate candidate hit
binary metadata-only hit
```

For representative hits, fetch the authoritative canonical/document source and prove IDs/hash/version match the result.

- [ ] **Step 6: Stage D — incremental/lag/recovery proof**

In controlled production-safe fixtures/probes:

- commit a canonical additive change and prove search becomes current without blocking its receipt;
- create/update a governed document and prove the exact `document_id` updates;
- inject/observe a search synchronization failure and prove canonical/document authority remains valid while freshness reports lag;
- recover and prove replay converges idempotently;
- rebuild a project while its previous generation remains queryable;
- prove a changed source watermark prevents stale staging promotion.

- [ ] **Step 7: Enable normal read path only after proof gate**

After exact-commit health + shadow proof + incremental/rebuild proof are green, allow normal Project OS retrieval to use `POST /v1/search`. This is a read-path enablement only; no business mutation semantics change.

- [ ] **Step 8: Canonical closure gate**

Before any canonical closure mutation, refresh PRJ-0002 `HANDOFF.md` and `STATE.md`. Then, only with explicit user acceptance, create the appropriate typed research/evidence and task completion/decision transactions referencing:

- exact deployed GitHub commit;
- CI evidence;
- production health evidence;
- rebuild proof;
- isolation proof;
- incremental/lag recovery proof;
- authoritative-reference proof.

Require committed receipts before claiming INDEX001 complete.

- [ ] **Step 9: Update the authoritative roadmap after committed closure**

Only after INDEX001 is canonically and production-validly complete, update `docs/project-os-improvement-roadmap.md` to mark INDEX001 complete and confirm the next sequenced package remains `IMP-OBSERVE001`, subject to the required downstream revalidation rule from `DEC-IMPPROGRAM001`.

- [ ] **Step 10: Final documentation commit**

```bash
git add docs/search.md README.md docs/project-os-improvement-roadmap.md
git commit -m "docs: document project os search model"
```

Do not include the roadmap file until the production/canonical completion gate is actually satisfied.

---

## Plan self-review checklist

### Spec coverage

- Structured canonical read model: Tasks 1, 4, 6.
- Lexical FTS5 search: Tasks 4, 5.
- Explicit project/portfolio scope and SQL-level isolation: Tasks 1, 5, 8.
- Stable Managed Document identity/current heads: Task 2.
- INPUTS and MutationGate candidate exclusions: Tasks 2, 9.
- Binary metadata-only behavior: Tasks 2, 9.
- Incremental canonical/document synchronization: Tasks 3, 6.
- Durable outbox/replay: Tasks 3, 6.
- Canonical/document separate freshness: Tasks 3, 6, 8.
- Rebuild from authoritative truth: Task 7.
- Active/staging generation safety and resumability: Task 7.
- Provider neutrality: Tasks 2, 6, 9.
- No vector/OCR/external search complexity: Global constraints + Task 9.
- Observability without content leakage: Tasks 8, 10.
- Production proof and canonical closure: Task 10.

### Type consistency

- `project_id`, `record_id`, `document_id`, `version_id` remain Project OS logical identity fields.
- Canonical synchronization uses full `CanonicalSnapshotRequest` and may coalesce revisions safely.
- Document synchronization uses ordered `DocumentBatchRequest`; partial batches are contiguous within one epoch, new epochs require full snapshots.
- ProjectGuard is source authority for requested/indexed synchronization acknowledgement; SearchIndexGuard owns derived index watermarks/generations.
- SearchIndex active generation is per-project even though the Durable Object is installation-scoped.

### Placeholder scan

This plan intentionally contains no `TBD`, no `TODO`, no unspecified “handle errors” steps, and no implementation step that depends on an undefined function/type. Any implementation discovery that contradicts these locked interfaces requires stopping and revalidating the plan before changing architecture.

## Execution gate

This plan is a planning artifact only. **Do not start Task 1 until the founder explicitly approves this implementation plan and Project OS records/authorizes the implementation start through its normal typed-transaction gates.**
