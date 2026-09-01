# IMP-INDEX001 — Fast read/search model design

Status: direction approved by founder; written specification pending founder review
Date: 2026-09-01
Project: PRJ-0002 — Project OS

Validated against:

- canonical PRJ-0002 revision `129`;
- GitHub `main` commit `8099f838df84f5596bdb118d6e1687e123deb50a`;
- authoritative roadmap `docs/project-os-improvement-roadmap.md`;
- current production architecture after `IMP-INPUTLIFECYCLE001`.

This document authorizes design/specification only. It does **not** authorize runtime implementation, deployment, schema migration, production rollout, or canonical Project OS mutation beyond separately approved typed Project OS transactions.

## 1. Problem

Project OS now has reliable canonical business state, governed Managed Documents, incremental materialization, provider-neutral persistence, schema compatibility, stable document identity, a Mutation Gate, project-session isolation, and a trigger-first `INPUTS -> REFERENCES` lifecycle.

Read/search behavior has not yet caught up with that architecture.

A cross-project research request can still require repeated provider listing, recursive discovery, file-by-file reads, or reconstruction of context from generated Markdown. That is acceptable at small scale, but it is the wrong long-term read model for a product-grade system.

The problem is not that Dropbox cannot search files. The problem is that Project OS needs to search **Project OS meaning**:

- projects;
- tasks and phases;
- decisions;
- research;
- constraints;
- deliverables;
- governed references;
- governed collaborative documents;
- lifecycle status;
- project ownership;
- stable logical identities;
- authoritative provenance.

A provider-native file search does not know those semantics and would couple future product behavior back to Dropbox-specific storage details.

`IMP-INDEX001` therefore introduces a derived read/search model that is fast, incrementally maintained, project-isolated, reconstructible from durable truth, and able to return authoritative Project OS references rather than treating search output as a new source of truth.

## 2. Design objective

The target behavior is:

> Search Project OS meaning quickly, then retrieve authoritative Project OS content only for the results that matter.

The first version must provide:

1. structured lookup/filtering across canonical project entities;
2. lexical full-text search across relevant governed text content;
3. incremental updates after canonical and Managed Document changes;
4. explicit index freshness/lag semantics;
5. deterministic rebuild from authoritative durable state;
6. project isolation by construction;
7. stable result references using Project OS identities;
8. no recursive Dropbox/provider scan in normal query execution.

The initial priority remains the master roadmap requirement: **structured and lexical full-text quality before optional vector-search complexity**.

## 3. Baseline and dependencies

### 3.1 `IMP-MODEL001`

Satisfied prerequisite.

Canonical commit records are immutable business history. `ProjectState` is the current aggregate. Generated Markdown, materialization snapshots, heads, and indexes are derived representations and must remain reconstructible.

INDEX001 must not create a second business truth.

### 3.2 `IMP-MATERIAL001`

Satisfied prerequisite and architectural pattern.

Materialization already proves the important separation:

```text
canonical commit
  -> asynchronous derived work
  -> explicit progress/head
  -> reconstructible projection
```

INDEX001 follows the same principle:

```text
authoritative Project OS state/content
  -> asynchronous index work
  -> explicit indexed watermarks
  -> reconstructible read model
```

Index failure must never invalidate a canonical business commit.

### 3.3 `IMP-PERSIST001`

Satisfied prerequisite.

INDEX001 must operate above the provider-neutral persistence boundary. No index identity, query rule, or read-model contract may depend on Dropbox `file_id`, Dropbox `rev`, Dropbox HTTP behavior, or raw Dropbox search APIs.

Dropbox remains the only production persistence provider, but INDEX001 is a Project OS read subsystem, not a Dropbox feature.

### 3.4 `IMP-SCHEMA001`

Satisfied prerequisite.

Production currently uses the provider-v2 schema stage. INDEX001 may define its own **derived index storage schema**, but it does not bump canonical `ProjectState`, transaction, Managed Document, or business schema versions.

The index schema is disposable/rebuildable technical state.

### 3.5 `IMP-DOCIDENTITY001`

Satisfied prerequisite and critical identity dependency.

Managed Markdown now exposes the authoritative stable `document_id`. Search results must use this logical identity rather than provider object identity.

WORKING -> REVIEW -> DELIVERABLES preserves the same `document_id`, allowing the search model to represent one logical document whose current lifecycle location can change without creating a false new identity.

### 3.6 `IMP-INPUTLIFECYCLE001`

Satisfied prerequisite.

`INPUTS/` is an active ingress zone. It is not a knowledge base and must not be treated as normal searchable governed content.

A source becomes normal searchable reference content only after the governed reference lifecycle has reached a safe terminal state.

### 3.7 MutationGate

Satisfied prerequisite.

