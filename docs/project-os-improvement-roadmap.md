# Project OS Improvement Roadmap

## Status

Roadmap revised and approved in chat on 2026-08-24 after reviewing Project OS as a potential product-grade R&D persistence system rather than only a personal Dropbox/Obsidian workflow.

This document records sequencing and scope. It does not itself authorize runtime changes or canonical Project OS state mutations. Individual packages still require their normal design, implementation, CI, production validation, and canonical closure gates.

## Product direction

Project OS should remain usable through natural language while preserving durable project context outside chat. It should be robust enough to install as an isolated system for a client without depending on a particular computer being online.

Core direction:

```text
ChatGPT / future UI
        |
        v
Project OS Core
        |
        +--> canonical immutable history / state
        +--> projection and read models
        |
        v
Persistence provider
        |
        v
Dropbox today
        |
        v
optional Dropbox Desktop sync -> Obsidian
```

### Explicit architecture decisions

- Dropbox remains the current durable external persistence provider.
- A user's PC is **not** a Project OS server and Project OS does not require direct filesystem access.
- Dropbox Desktop may synchronize files locally for Obsidian, but no local bridge or desktop daemon is required.
- Durable Object / SQLite hot state is operational acceleration and must remain reconstructible from canonical external records.
- The core should gradually avoid new Dropbox-specific business assumptions so future provider abstraction is possible.
- Initial client deployments should prefer isolated installations per client rather than shared multi-tenant SaaS infrastructure.
- Full multi-tenancy is not part of this roadmap unless a future explicit SaaS decision creates that requirement.

## Sequenced roadmap

### Foundation reliability — completed

#### 1. `IMP-CONTINUITY001` — Continuity control-plane foundation — ✅ complete

Purpose: fail-closed stable/candidate/rollback control foundation, with proof gates and production remaining stable.

#### 2. `IMP-FAULTTEST001` — Deterministic fault injection — ✅ complete

Purpose: repeatable technical failure simulation without production behavior changes.

#### 3. `IMP-RECOVERY001` — Canonical recovery — ✅ complete

Purpose: rebuild state/receipts/registry/allocator from durable Dropbox truth after local loss.

#### 4. `IMP-COMMIT001` — Crash-safe canonical commits — ✅ complete

Purpose: immutable commit records and durable all-or-nothing business commit truth.

#### 5. `IMP-ROLLBACK001` — Data-preserving technical rollback — ✅ complete

Purpose: automatic fallback to stable execution without rewinding committed project history.

#### 6. `IMP-DROPRES001` — Dropbox resilience — ✅ complete

Purpose: consistent bounded transient retry behavior for Dropbox reads/listing/writes/moves/deletes while preserving fail-closed semantics.

#### 7. `IMP-INBOX001` — Resilient dependency-aware inbox processing — ✅ complete

Purpose: poison-entry isolation, continued healthy processing, exact replay cleanup, and same-project causal ordering by revision dependency.

---

### Projection, data integrity, and model foundation

#### 8. `IMP-MATERIAL001` — Projection Engine — 🟡 active

Purpose: replace full synchronous workspace rewrites with asynchronous, incremental, hash-aware, generation-verifiable materialization.

Key outcomes:

- canonical business commit decoupled from full Markdown publication;
- deterministic projection planning;
- hash-based skip of unchanged outputs;
- incremental entity view updates;
- coherent `STATE.md` / `HANDOFF.md` generation;
- resumable per-output progress;
- safe revision coalescing;
- bounded provider concurrency;
- hot projection state reconstructible from canonical commits;
- structured projection signals for later observability/performance work.

Authoritative design: `docs/superpowers/specs/2026-08-24-imp-material001-projection-engine-design.md`.

#### 9. `IMP-ARTIFACT001` — Artifact concurrency and stale-destination safety

Purpose: detect and fail safely when governed destination files changed concurrently or became stale between planning and write.

Key outcomes:

- destination revision/hash preconditions;
- stale-write detection;
- safe concurrent edit handling;
- no silent overwrite of unexpected content;
- artifact operations remain idempotent and project-isolated.

#### 10. `IMP-SCHEMA001` — Schema compatibility and migrations

Purpose: make Project OS upgrades safe across projects created by different software/schema generations.

Key outcomes:

- explicit schema versions;
- backward compatibility policy;
- deterministic migrations;
- migration validation and rollback/recovery strategy;
- clean handling of old commit/state formats.

#### 11. `IMP-MODEL001` — Formal lifecycle and concurrency model

Purpose: stabilize the domain model before advanced indexing/product layers depend on it.

Key outcomes:

- explicit project/task/decision/research/deliverable lifecycle semantics;
- dependency/concurrency rules;
- formal invariants around current state versus immutable history;
- clearer compatibility contracts for later projections/indexes.

---

### Product-grade persistence and read architecture

#### 12. `IMP-PERSIST001` — Persistence provider boundary — 🆕

Purpose: keep Dropbox as the production provider while preventing Project OS Core from becoming permanently coupled to Dropbox-specific behavior.

Key outcomes:

- formal persistence/provider interfaces around canonical and projection operations;
- Dropbox implementation remains first-class and fully supported;
- no alternate provider required in this package;
- future SharePoint/Google Drive/S3-class providers can be added without rewriting business logic;
- provider capability differences are explicit rather than hidden.

