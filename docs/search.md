# Project OS search

> IMP-INDEX001 pre-merge candidate. This document describes the branch implementation only. The feature is **not merged, not deployed, not production-rebuilt, and not activated as a production read path** until the separate gates in the accepted INDEX001 plan are satisfied.

## Authority model

Search is a **derived, reconstructible, non-canonical read model**. It never becomes a second source of truth and never authorizes a business mutation. Canonical project state, immutable events, receipts, managed-document ledgers and governed artifacts remain authoritative in their existing stores.

Every public search query is explicitly project-scoped. `project_ids` is required and validated before query execution; callers cannot obtain an account-wide implicit search by omitting project scope. Project filtering is applied inside the search query before ranking.

Search records carry logical authority references. Canonical entities use project/entity/revision identity. Managed documents use `document_id` and `version_id`; provider file IDs are not public document identity.

## Corpus

The normal corpus is assembled from authoritative structured records and governed managed-document versions. It intentionally excludes:

- active `INPUTS/` files, which are source-ingestion work rather than accepted knowledge;
- unresolved MutationGate candidates;
- generated Markdown duplicates such as `STATE.md`, `HANDOFF.md`, roadmap/entity projections when the same fact is already represented by structured canonical state;
- provider transport metadata as semantic identity.

Governed `REFERENCES/`, `WORKING/`, `REVIEW/` and `DELIVERABLES/` current heads are eligible according to their lifecycle state. Binary or opaque governed content is metadata-only in INDEX001; no OCR or generalized extraction is added.

There is **no recursive Dropbox/provider scan fallback**. If the derived index is missing or unavailable, search fails closed and operators repair/rebuild from authoritative records instead of crawling the provider.

## Components

- `src/search/contract.ts` — query/result contract and explicit project-scope validation.
- `src/search/canonical-records.ts` — canonical structured entities → search records.
- `src/search/document-records.ts` — governed managed-document versions → search records.
- `src/search/project-sync-store.ts` — per-project derived synchronization state.
- `src/search/project-synchronizer.ts` — source snapshot delivery to the index.
- `src/search/sqlite-store.ts` — SQLite/FTS5 index storage and project-scoped query execution.
- `src/search/query-compiler.ts` — deterministic bounded lexical query compilation.
- `src/search/search-index-guard.ts` — installation-scoped `SearchIndexGuard` mutation/query/rebuild boundary.
- `src/search/rebuild.ts` — reconstructible staged rebuild from authoritative inputs.
- `src/durable/project-guard-search-sync.ts` — ProjectGuard-side delta scheduling after canonical/document changes.
- `src/durable/search-sync-guard.ts` — isolated retry/serialization for derived synchronization.

`ProjectGuard` remains the per-project coordination boundary. Search synchronization is downstream derived work: a search-sync failure must not roll back or reinterpret an already committed canonical business revision.

## Public search

Authenticated search uses:

```text
POST /v1/search
Authorization: Bearer <INGRESS_TOKEN>
```

The request must include a non-empty explicit `project_ids` set. The implementation bounds scope, query text, lexical terms and result count. Unknown scoped projects are rejected before the index query.

The response contains `hits` plus one freshness record per explicitly scoped project. Search results are references to authority; callers that need authoritative content should resolve the returned canonical entity or governed document identity rather than treating the index row itself as truth.

## Freshness

Canonical freshness and document freshness are separate dimensions and use separate requested/indexed watermarks:

- `canonical_revision_requested` / `canonical_revision_indexed`;
- `document_generation_requested` / `document_generation_indexed`;
- managed-document epoch identity (`document_epoch`, `document_epoch_started_at`) where applicable.

Public freshness state is one of:

- `current` — canonical and document frontiers have caught up to requested source state;
- `lagging` — at least one frontier is behind but no failure is currently recorded;
- `rebuilding` — a staged rebuild is active while the last proven active generation remains queryable;
- `failed` — requested state is behind and source/index error evidence exists;
- `unknown` — source/index state or an active generation is unavailable, so freshness cannot be asserted.

A canonical watermark never proves document freshness, and a document watermark never proves canonical freshness.

## Rebuild and generations

Rebuild is reconstructible from authoritative canonical state and current governed document heads. It stages a new per-project generation while keeping the last proven active generation queryable. Promotion occurs only after the staged generation completes and source watermarks remain valid; a failed or incomplete staging generation cannot silently replace the active generation.

Search-index loss does not rewrite canonical history or Managed Document state. Recovery is a derived-state rebuild, not a business-state migration.

## Admin operations

Authenticated rebuild request:

```text
POST /v1/admin/search/rebuild
Authorization: Bearer <INGRESS_TOKEN>
Content-Type: application/json

{"project_ids":["PRJ-0002"]}
```

The project list must be explicit, valid, unique and registered. The route starts project-scoped rebuild work and returns `202` when accepted.

Authenticated status read:

```text
GET /v1/admin/search/status?project_id=PRJ-0002
Authorization: Bearer <INGRESS_TOKEN>
```

The status response exposes source synchronization state, index state and rebuild state for the requested project. These endpoints are operational controls only; they do not mutate canonical business state.

## Failure semantics

- Canonical commits and governed document authority remain valid when search synchronization fails.
- Search lag/failure is surfaced through explicit freshness/status state.
- Query failure does not trigger a recursive provider scan fallback.
- Rebuild failure leaves the previous proven active generation in place.
- Derived sync/rebuild retries remain isolated from ProjectGuard canonical correctness.

## Provider boundary

Search code depends on provider-neutral persistence interfaces. `scripts/check-persistence-boundary.mjs` explicitly fails if `src/search/**` imports Dropbox integration code from `persistence/providers/dropbox` or `webhook/dropbox`.

The search subsystem does not use embeddings, vector search, OCR, an external search service, or provider-native search APIs. The accepted implementation is deterministic SQLite FTS5 plus structured authority metadata.

## Logging and privacy

Operational logs may include safe project/generation/revision/version identifiers, counters, statuses and bounded error metadata. They must not emit raw search query text, document bodies/snippets, secrets, provider tokens or sensitive payload content.

## Rollback rule

Disabling or removing the search read path does **not** rewind, delete or reinterpret canonical state. Search/index state is disposable derived state. A rollback may stop query/sync/rebuild use and later reconstruct the index from durable truth without changing business revisions or governed-document authority.

## Verification

Targeted INDEX001 regression suite:

```bash
npm run test:index001
```

Provider boundary:

```bash
npm run check:persistence-boundary
```

Persistence high-risk suite (runs the persistence boundary and includes INDEX001 synchronization/rebuild/worker/provider-neutral regressions):

```bash
npm run test:persistence-high-risk
```

Full repository verification:

```bash
npm test
npm run check
```

The pull-request CI also performs a Wrangler dry-run. Passing these checks proves the pre-merge branch candidate only; it does not constitute production proof or canonical completion.

## Production gates still required after merge authorization

The accepted plan keeps the following steps separate from branch implementation:

1. merge the reviewed exact candidate to `main`;
2. deploy the authorized exact release;
3. perform the controlled production search rebuild/backfill;
4. verify production corpus, scope, freshness and authority invariants;
5. activate the production read path only under its explicit gate;
6. record production proof and close `TASK-IMPINDEX001` canonically only after a committed Project OS receipt;
7. only then consider the next sequenced improvement package.

None of those gates are executed by the pre-merge candidate described here.