Unknown final-zone provider files and unresolved external mutation candidates must not become normal search truth merely because they physically exist.

INDEX001 consumes governed state only.

### 3.8 Project-session isolation

Satisfied prerequisite.

A `PROJECT_SESSION` remains bound to one project unless the user explicitly requests a switch. Search must preserve this rule.

A cross-project query is a distinct explicit scope, not an implicit rebind.

## 4. Non-goals

INDEX001 does **not**:

- introduce embeddings or vector search;
- add an LLM reranker;
- add OCR or generalized PDF extraction;
- index arbitrary binary body content;
- make Dropbox search part of the Project OS business architecture;
- crawl `WORKSPACE/` recursively for every query;
- make generated Markdown projections authoritative;
- index unresolved MutationGate candidates as normal content;
- index active `INPUTS/` objects as governed knowledge;
- create a new business schema version;
- introduce multi-tenant SaaS infrastructure;
- replace the canonical repository, Managed Document ledger, or immutable commit history;
- define final product SLOs or large-scale capacity guarantees — those remain owned by `IMP-PERF001`;
- define the final security/credential model — that remains owned by `IMP-SECURITY001`;
- silently fall back to recursive provider scans if the index is unavailable.

## 5. Core principles

### 5.1 Search is derived state

The index is a cache/read model.

It may be deleted completely without loss of canonical truth.

Project OS must be able to reconstruct it from:

- canonical project state/history;
- current governed Managed Document/reference heads;
- immutable governed text payloads and metadata required by those heads.

### 5.2 Search results are references, not authority

A search hit identifies relevant Project OS material. It does not supersede the underlying source.

Every result must preserve enough identity/provenance for a caller to fetch or verify the authoritative source.

### 5.3 Provider-neutral above the persistence boundary

Search does not understand Dropbox IDs, Dropbox revisions, Dropbox folder search syntax, or Dropbox-specific errors.

Provider evidence may be retained as diagnostics elsewhere, but it is not part of search identity.

### 5.4 Project isolation is enforced before ranking

Every indexed row carries `project_id`.

Every normal query has an explicit project scope.

Project filtering occurs inside SQL/query execution, not as post-processing after a global result set is generated.

### 5.5 Normal queries never require a full provider scan

A query hits the read model first.

A caller may then fetch a small number of authoritative source records/files for selected results.

### 5.6 Freshness is explicit

Project OS must not present stale index state as certainly current.

Search responses expose indexed watermarks and lag state.

### 5.7 No hidden complexity escalation

The first release uses deterministic structured filters and SQLite FTS5 lexical search.

Semantic/vector retrieval is deferred until measured need justifies it.

## 6. Options considered

### Option A — Use Dropbox/provider search directly

Rejected.

Advantages:

- low initial implementation effort;
- provider already indexes some file content.

Problems:

- provider-specific coupling returns to Project OS Core;
- poor understanding of canonical entities and lifecycle;
- generated projections and governed content become difficult to distinguish;
- project isolation and authority semantics become application-side heuristics;
- future providers would require different search behavior;
- normal cross-project research remains dependent on provider capabilities and download behavior.

### Option B — Introduce an external search product now

Examples would include Elasticsearch/OpenSearch, Algolia, Typesense, Meilisearch, or a managed vector/search service.

Deferred.

Advantages:

- mature indexing/search features;
- independent scaling potential.

Problems:

- introduces another external service, deployment surface, secret set, cost model, recovery path, and failure domain before Project OS has measured a need;
- conflicts with the roadmap goal of sequencing complexity only when justified;
- makes isolated client installations materially heavier.

### Option C — Installation-scoped SQLite-backed Durable Object with FTS5

**Recommended.**

Cloudflare Durable Objects already exist in the Project OS runtime. SQLite-backed Durable Objects support transactional SQL and the FTS5 module. Cloudflare currently recommends SQLite-backed Durable Objects for new Durable Object classes.

The initial client model is an isolated Project OS installation, not shared multi-tenant SaaS. A single installation-scoped search object therefore gives simple cross-project querying without fan-out across hundreds of project-specific objects.

The storage/query backend remains hidden behind a search/read-model interface so `IMP-PERF001` can later introduce sharding or a different backend if measured scale requires it.

## 7. Target architecture

### 7.1 High-level shape

```text
Canonical ProjectState / commit history
              |
              | structured index jobs
              v
        ProjectGuard(s)
              |
              +------------------------------+
              |                              |
Managed Document/reference heads             |
and governed payloads                        |
              | document index jobs           |
              v                              v
        ProjectGuard(s) --------------> SearchIndexGuard
                                      (global installation instance)
                                              |
                                              v
                                      SQLite structured tables
                                      + FTS5 lexical index
                                              |
                                              v
                                         SearchService
                                              |
                             +----------------+----------------+
                             |                                 |
                       project scope                    explicit portfolio scope
                             |                                 |
                             +----------------+----------------+
                                              |
                                              v
                                      authoritative references
                                              |
                                              v
                           selective canonical/document fetch by caller
```

