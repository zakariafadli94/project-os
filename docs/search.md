# Project OS search

> IMP-INDEX001 production-completion remediation candidate. The deployed baseline already contains the derived search subsystem, manual-only production deployment, and a fail-closed public read gate. This branch adds a separate fail-closed synchronization gate and an authenticated operator-only shadow query surface. It does **not** authorize merge, deployment, rebuild/backfill, production wake/sync, public read activation, or canonical closure.

## Authority model

Search is a **derived, reconstructible, non-canonical read model**. It never becomes a second source of truth and never authorizes a business mutation. Canonical project state, immutable events, receipts, managed-document ledgers and governed artifacts remain authoritative in their existing stores.

Every search query is explicitly project-scoped. `project_ids` is required and validated before query execution; callers cannot obtain an account-wide implicit search by omitting project scope. Project filtering is applied inside the search query before ranking.

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
- `src/search/read-mode.ts` — public read-path kill switch.
- `src/search/sync-mode.ts` — derived synchronization kill switch.
- `src/durable/project-guard-search-sync.ts` — ProjectGuard-side delta scheduling after canonical/document changes.
- `src/durable/search-sync-guard.ts` — isolated bounded retry/serialization for derived synchronization.

`ProjectGuard` remains the per-project coordination boundary. Search synchronization is downstream derived work: a search-sync failure must not roll back or reinterpret an already committed canonical business revision.

## Independent production gates

Search read authority and search synchronization authority are intentionally separate.

`PROJECT_OS_SEARCH_READ_MODE` controls only normal public retrieval through `POST /v1/search`:

- exact `on` enables the public search route;
- absent, `off`, or any other value fails closed with `404` before the public search handler runs.

`PROJECT_OS_SEARCH_SYNC_MODE` controls only derived incremental synchronization and maintenance reconciliation:

- exact `on` permits derived search reconciliation, ProjectGuard search side-effect scheduling, SearchSyncGuard wake, drain, and retry alarms;
- absent, `off`, or any other value is fail-closed;
- while off, `reconcileSearchIndexes()` returns an inert zero-work summary before reading the registry or touching search Durable Objects;
- ProjectGuard does not advance requested search watermarks, restart a document epoch, schedule a wake, or drain derived sync while off;
- SearchSyncGuard does not arm a wake and an already-fired/stale alarm exits without contacting ProjectGuard or scheduling another retry.

Production configuration starts with **both modes off**. Enabling synchronization for controlled production proof does not implicitly enable the public read path. Enabling the public read path is a later, separate exact-commit deployment gate.

Inbox processing, materialization reconciliation and Managed Document reconciliation are not controlled by `PROJECT_OS_SEARCH_SYNC_MODE` and remain operational independently.

## Public search

Authenticated normal search uses:

```text
POST /v1/search
Authorization: Bearer <INGRESS_TOKEN>
```

The request must include a non-empty explicit `project_ids` set. The implementation bounds scope, query text, lexical terms and result count. Unknown scoped projects are rejected before the index query.

The response contains `hits` plus one freshness record per explicitly scoped project. Search results are references to authority; callers that need authoritative content should resolve the returned canonical entity or governed document identity rather than treating the index row itself as truth.

## Operator shadow search

Task 10 shadow-query proof does not require enabling the public read path. Authenticated operators use the distinct admin surface:

```text
POST /v1/admin/search/shadow
Authorization: Bearer <INGRESS_TOKEN>
Content-Type: application/json
```

The request and response contracts are the same project-scoped search contracts used by normal search, including bounded scope and freshness. The route is intentionally separate from `POST /v1/search`, so public read mode may remain `off` throughout shadow proof.

The shadow route is read-only derived-state inspection. It creates no canonical authority, performs no provider fallback scan, does not trigger sync/rebuild as a side effect, and must not log raw query text, result snippets, document bodies, secrets or provider tokens.

## Freshness

Canonical freshness and document freshness are separate dimensions and use separate requested/indexed watermarks:

- `canonical_revision_requested` / `canonical_revision_indexed`;
- `document_generation_requested` / `document_generation_indexed`;
- managed-document epoch identity (`document_epoch`, `document_epoch_started_at`) where applicable.

Freshness state is one of:

