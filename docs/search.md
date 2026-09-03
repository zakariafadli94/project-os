# Project OS search

> IMP-INDEX001 pre-merge candidate. This document describes the branch implementation only. The feature is **not merged, not deployed, not production-rebuilt, and not activated as a production read path** until the separate gates in the accepted INDEX001 plan are satisfied.

## Authority model

Search is a **derived, reconstructible, non-canonical read model**. It never becomes a second source of truth and never authorizes a business mutation. Canonical project state, immutable events, receipts, managed-document ledgers and governed artifacts remain authoritative in their existing stores.

Every public search query is explicitly project-scoped. `project_ids` is required and validated before query execution; callers cannot obtain an account-wide implicit search by omitting project scope.

Search records carry logical authority references. Canonical entities use project/entity/revision identity. Managed documents use `document_id` and `version_id`; provider file IDs are not public document identity.

## Corpus

The normal corpus is assembled from authoritative structured records and governed managed-document versions. It intentionally excludes:

- active `INPUTS/` files, which are source-ingestion work rather than accepted knowledge;
- unresolved MutationGate candidates;
- generated Markdown duplicates when the same fact is already represented by structured canonical state;
- provider transport metadata as semantic identity.

There is no recursive Dropbox scan fallback. If the derived index is missing or stale, the supported response is repair/rebuild from authoritative records, not a broad provider crawl.

## Components

- `src/search/contract.ts` — query/result contract and explicit project-scope validation.
- `src/search/canonical-records.ts` — canonical structured entities → search records.
- `src/search/document-records.ts` — governed managed-document versions → search records.
- `src/search/project-sync-store.ts` — per-project derived synchronization state.
- `src/search/sqlite-store.ts` — SQLite/FTS5 index storage.
- `src/search/query-compiler.ts` — deterministic query compilation and ranking inputs.
- `src/search/search-index-guard.ts` — index mutation/query boundary.
- `src/search/rebuild.ts` — reconstructible rebuild path from authoritative inputs.
- `src/durable/project-guard-search-sync.ts` — ProjectGuard-side delta scheduling after canonical/document changes.
- `src/durable/search-sync-guard.ts` — isolated retry/serialization for derived synchronization.

`ProjectGuard` remains the per-project coordination boundary. Search synchronization is downstream derived work: a search-sync failure must not roll back or reinterpret an already committed canonical business revision.

## Freshness

Canonical freshness and document freshness are separate dimensions.

- Canonical records are keyed to canonical project revision/event progress.
- Managed-document records are keyed to governed document/version progress.

A result must not imply that one freshness clock proves the other. Rebuild/synchronization state records these frontiers independently so operators can diagnose whether canonical state, document state, or both need catch-up.

## Rebuild and activation

Rebuild creates a new derived generation from authoritative sources, verifies it, then makes that generation eligible for activation. A failed/incomplete generation cannot silently replace the current usable generation.

Production rebuild/backfill and production read-path activation are separate operational gates. This implementation branch contains the mechanisms and tests but this pre-merge mandate does not execute those production actions.

## Provider boundary

Search code depends on provider-neutral persistence interfaces. `scripts/check-persistence-boundary.mjs` explicitly fails if `src/search/**` imports provider implementations under `persistence/providers/**`.

The search subsystem does not use embeddings, vector search, OCR, or an external search service. The accepted implementation is deterministic SQLite FTS5 plus structured authority metadata.

## Logging and sensitive data

Operational logs should identify project/generation/revision/version and safe counters/statuses, not search content, document bodies, secrets, provider tokens, or raw sensitive payloads.

## Verification

Targeted INDEX001 regression suite:

```bash
npm run test:index001
```

Provider boundary:

```bash
npm run check:persistence-boundary
```

Persistence high-risk suite (includes the INDEX001 authority/rebuild/worker regressions):

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