### 7.2 `SearchIndexGuard`

Introduce a new SQLite-backed Durable Object class, conceptually named:

```text
SearchIndexGuard
```

The ordinary production instance is installation-scoped and addressed by a fixed internal name such as:

```text
global
```

The class owns only derived search state.

It does not own:

- business mutations;
- canonical project revisions;
- Managed Document authority;
- project lifecycle authority;
- provider mutation authority.

### 7.3 Why one installation-scoped object initially

A single object is the simplest way to support true cross-project ranking/filtering without querying one Durable Object per project.

This matches the current product strategy:

```text
Client A -> isolated Project OS installation A
Client B -> isolated Project OS installation B
```

It is not intended as the final answer for future shared SaaS or arbitrarily large installations.

Cloudflare currently documents a 10 GB storage limit per SQLite-backed Durable Object on paid plans and a soft throughput limit for an individual Durable Object. `IMP-PERF001` must measure real storage/query/update behavior before any sharding decision.

INDEX001 therefore requires a backend interface that does not expose “one Durable Object” as a product contract.

## 8. Read-model storage

The exact table names may be refined in implementation planning, but the logical model is fixed.

### 8.1 Index schema version

The SQLite database tracks an internal derived-state schema version, beginning at:

```text
search_index_schema_version = 1
```

An incompatible future search-index schema may be rebuilt from durable truth. It does not require rewriting canonical Project OS data.

### 8.2 Project index heads

Each indexed project has a search head containing at least:

```text
project_id
active_generation
canonical_revision_requested
canonical_revision_indexed
document_generation_requested
document_generation_indexed
rebuild_state
last_error?
updated_at
```

The exact document-generation representation is technical hot state, not business truth.

### 8.3 Structured entity records

Structured entity rows represent the current searchable state of canonical entities.

Required fields include at least:

```text
project_id
index_generation
record_id
record_kind = canonical_entity
entity_type
entity_id
title
status?
phase_id?
updated_at?
canonical_revision
search_text
content_hash
```

`record_id` is deterministic from Project OS logical identity and must not contain provider IDs.

### 8.4 Managed document/reference records

Current governed document/reference heads use at least:

```text
project_id
index_generation
record_id
record_kind = managed_document
document_id
version_id
logical_path
zone
stage_or_collection
title
mime_type
body_text?
content_hash
authority_kind
source_revision_or_generation?
updated_at?
```

`document_id` is the logical identity.

`version_id` identifies the exact indexed current version.

`logical_path` is a current navigation reference, not identity.

### 8.5 FTS5 virtual table

Text-searchable records are mirrored into an FTS5 virtual table.

Conceptually it contains indexed text columns such as:

```text
title
body/search_text
```

and unindexed routing/provenance columns such as:

```text
project_id
record_id
index_generation
record_kind
```

All project-scope constraints are applied inside the SQL query.

### 8.6 Generated canonical Markdown is not separately indexed

Files such as generated:

- `STATE.md`;
- `HANDOFF.md`;
- `ROADMAP.md`;
- generated `TASKS/`;
- generated `DECISIONS/`;
- generated `RESEARCH/`;
- generated `CONSTRAINTS/`;

are derived human views of canonical entities.

Indexing both the structured canonical record and its generated Markdown would produce duplicate search hits and encourage consumers to treat the projection as authority.

Therefore canonical generated projections are excluded as independent full-text records.

The canonical entity itself is indexed structurally and lexically from its authoritative state representation.

## 9. Indexed content policy

### 9.1 Canonical entities — indexed

Index current searchable forms of:

- project metadata/objective where present in canonical state;
- phases;
- tasks;
- decisions;
- research;
- constraints;
- deliverables.

Historical immutable commit records remain available as canonical history but are not individually inserted into ordinary search results in INDEX001.

A later explicit historical-search mode can be added if real usage proves it necessary.

### 9.2 `REFERENCES/` — indexed after governed terminal ingestion

Governed references are searchable after intake reaches a safe terminal state in which the durable governed reference representation is established.

Normal index policy must not expose the original active `INPUTS/` copy as a separate hit.

### 9.3 `WORKING/` — indexed

The current governed logical head is searchable and clearly labeled `WORKING`.

Search results must not imply that a working draft is accepted or published.

### 9.4 `REVIEW/` — indexed

The current governed logical head is searchable and clearly labeled `REVIEW`.