- `current` — canonical and document frontiers have caught up to requested source state;
- `lagging` — at least one frontier is behind but no failure is currently recorded;
- `rebuilding` — a staged rebuild is active while the last proven active generation remains queryable;
- `failed` — requested state is behind and source/index error evidence exists;
- `unknown` — source/index state or an active generation is unavailable, so freshness cannot be asserted.

A canonical watermark never proves document freshness, and a document watermark never proves canonical freshness.

## Rebuild and generations

Rebuild is reconstructible from authoritative canonical state and current governed document heads. It stages a new per-project generation while keeping the last proven active generation queryable. Promotion occurs only after the staged generation completes and source watermarks remain valid; a failed or incomplete staging generation cannot silently replace the active generation.

Search-index loss does not rewrite canonical history or Managed Document state. Recovery is a derived-state rebuild, not a business-state migration.

The rebuild admin route remains a separate explicit operator action; `PROJECT_OS_SEARCH_SYNC_MODE=off` prevents background reconciliation/wake/sync but does not silently convert the rebuild endpoint into a cron action. Production rebuild/backfill still requires its own authorization gate.

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

The status response exposes source synchronization state, index state and rebuild state for the requested project. With sync mode off, reading source search status is observational: it must not request new canonical synchronization or wake SearchSyncGuard.

## Failure semantics

- Canonical commits and governed document authority remain valid when search synchronization fails or is disabled.
- Search lag/failure is surfaced through explicit freshness/status state.
- Query failure does not trigger a recursive provider scan fallback.
- Rebuild failure leaves the previous proven active generation in place.
- Derived sync/rebuild retries remain isolated from ProjectGuard canonical correctness.
- Turning sync mode off stops new derived wake/drain/retry work without changing canonical or Managed Document state.

## Provider boundary

Search code depends on provider-neutral persistence interfaces. `scripts/check-persistence-boundary.mjs` explicitly fails if `src/search/**` imports Dropbox integration code from `persistence/providers/dropbox` or `webhook/dropbox`.

The search subsystem does not use embeddings, vector search, OCR, an external search service, or provider-native search APIs. The accepted implementation is deterministic SQLite FTS5 plus structured authority metadata.

## Logging and privacy

Operational logs may include safe project/generation/revision/version identifiers, counters, statuses and bounded error metadata. They must not emit raw search query text, document bodies/snippets, secrets, provider tokens or sensitive payload content.

The operator shadow endpoint adds no query logging of its own.

## Rollback rule

Public read rollback is configuration-only: return `PROJECT_OS_SEARCH_READ_MODE` to `off` and deploy the exact reviewed commit. This does not rewind, delete or reinterpret canonical state.

Derived synchronization rollback is independent: return `PROJECT_OS_SEARCH_SYNC_MODE` to `off`. Any stale SearchSyncGuard alarm becomes inert when it fires and does not re-arm. Search/index state remains disposable derived state and may later be reconstructed from durable truth without changing business revisions or governed-document authority.

## Verification

Targeted INDEX001 regression suite:

```bash
npm run test:index001
```

Provider boundary:

```bash
npm run check:persistence-boundary
```

Persistence high-risk suite:

```bash
npm run test:persistence-high-risk
```

Full repository verification:

```bash
npm test
npm run check
npx wrangler deploy --dry-run
```

`check:index001-remediation` statically requires manual-only production deployment, public read mode off, sync mode off, bounded Workers observability, fail-closed fleet/ProjectGuard/SearchSyncGuard sync controls, and the authenticated operator shadow route.

Passing these checks proves the branch candidate only; it does not constitute production proof or canonical completion.

## Production gates still required after merge authorization

The production-completion sequence remains separate from branch implementation:

1. merge only an explicitly authorized, fully green exact candidate;
2. manually deploy the authorized exact release with both read and sync modes initially off;
3. verify exact identity/health and that scheduled search reconciliation is inert;
4. separately authorize and deploy sync mode `on` while public read remains `off`;
5. perform the controlled `PRJ-0002` plus one rich-project rebuild/backfill and validate status/counts/authority;
6. run shadow queries through `/v1/admin/search/shadow` while public read remains off;
7. prove incremental synchronization, lag/failure semantics, recovery/replay and generation safety;
8. only then separately authorize public read mode `on` and validate representative production retrieval;
9. record production evidence and close `TASK-IMPINDEX001` canonically only after a committed Project OS receipt;
10. only after INDEX001 closure consider the next sequenced package.

None of those production mutations are executed by this branch candidate.