Non-goal: direct PC/local filesystem access.

#### 13. `IMP-INDEX001` — Fast read/search model — 🆕

Purpose: make cross-project research retrieval fast without recursively scanning/downloading Dropbox content for every query.

Key outcomes:

- structured project/entity read model;
- full-text indexing of relevant persisted content;
- incremental index updates driven by canonical/projection changes;
- index lag/rebuild semantics;
- index remains reconstructible from durable truth;
- retrieval returns references to authoritative project/file content.

Initial priority: structured/full-text quality before optional vector search complexity.

#### 14. `IMP-OBSERVE001` — Product observability

Purpose: make Project OS diagnosable in production through correlated structured signals rather than ad-hoc logs.

Minimum correlation fields:

- `transaction_id`;
- `project_id`;
- canonical revision;
- materialization/generation ID;
- deployment/version identity.

Minimum operational signals:

- commit latency;
- materialization latency and lag;
- Dropbox/provider call and retry counts;
- inbox/projection queue depth;
- recovery events;
- rollback events;
- index lag;
- projection failures.

#### 15. `IMP-SECURITY001` — Product/client security hardening

Purpose: make isolated client installations defensible for sensitive R&D/project data.

Key outcomes:

- normal/admin separation;
- least-privilege provider credentials/scopes;
- strong project isolation;
- sensitive-operation audit trail;
- secret rotation procedures;
- no secret values in chat/docs/GitHub;
- installation-level client isolation;
- explicit trust boundaries between UI, Project OS Core, hot state, and external persistence.

Explicit non-goal: global access to the user's computer filesystem.

#### 16. `IMP-PERF001` — Performance and load engineering — 🆕

Purpose: establish measured product budgets and prove scaling behavior instead of relying on qualitative impressions.

Representative test scales:

- 100 and 1,000 projects;
- 1,000 / 10,000 / 100,000 indexed/project documents where practical;
- bursty and concurrent transaction/projection workloads.

Measure at minimum:

- business commit latency;
- projection latency and lag;
- provider API calls and uploads per mutation;
- read/search latency;
- hot-state memory/storage growth;
- recovery duration;
- queue behavior under transient provider failures;
- throughput under bounded concurrency.

This package establishes explicit SLO/budget targets using measured evidence.

---

### Deployment, user experience, and maintainability

#### 17. `IMP-DEPLOY001` — Reproducible deployment and transparent rollout

Purpose: turn safe deployment into a product-grade repeatable process and close the long-term automatic cutover objective.

Target rollout flow:

```text
stable
  -> candidate tested in parallel
  -> required proofs
  -> automatic internal cutover
  -> monitoring
  -> new stable OR automatic fallback
```

Key outcomes:

- reproducible isolated client deployment;
- configuration/secrets separation;
- health/readiness gates;
- schema/migration integration;
- backup/recovery checks;
- transparent candidate rollout;
- automatic fallback without chat/user migration;
- users never select versions manually.

Production remains `stable` until these mechanics are explicitly implemented and proven.

#### 18. `IMP-UX001` — Zero-complexity product UX

Purpose: hide the internal reliability machinery from normal users.

Normal workflow remains natural language such as:

> “Ajoute ça à mon projet.”

The user should not need to understand:

- sync commands;
- materialization generations;
- projection queues;
- retries;
- schema versions;
- deployment versions;
- storage-provider mechanics.

Technical detail surfaces only when a genuine intervention or admin diagnosis is necessary.

#### 19. `IMP-MAINT001` — Maintainability, runbooks, and reconstruction

Purpose: ensure another operator/team/LLM can install, audit, recover, upgrade, and maintain Project OS without historical chat context.

Key outcomes:

- current architecture documentation;
- code map;
- deployment/install procedures;
- client installation guide;
- recovery/runbooks;
- schema upgrade/migration procedures;
- security operating procedures;
- performance/observability operating procedures;
- clean-room reconstruction test;
- explicit authoritative-source references.

## Deferred unless future product strategy requires them

### Multi-tenancy / SaaS

Not currently planned. Preferred initial client model:

```text
Client A -> isolated Project OS installation A
Client B -> isolated Project OS installation B
Client C -> isolated Project OS installation C
```

A future `IMP-TENANCY001` would require a separate business/product decision because it materially changes security, identity, billing, isolation, operations, and compliance architecture.

### Direct local-PC connector

Not planned. Project OS does not need direct PC access for its current architecture. Dropbox Desktop synchronization for Obsidian is sufficient for the local human workspace.

If a future use case requires ingesting files that deliberately live outside the configured persistence provider, that must be proposed as a separate connector package with explicit permission, threat-model, and data-governance design.

## Global roadmap invariants

Every remaining package must preserve these rules unless a later explicit architecture decision supersedes them:

- natural-language user workflow remains the default;
- canonical committed history is never silently rewritten;
- machine-managed canonical state is mutated only through supported Project OS mechanisms;
- hot caches/read models are reconstructible from durable truth;
- project isolation fails closed;
- no product package requires direct PC/filesystem access;
- Dropbox remains the current production persistence provider until `IMP-PERSIST001` and a separately approved alternate provider exist;
- continuity remains `stable` until transparent automatic rollout is fully implemented and proven;
- a package is complete only after tests, exact-commit production deployment, health validation, and canonical evidence/closure.