Search results must preserve that it is a review candidate, not a published deliverable merely because its text matches strongly.

### 9.5 `DELIVERABLES/` — indexed

Governed current published/approved document heads are searchable and clearly labeled `DELIVERABLES`.

### 9.6 `INPUTS/` — excluded from normal search

Visible active inputs are not normal governed knowledge.

They may later be exposed through a dedicated operational “pending inputs” surface, but they do not participate in normal research/search ranking in INDEX001.

### 9.7 MutationGate candidates — excluded from normal search

Unknown/unresolved external mutation candidates are preserved evidence, not governed truth.

They remain invisible to normal search until explicitly adopted through the correct governed flow.

### 9.8 Binary/opaque documents — metadata only

INDEX001 does not add generalized content extraction.

For a binary or opaque governed document, search may index metadata that is already authoritative and safely available, such as:

- title/logical path;
- document identity;
- lifecycle zone;
- declared type;
- relevant governed metadata.

Body-text extraction is deferred.

## 10. Search scope and session semantics

### 10.1 Explicit scope is mandatory

The internal/public search contract never interprets a missing scope as “search everything”.

Conceptually a request carries one of:

```text
project scope:
  project_id = PRJ-xxxx

portfolio scope:
  explicit project_id set
```

### 10.2 PROJECT_SESSION default

A chat bound to one project searches that project by default.

Mentioning another project in natural-language query text does not itself change session binding.

### 10.3 Portfolio/cross-project search

A cross-project search requires explicit user intent such as:

- “cherche dans tous mes projets”;
- “compare PRJ-0002 et PRJ-0003”;
- equivalent unambiguous language.

The caller resolves the allowed project set and sends that set to the search layer.

The search index does not silently expand a project-scoped query into a portfolio query.

### 10.4 SQL-level isolation

Project filters are part of the database predicate before scoring/ranking.

Do not:

1. query the whole index;
2. rank global hits;
3. filter unauthorized/unscoped projects afterward.

That pattern is explicitly prohibited.

## 11. Query contract

The exact HTTP/API syntax is implementation-plan work, but the semantic contract is fixed.

A query supports:

```text
query text
explicit project scope
record kinds/entity types
zones/lifecycle filters
status filters
result limit
```

Default result limits are bounded.

Unbounded “return every matching row” queries are not part of the public normal workflow.

### 11.1 Ranking

The initial deterministic ranking strategy should prioritize:

1. exact Project OS identifier matches;
2. exact title/name matches;
3. strong prefix/title matches;
4. FTS5 lexical relevance;
5. stable deterministic tie-breaking.

No embedding/vector score exists in INDEX001.

### 11.2 Query compiler safety

Raw user text must not be concatenated directly into SQL or trusted as raw FTS5 query syntax.

The query layer must:

- bind SQL values;
- normalize/escape lexical input;
- cap query length and term count;
- handle punctuation and empty-token queries deterministically;
- reject malformed/unsupported filter combinations clearly.

## 12. Result contract

Every result returns enough information to identify what matched and where authority lives.

### 12.1 Canonical entity result

Conceptually:

```text
project_id
record_kind = canonical_entity
entity_type
entity_id
title
status?
snippet?
score
canonical_revision
authority_ref
```

### 12.2 Managed document/reference result

Conceptually:

```text
project_id
record_kind = managed_document
document_id
version_id
logical_path
zone/stage
title
snippet?
score
content_hash
authority_ref
```

### 12.3 Authority reference

`authority_ref` is structured enough for a caller to fetch or verify the real source.

It uses Project OS identities and logical references such as:

- `project_id`;
- canonical entity ID and revision;
- `document_id`;
- `version_id`;
- logical path;
- governed content hash where appropriate.

Provider IDs are not the business reference.

### 12.4 Search snippets are convenience text

A snippet is derived index content and may be stale within the declared lag window.

When a caller needs to make a consequential factual assertion, inspect long content, or perform a durable mutation based on a hit, it should fetch the authoritative current source rather than treating the snippet as final truth.

## 13. Freshness and lag model

Canonical business state and Managed Document state evolve on different clocks.

A single project revision is therefore insufficient to describe search freshness.

### 13.1 Canonical watermark

For each project track:

```text
canonical_revision_requested
canonical_revision_indexed
```

A canonical revision is indexed only after all required structured entity changes for that target are committed to the active search generation.

### 13.2 Managed Document watermark

Managed Documents/references may change without a canonical business revision.

ProjectGuard therefore maintains a rebuildable technical document-change generation for search synchronization.

Conceptually:

```text
document_generation_requested
document_generation_indexed
```

The generation is operational state, not business history.

If the ProjectGuard hot synchronization state is lost or reset, Project OS starts a new local synchronization epoch and requires a managed-document search rebuild/catch-up before declaring document freshness current.

### 13.3 Freshness states

At minimum expose:

```text
current
lagging
rebuilding
unknown
failed
```

A search response may still return results while `lagging`, but it must surface that condition rather than claiming complete freshness.

### 13.4 No silent provider fallback

If the index is unavailable or rebuilding, Project OS does not silently recurse through Dropbox to simulate normal search.

That would hide an operational failure and recreate the performance problem INDEX001 is intended to solve.

A caller may explicitly use an authoritative single-record fetch when it already knows an identity, but that is not a substitute for broad search.

## 14. Incremental update model

### 14.1 Canonical business changes

After a canonical commit becomes durable, ProjectGuard records a technical search synchronization request for the resulting revision.

The search request is downstream derived work.

Failure to notify/apply the search index does not change the canonical receipt outcome.

ProjectGuard can retry synchronization through its existing alarm/reconciliation model.

The implementation should emit normalized read-model updates rather than make `SearchIndexGuard` parse arbitrary transaction JSON as business semantics.

### 14.2 Managed Document and reference changes

When a governed current head changes, ProjectGuard records a document-index synchronization request.

Relevant events include:

- new WORKING document;
- governed rewrite/new version;
- WORKING -> REVIEW;
- REVIEW -> DELIVERABLES;
- reopen;
- accepted external edit/reconciliation;
- reference ingestion reaching safe governed terminal state;
- current-head/path/stage change;
- logical removal/supersession if supported by the governing lifecycle.

The search job carries or can deterministically resolve the current authoritative logical head.

### 14.3 Durable local outbox principle

Search synchronization must not depend solely on `waitUntil()`, best-effort RPC, or an in-memory callback.

The project-scoped coordinator records pending derived search work in Durable Object storage before considering the downstream synchronization request safely handed off.

Duplicate delivery is expected and must be idempotent.

### 14.4 SearchIndex application

`SearchIndexGuard` applies an update transactionally.

A deterministic job identity or `(project_id, source watermark, logical record identity)` idempotency key prevents duplicate source delivery from creating duplicate hits.

The indexed watermark advances only after the corresponding required index changes succeed.

### 14.5 Reconciliation

Normal correctness is event/job driven.

Scheduled maintenance may perform **bounded watermark reconciliation**:

- compare requested/indexed state;
- retry missing jobs;
- request rebuild/catch-up where required.

It must not recursively rescan/download every project workspace as normal maintenance.

## 15. Rebuild model

### 15.1 Full deletion must be recoverable

A test must be able to erase the entire SearchIndex Durable Object state and rebuild useful search from authoritative Project OS durable truth.

### 15.2 Rebuild sources

A rebuild reads:

1. registry/project identity needed to select projects;
2. canonical current project state for structured entities;
3. governed Managed Document/reference logical heads;
4. immutable governed text payloads for current searchable versions;
5. metadata required for non-text records.

It does **not** infer truth from recursive `WORKSPACE/` file presence.

### 15.3 Per-project generation switching

Search remains available from the last proven project generation while a new rebuild is staged.

Conceptually:

```text
project active generation = G12
rebuild staging generation = G13
```

Rebuild inserts G13 incrementally.

Queries continue using G12 until G13 reaches its target watermarks and passes validation.

Then one SQLite transaction advances the project head to G13.

Old G12 rows can be deleted asynchronously.

### 15.4 Changes during rebuild

A rebuild captures target source watermarks.

If new canonical/document changes arrive while the staging generation is being built, they remain pending and must be applied to the staged generation or immediately caught up after staging before the new generation can be declared current.

The rebuild must not flip to a generation already known to be behind its required target.

### 15.5 Resumability

Large rebuilds are chunked and resumable.

A Durable Object restart, CPU limit, or transient provider failure must not require restarting every already verified row from zero.

## 16. Search backend boundary

Introduce an internal abstraction conceptually separating:

```text
SearchService
  -> SearchIndexStore / SearchBackend
      -> SQLite FTS5 implementation
```

The product-facing result/scope/freshness contracts must not expose SQLite row IDs, FTS5 syntax, or Durable Object object IDs.

This allows `IMP-PERF001` or a future approved package to introduce sharding or another backend without redesigning Project OS search semantics.

YAGNI rule: only one production backend is implemented in INDEX001.

## 17. Provider-neutral reconstruction

Rebuild and incremental indexing use existing Project OS repositories/services over the provider-neutral persistence runtime.

INDEX001 must not import or branch on:

- `DropboxClient`;
- Dropbox HTTP response codes;
- Dropbox `file_id` format;
- Dropbox `rev` format;
- Dropbox search APIs;
- Dropbox-specific retry errors.

The Dropbox webhook/change-feed remains an inbound provider concern for Managed Documents, but by the time INDEX001 receives a governed document change it operates on Project OS logical identity/state.

## 18. Archived and completed projects

Searchability is independent from mutability.

A completed or archived project may still be valuable research history and can remain indexed.

A PROJECT_SESSION cannot perform unsupported mutations merely because search returned an archived result.

Portfolio scope and project filters may include or exclude archived projects explicitly according to caller intent.

## 19. Security and privacy behavior

INDEX001 does not redesign authentication, but it must preserve current trust boundaries.

### 19.1 External API authorization

Any public Worker search endpoint uses the existing authenticated control-plane pattern until `IMP-SECURITY001` defines stronger user/admin separation.

The SearchIndex Durable Object itself is internal runtime state, not a public unauthenticated database endpoint.

### 19.2 No content in operational logs

Structured logs may contain:

- project IDs;
- record kinds/types;
- generation/watermarks;
- row counts;
- query scope size;
- result count;
- duration;
- status/error category.

They must not contain:

- document body text;
- search snippets;
- raw sensitive source payloads;
- secrets/tokens.

Raw query strings should not be emitted to normal logs because search terms themselves can be sensitive.

### 19.3 Fail-closed scope

A malformed or unresolved project scope is rejected.

Do not broaden scope as an error-recovery behavior.

## 20. Observability

INDEX001 emits structured signals sufficient for `IMP-OBSERVE001` to later aggregate.

### 20.1 Update signal

At minimum:

```text
project_id
index_generation
source_kind
canonical_revision_requested?
canonical_revision_indexed?
document_generation_requested?
document_generation_indexed?
records_upserted
records_removed
fts_rows_updated
duration_ms
retry_count
final_state
```

### 20.2 Rebuild signal

At minimum:

```text
project_id
from_generation?
to_generation
structured_records
text_records
binary_metadata_records
chunks_processed
duration_ms
final_state
```

### 20.3 Query signal

At minimum:

```text
scope_kind
projects_in_scope
filters_present
limit
hits_returned
fresh_projects
lagging_projects
rebuilding_projects
duration_ms
final_state
```

No raw query/body text is required for normal operational observability.

## 21. Failure semantics

### 21.1 Canonical commit succeeds, index update fails

Canonical commit remains committed.

Search watermark remains behind.

Pending job remains/retries.

Search reports lag.

### 21.2 Managed Document change succeeds, index update fails

Managed Document/reference authority remains unchanged.

Search document watermark remains behind.

Pending job remains/retries.

### 21.3 SearchIndex Durable Object storage is lost

No business data is lost.

Index state becomes `unknown/rebuilding` and is reconstructed from durable truth.

### 21.4 Partial rebuild fails

Active old generation remains queryable.

Incomplete staging generation is never promoted.

### 21.5 Query execution fails

Return explicit search-unavailable/error semantics.

Do not silently perform a broad recursive provider scan.

### 21.6 One project's bad index input

Project-scoped failure must not corrupt or delete another project's active generation.

A rebuild/update failure records the affected project and preserves other project heads.

## 22. Capacity assumptions and future sharding

INDEX001 intentionally avoids premature distributed-search architecture.

Current design assumptions:

- isolated installation per client;
- expected near-term scale fits a single SQLite-backed Durable Object;
- cross-project search quality/simplicity is more valuable now than speculative sharding.

Current Cloudflare documentation states:

- SQLite-backed Durable Objects support FTS5;
- each SQLite-backed Durable Object has a 10 GB storage limit on paid plans;
- an individual Durable Object is single-threaded and has documented soft throughput limits;
- SQLite is recommended for new Durable Object classes.

`IMP-PERF001` owns measured validation at roadmap target scales, including 100/1,000 projects and large indexed document counts where practical.

If measurements show the single installation index is insufficient, the backend abstraction permits future designs such as:

- project-range shards plus a coordinator;
- separate structured/text shards;
- external dedicated search service.

INDEX001 does not implement those alternatives preemptively.

## 23. Rollout strategy

### Stage A — Structural deployment only

Deploy the new SearchIndex Durable Object schema/class and internal service wiring without changing normal user-facing search behavior.

Health must remain green.

### Stage B — Controlled rebuild/backfill

Build index generations for selected known projects, beginning with PRJ-0002 and another real project with richer governed content.

Validate row counts, identities, zones, project isolation, and watermarks.

### Stage C — Shadow/read-only comparison

Exercise the new search endpoint in controlled/admin validation.

Compare known queries against authoritative sources.

Verify that:

- expected hits are returned;
- unrelated project hits do not leak into project scope;
- generated Markdown duplicates do not dominate results;
- INPUTS/unresolved candidates are absent;
- top hits resolve to authoritative records/files.

### Stage D — Enable normal read path

Enable Project OS/ChatGPT search retrieval through the new read model after exact-commit production proof.

No business mutation path changes are required for user search enablement.

### Stage E — Canonical closure

Only after:

- CI is green;
- exact commit is deployed;
- production health is green;
- index rebuild works;
- project isolation is proven;
- incremental canonical/document updates are proven;
- lag semantics are proven;
- authoritative-reference resolution is proven;

may `IMP-INDEX001` be canonically completed.

## 24. Acceptance criteria

### AC-01 — Fast project-scoped structured read

A project-scoped query can find current canonical tasks/decisions/research/deliverables without recursively scanning provider content.

### AC-02 — Lexical full-text read

A project-scoped lexical query can find governed current text content through FTS5 and return bounded ranked results.

### AC-03 — Explicit portfolio scope

Cross-project search occurs only when the caller supplies an explicit project set derived from explicit user intent.

### AC-04 — SQL-level project isolation

A project-scoped query cannot return another project's rows even if text and IDs are similar.

### AC-05 — Canonical generated views are deduplicated

Generated Markdown projections are not separately indexed as competing authoritative records for canonical entities.

### AC-06 — Stable Managed Document identity

WORKING -> REVIEW -> DELIVERABLES preserves one searchable `document_id`; lifecycle movement updates the record rather than fabricating a new logical document.

### AC-07 — Current version identity

A Managed Document result includes the exact current indexed `version_id` and governed content hash/reference needed to verify the source.

### AC-08 — INPUTS excluded

An active file visible only in `INPUTS/` is not returned by normal research/full-text search.

### AC-09 — Terminal reference ingestion

After safe governed reference ingestion completes, the reference becomes searchable and the original INPUTS copy does not appear as a separate hit.

### AC-10 — MutationGate candidate excluded

An unresolved external mutation candidate does not appear in normal search until governed adoption makes it authoritative content.

### AC-11 — Binary metadata behavior

A governed binary can be found by authoritative metadata without pretending its body text was indexed.

### AC-12 — Canonical incremental update

A committed canonical change eventually updates the structured index without changing the canonical receipt result.

### AC-13 — Managed Document incremental update

A governed document/reference head change eventually updates its indexed current version/stage without requiring a whole-workspace scan.

### AC-14 — Failure does not corrupt authority

Indexing failure cannot uncommit or reject an already committed business transaction or governed Managed Document change.

### AC-15 — Explicit lag

If requested watermarks are ahead of indexed watermarks, search reports lagging freshness.

### AC-16 — Full rebuild

Deleting the complete index and rebuilding from durable truth restores equivalent current searchable records without relying on prior index storage.

### AC-17 — Rebuild is not workspace inference

Rebuild uses canonical/Managed Document authoritative records and payloads, not arbitrary file presence discovered through recursive WORKSPACE scanning.

### AC-18 — Rebuild generation safety

A partial/failed rebuild never replaces the last proven active project search generation.

### AC-19 — Crash/replay idempotence

Duplicate update jobs, Durable Object restart, or alarm replay cannot create duplicate search records or incorrectly advance watermarks.

### AC-20 — Authoritative references

Every hit exposes stable Project OS provenance sufficient to retrieve or verify the real source.

### AC-21 — Provider neutrality

Search core/backend contracts contain no Dropbox-specific identity or error dependency.

### AC-22 — No vector/OCR complexity

INDEX001 production behavior contains no embedding pipeline, vector database, semantic reranker, or generalized binary text extraction.

### AC-23 — Sensitive logging discipline

Normal search/index logs contain no document body, snippets, or raw query text.

### AC-24 — Archived project retrieval

Archived/completed projects can remain searchable when explicitly in scope without enabling invalid mutations.

## 25. Required test families

Implementation planning must include strict RED -> GREEN TDD coverage for at least:

### Structured index

- project/entity upsert;
- task lifecycle status update;
- decision supersession/current semantics;
- research/constraint retrieval;
- deliverable lifecycle filters;
- exact ID search;
- exact/prefix title ranking;
- generated-view deduplication.

### Managed Documents/references

- WORKING creation;
- WORKING rewrite/new version;
- WORKING -> REVIEW;
- REVIEW -> DELIVERABLES;
- reopen;
- external edit reconciliation;
- stable `document_id` across stages;
- version replacement removes stale current-head search result;
- ordinary reference ingestion;
- verified referral reference ingestion;
- INPUTS exclusion;
- unresolved candidate exclusion;
- binary metadata-only indexing.

### Search scope

- project scope returns only target project;
- explicit two-project portfolio scope;
- malformed/empty scope rejection;
- no implicit all-project fallback;
- archived project filter behavior.

### Full-text/query compiler

- ordinary terms;
- punctuation;
- quoted/special characters;
- empty/stop-like input;
- bounded result count;
- SQL injection attempts remain data, not executable SQL;
- FTS syntax injection does not escape the query compiler;
- deterministic ranking/tie-breaking.

### Freshness

- canonical requested > indexed => lagging;
- document requested > indexed => lagging;
- both current => current;
- rebuild => rebuilding;
- synchronization-state reset => unknown/rebuild required.

### Crash/replay

- canonical commit after authority but before index notification;
- durable local job registered but RPC not delivered;
- RPC delivered twice;
- SearchIndex applies rows but crashes before watermark update;
- watermark transaction failure;
- Managed Document change replay;
- partial rebuild restart;
- generation flip failure;
- old-generation cleanup failure.

### Rebuild

- full empty-index rebuild;
- selected-project rebuild;
- rebuild while new canonical mutation arrives;
- rebuild while Managed Document head changes;
- project failure isolated from another project;
- no recursive workspace scan required for correctness.

### Provider neutrality

- search service/store unit tests with provider-neutral fakes;
- production composition test proving no SearchIndex core import of Dropbox client/error/search APIs.

### Production acceptance

- PRJ-0002 known structured queries;
- second real project full-text queries;
- explicit portfolio query;
- negative project leakage query;
- INPUTS/candidate negative tests;
- exact authoritative-result fetch verification;
- delete/rebuild smoke proof;
- incremental update smoke proof;
- lag/recovery smoke proof.

## 26. Implementation constraints

- Use strict TDD.
- Keep SearchIndex derived and disposable.
- Do not directly edit generated canonical workspace files.
- Do not modify canonical business truth from the search subsystem.
- Do not introduce a canonical schema bump merely for index state.
- Do not use provider IDs as search record identity.
- Do not query Dropbox search APIs from SearchService/SearchIndexGuard.
- Do not use periodic recursive provider scanning as normal indexing machinery.
- A bounded reconciliation loop may compare watermarks and resume missing derived work.
- Use one prepared production persistence/runtime composition path for authoritative rebuild reads.
- Reuse ProjectGuard project-scoped serialization for source-side indexing outbox coordination.
- SearchIndex updates must be idempotent and project-qualified.
- Queries must always bind explicit project scope.
- Query/result limits must be bounded.
- Raw search text/body/snippets must not appear in operational logs.
- No embeddings, vector index, semantic reranker, OCR service, or external search service in this package.
- New Durable Object deployment must follow the repository's existing Cloudflare migration/config conventions.
- Production remains continuity `stable`; INDEX001 does not redefine rollout authority.

## 27. Source ownership guidance

Exact filenames are implementation-plan decisions, but avoid overloading the repository's existing ambiguous `src/index*.ts` entrypoint names or `src/schema/provider-index.ts` provider-binding schema.

Preferred ownership is conceptually:

```text
src/read-model/
  canonical-project-records.ts
  managed-document-records.ts
  synchronization.ts

src/search/
  contract.ts
  service.ts
  query-compiler.ts
  ranking.ts
  sqlite-store.ts
  search-index-guard.ts
  rebuild.ts
```

The search subsystem should be understandable independently from Worker entrypoint code and independently from provider-index schema compatibility records.

## 28. External platform evidence

Cloudflare documentation checked on 2026-09-01:

- SQLite-backed Durable Object Storage: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
  - SQLite SQL storage is supported;
  - FTS5 is listed as a supported SQLite module;
  - SQLite-backed Durable Objects are the current recommended storage backend for new Durable Object classes.

- Durable Object limits: https://developers.cloudflare.com/durable-objects/platform/limits/
  - paid-plan SQLite-backed Durable Objects currently document up to 10 GB per object;
  - capacity/throughput still require measured product validation.

These platform facts support the initial backend choice. They do not change the Project OS invariant that search state is derived and replaceable.

## 29. Design decision summary

Adopt the following INDEX001 architecture, subject to founder approval of this written specification:

> Project OS will add an installation-scoped, SQLite/FTS5-backed derived search/read model behind provider-neutral interfaces. It will index current canonical entities and current governed Managed Document/reference heads, preserve Project OS logical identity and provenance, enforce explicit project scope inside queries, update asynchronously through durable project-scoped synchronization jobs, expose canonical and document freshness watermarks, and support resumable generation-based rebuild from authoritative durable truth. Generated canonical Markdown, active INPUTS, unresolved MutationGate candidates, vector search, OCR, and provider-native search are outside the normal INDEX001 search corpus.

The next step after written-spec approval is to create the standalone implementation plan. No runtime implementation starts from this document alone.
