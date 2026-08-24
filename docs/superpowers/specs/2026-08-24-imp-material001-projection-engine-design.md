# IMP-MATERIAL001 — Projection Engine and Coherent Materialization Design

## Status

Architecture approved in chat on 2026-08-24. This written specification is awaiting final user review before implementation planning. No runtime behavior changes are authorized by this document alone. Production continuity mode remains `stable` until implementation is separately proven, merged, deployed, health-validated, and canonically closed.

## Goal

Turn Project OS materialization from a synchronous full-workspace rewrite into a production-grade projection engine that is fast, resumable, verifiable, and reconstructible.

A canonical business commit must remain the durable truth. Human-facing Markdown, Obsidian views, and future read/search indexes are derived projections of that truth. Projection failure must never create an extra business revision, erase committed work, or require a user/chat to run a sync command.

## Product-level objective

Project OS should be viable as a robust R&D persistence layer outside chat, deployable for isolated client installations without depending on a particular workstation.

The core product architecture is:

```text
ChatGPT / future UI
        |
        v
Project OS Core
        |
        v
Canonical Commit Store  <-- durable business truth
        |
        +--> fast response to caller
        |
        v
Projection Engine
        |
        +--> human Markdown views
        +--> future read/search model
        |
        v
Persistence Provider
        |
        v
Dropbox (current provider)
        |
        v
Dropbox Desktop sync -> Obsidian (optional human client)
```

The PC is not a Project OS server and Project OS does not require direct filesystem access. Dropbox Desktop may mirror the Dropbox workspace locally for Obsidian, but no local bridge, global disk permission, or always-on desktop agent is part of this package or the core architecture.

## User-level invariants

- The user continues using normal natural language; no `SYNC`, `MATERIALIZE`, `REFRESH`, retry, generation, or version-selection command is introduced.
- Existing chats do not migrate or restart when materialization behavior changes.
- A canonical commit is not rolled back merely because a derived Markdown projection is delayed or fails.
- `STATE.md` and `HANDOFF.md` are always rendered from the same canonical `ProjectState` target revision.
- Project OS never declares a target materialization complete until all required outputs for that target have been verified.
- If projection work is interrupted, Project OS resumes automatically without creating a new business revision.
- Exact replay of projection work is idempotent.
- Dropbox remains the durable external persistence provider for the current product, and all hot state introduced by this package must be reconstructible from canonical Dropbox records.
- The architecture must not depend on a specific workstation being online.
- Production continuity remains `stable` while this package is introduced and validated.

## Current defect

`ProjectRepository.writeHumanViews()` currently rewrites every decision, constraint, task, research record, and deliverable, then rewrites all global human views (`BRIEF`, `DISCOVERY`, `ROADMAP`, `PROJECT`, `STATE`, `PLAN`, `HANDOFF`) for every materialized project-state revision.

This creates four product-level problems:

1. **write amplification** — unrelated entities are repeatedly uploaded even when their content did not change;
2. **latency coupling** — the business commit path waits for potentially many Dropbox writes;
3. **mixed-generation crash windows** — interruption can leave `STATE.md`, `HANDOFF.md`, and other views reflecting different revisions while the canonical commit is already newer;
4. **poor resumability** — materialization is retried as a procedure rather than as an explicit per-output generation with durable progress.

## Chosen approach

Implement an asynchronous, generation-aware projection engine with four layers:

1. **canonical target** — the immutable commit record / committed `ProjectState` revision to project;
2. **projection planner** — determines which outputs are expected and renders their desired content;
3. **materialization ledger** — tracks target revision, output hashes, completion state, retries, and supersession/coalescing;
4. **persistence writer** — writes only changed outputs to Dropbox with bounded concurrency, then verifies the generation before marking it complete.

The canonical commit record remains the business truth. The materialization ledger is operational/hot state and must be recoverable if lost.

## Canonical commit path versus projection path

### Required target architecture

A successful transaction should converge toward:

```text
validate transaction
    -> write immutable canonical commit record
    -> persist/return committed business receipt
    -> enqueue/schedule projection target
    -> project asynchronously
```

The materialization of human views must no longer be a prerequisite for acknowledging the durable business result once the canonical commit and receipt semantics are safe.

### Important compatibility constraint

`IMP-MATERIAL001` must preserve the `IMP-COMMIT001` rule that the commit record is canonical commit truth. Any reordering of standalone receipts, snapshots, or view publication must be proven against existing crash-window tests. The implementation plan must not weaken commit durability to gain latency.

## Materialization generation model

Each target revision has a logical generation identity scoped by project and revision.

Conceptually:

```text
project_id: PRJ-0002
target_revision: 72
status: pending | running | complete | superseded
outputs:
  STATE.md:     { desired_hash, status }
  HANDOFF.md:   { desired_hash, status }
  ROADMAP.md:   { desired_hash, status }
  TASK-X.md:    { desired_hash, status }
```

The exact physical representation may live in Durable Object SQLite and/or a reconstructible machine record, but it must satisfy the recovery rules in this spec.

A generation becomes `complete` only after every required output has reached the desired content or has been proven unchanged, and the critical aggregate views have been verified.

## Projection planning

### Global aggregate views

The following global views are cheap to render from one `ProjectState` and should be rendered in memory for each target generation:

- `BRIEF.md`
- `DISCOVERY.md`
- `ROADMAP.md`
- `PROJECT.md`
- `STATE.md`
- `PLAN.md`
- `HANDOFF.md`

Rendering in memory is not the expensive operation; Dropbox network writes are. Therefore the engine may render all aggregate views, hash them, and skip persistence whenever the desired content is unchanged.

### Entity views

Entity notes should be incremental. The planner should identify entity outputs affected by the committed event/transaction and avoid rewriting unrelated decisions, constraints, tasks, research records, and deliverables.

The implementation must remain conservative: when dependency analysis is uncertain, it may include an extra output in the plan, because the subsequent hash comparison will prevent an unnecessary Dropbox upload if the rendered content is identical. Correctness has priority over micro-optimizing render CPU.

### Determinism

For a given validated `ProjectState` and renderer version, the desired content and desired hash for an output must be deterministic.

## Hash-based write elimination

Before writing an output, the engine computes the desired content hash.

Required behavior:

- if the ledger already proves the persisted output has the same desired hash, perform no Dropbox write;
- if content is rendered again but its desired hash matches the previous completed materialization, perform no Dropbox write;
- if verification is required after uncertain failure, read only the specific uncertain output rather than redownloading the entire workspace;
- an unchanged project view must not be uploaded merely because the project revision increased.

This is a hard efficiency acceptance criterion, not an optional optimization.

## `STATE.md` and `HANDOFF.md` coherence

`STATE.md` and `HANDOFF.md` are critical recovery/read surfaces and receive special treatment.

For each generation:

1. both are rendered from exactly the same target `ProjectState` object/revision;
2. both include the same project revision in frontmatter/body where applicable;
3. both are persisted near the end of generation publication;
4. both are verified against their desired hashes/content before generation completion;
5. the generation is not marked complete if either one is missing, stale, or mismatched.

Dropbox does not provide a general atomic transaction that makes two independent files visible simultaneously. Therefore this package does **not** claim impossible multi-file visibility atomicity to arbitrary manual Dropbox readers.

The guarantee is instead precise: **Project OS never treats a partially published pair as a complete coherent generation.** Machine consumers must prefer canonical state or the last complete materialization when the current target is incomplete.

## Completion marker / materialized head

Project OS must be able to distinguish:

```text
canonical_revision = 72
materialized_revision = 71
```

from:

```text
canonical_revision = 72
materialized_revision = 72
```

A small materialization-head record or equivalent durable/reconstructible state must represent the latest generation proven complete.

The head may advance only after verification. It must never advance optimistically before all required outputs are satisfied.

## Resume semantics

Projection work is resumable per output.

If a target generation contains 20 outputs and 17 are complete before a crash, recovery must resume the remaining/uncertain outputs rather than blindly rewrite all 20.

Required recovery sources, in order of authority:

1. canonical commit record for the target revision;
2. validated target `ProjectState` contained in that record;
3. materialization ledger/progress if available;
4. selective Dropbox verification for uncertain outputs.

Loss of Durable Object local projection state must be recoverable by rebuilding pending work from canonical Dropbox commit records plus the latest complete materialization evidence.

Projection recovery never increments the project business revision.

## Scheduling and retry

The preferred path is immediate scheduling after commit rather than waiting for the periodic inbox scan.

Durable Object alarm/scheduling or an equivalent internal mechanism should wake the projection worker promptly and retry incomplete work.

The periodic/scheduled reconciliation path remains a safety net that can detect canonical revisions ahead of the materialized head and re-enqueue/rebuild missing projection work.

Retries must be bounded per attempt and rely on the existing resilient Dropbox transport for transient provider failures. A permanent/semantic conflict must remain visible and must not be silently overwritten.

## Revision coalescing

Human projections are current-state views, not the canonical historical ledger. Therefore intermediate unmaterialized revisions may be coalesced when a newer canonical revision supersedes them before publication.

Example:

```text
materialized_revision = 71
pending canonical revisions = 72, 73, 74, 75
```

The engine may project directly to revision 75 rather than fully publish 72, 73, and 74, provided:

- canonical commit records 72–75 remain untouched and queryable;
- no business effect is skipped;
- the generation ledger records older pending targets as superseded/coalesced rather than complete;
- any output/history contract that explicitly requires per-revision publication is excluded from coalescing;
- recovery can explain why the materialized head moved from 71 directly to 75.

Coalescing must reduce write amplification without changing canonical history.

## Bounded concurrency

Independent Dropbox output writes may execute concurrently through a small bounded worker pool.

Requirements:

- concurrency limit is explicit and configurable/testable rather than unbounded `Promise.all`;
- `STATE`/`HANDOFF` completion verification is ordered after prerequisite writes for the generation;
- one output failure does not corrupt successful output status;
- retries do not duplicate business operations;
- concurrency behavior is stress-tested under transient Dropbox faults.

The implementation plan should select a conservative initial concurrency default based on runtime/provider limits and tests, not intuition alone.

## Persistence-provider boundary

Dropbox remains the only production persistence provider in this package. `IMP-MATERIAL001` must not build SharePoint, Google Drive, S3, or local-disk providers.

However, new projection code must avoid spreading new Dropbox-specific assumptions through the business/projection planner. The writer should consume the existing transport/provider-style interface so `IMP-PERSIST001` can later formalize provider abstraction without rewriting the projection engine.

This package must not perform a broad premature persistence refactor; it should create clean seams only where required by the projection engine.

## Hot state versus durable external truth

### Dropbox / canonical external persistence

Dropbox currently owns durable, portable evidence including canonical commit records, project state snapshots, events, receipts, machine records, and human workspace files.

### Durable Object / SQLite

Durable Object SQLite may own hot operational projection state such as:

- target revision;
- latest complete materialized revision;
- output desired hashes;
- output status (`pending`, `written`, `verified`, `failed`);
- retry counters/timestamps;
- coalescing/supersession state.

This hot state must be treated as rebuildable operational acceleration, not the only copy of business truth.

## No direct PC access

This design explicitly excludes:

- direct access to arbitrary files on the user's computer;
- a local Project OS bridge;
- macOS/Windows filesystem permissions;
- a desktop daemon required for correctness;
- a local index that exists only on one user's machine.

The supported local path remains optional Dropbox Desktop synchronization for Obsidian/human use.

Any future non-Dropbox source connector would require its own explicitly approved package and security model.

## Observability emitted by this package

`IMP-MATERIAL001` should expose structured internal events/log fields sufficient for `IMP-OBSERVE001` to consume later.

At minimum, each projection attempt should make it possible to correlate:

- `project_id`;
- target canonical revision;
- materialization/generation identity;
- source transaction/event ID where available;
- outputs planned;
- outputs rendered;
- outputs skipped by hash;
- outputs uploaded;
- outputs verified;
- retry count;
- coalesced revisions;
- total materialization duration;
- final state (`complete`, `pending`, `failed`, `superseded`).

This package does not need to build a full metrics backend; it must produce consistent structured signals.

## Performance and efficiency acceptance criteria

The package must demonstrate all of the following in deterministic tests/benchmarks:

1. A mutation affecting one task does not upload unrelated task/decision/research/deliverable entity notes.
2. A global view whose rendered bytes are unchanged is not uploaded.
3. Exact replay of a completed materialization produces zero additional Dropbox writes for already verified outputs.
4. Recovery after a mid-generation crash resumes missing/uncertain outputs without creating a new business revision.
5. Multiple fast canonical revisions may coalesce to the newest safe target without deleting intermediate canonical commit records.
6. `STATE.md` and `HANDOFF.md` cannot cause the materialized head to advance unless both match the same target revision.
7. A transient Dropbox failure on one output is retried through existing resilience logic and does not force unrelated already verified outputs to be rewritten.
8. The business commit/receipt path no longer waits for full human-workspace materialization once the canonical durability contract is satisfied.
9. Existing recovery can reconstruct projection work after loss of hot/local projection state.
10. Production user/chat API behavior remains unchanged.

Exact latency SLO numbers are intentionally deferred to `IMP-PERF001`, which will establish measured product budgets at scale. `IMP-MATERIAL001` must nevertheless record enough timing/write-count data for those later benchmarks.

## Failure handling

### Canonical commit succeeds, projection fails

Business result remains committed. Projection generation remains pending/failed and is retried/reconciled. No rollback of canonical business history occurs.

### Output upload result is uncertain

Verify that single output against the desired content/hash, then mark it complete or retry. Do not rewrite the entire workspace.

### Existing destination contains different unexpected content

Fail closed for that output according to existing governed/machine-managed semantics. Do not silently merge or overwrite an unexplained conflicting reality merely to advance materialized head.

### Hot projection ledger is lost

Rebuild from canonical commits and complete-materialization evidence; do not ask the user to reconstruct the project.

### Newer revision arrives during an older projection

Planner/scheduler may coalesce the older incomplete target when safe. Never mark the older target complete unless it was actually fully verified.

### Archived project

Archive semantics remain governed by existing lifecycle behavior. Projection changes must preserve the invariant that archived workspaces do not reappear as active due to materialization retry.

## Compatibility constraints

- No transaction schema change is required solely for projection scheduling.
- No user-facing route or natural-language instruction change.
- No direct edits to machine-managed canonical Project OS state files.
- Existing commit records and recovery logic remain authoritative.
- Existing exact transaction replay/idempotency remains intact.
- Existing Dropbox resilient transport remains the retry layer for provider operations.
- Production layout remains V2.
- Production continuity mode remains `stable` throughout implementation and validation.

## Proposed component boundaries

The implementation plan should prefer focused modules rather than expanding `ProjectRepository` indefinitely. Expected responsibilities are:

### Projection planner

Consumes a validated canonical commit record/state and produces deterministic desired outputs with path, content, hash, criticality, and dependency metadata.

### Materialization coordinator

Owns target selection, coalescing, scheduling, generation status, resume, and completion-head advancement.

### Projection writer

Owns bounded provider writes, selective verification, and hash/idempotency behavior using the resilient transport.

### ProjectRepository

Remains the persistence adapter for canonical records and legacy-compatible operations. Existing `writeHumanViews()` behavior may be decomposed/replaced behind the new projection modules rather than becoming the new coordinator itself.

### ProjectGuard / worker routing

Commit path schedules projection work after canonical durability is established. Reconciliation paths can detect and repair projection lag.

The implementation plan must determine exact file names/interfaces after mapping current code, but these responsibility boundaries are normative.

## TDD and fault-testing strategy

Implementation must proceed test-first using the existing deterministic Dropbox fault harness.

Required proof cases include:

1. RED: current full materialization uploads unrelated entity notes after a one-task mutation.
2. GREEN: incremental entity planning avoids those uploads.
3. RED: current materialization rewrites an unchanged global view.
4. GREEN: hash equality skips the upload.
5. RED: injected crash after `STATE` but before `HANDOFF` leaves no proof that the newer generation is complete.
6. GREEN: materialized head stays on the prior complete revision and retry completes the pair from the same state.
7. Crash after N of M outputs; retry writes only missing/uncertain outputs.
8. Loss of hot projection state; reconstruction from canonical commits converges to the same complete generation.
9. Four rapid revisions while materialization lags; safe coalescing projects the newest state and preserves all four canonical commit records.
10. Transient write/list/download/move/delete failures remain compatible with `IMP-DROPRES001`.
11. Permanent/conflicting provider errors fail closed without advancing materialized head.
12. Bounded concurrency never exceeds configured limit in deterministic test instrumentation.
13. Archived project materialization remains archived and idempotent.
14. Existing commit crash-window, recovery, rollback, inbox, artifact, and rendering suites remain green.
15. `npm run check` passes.
16. `npx wrangler deploy --dry-run` passes.

## Production validation

`IMP-MATERIAL001` is not complete at merge time. Completion requires:

- final PR CI green on the exact final head;
- production deployment of the exact merge commit succeeds;
- production health check succeeds;
- production continuity configuration remains `stable`;
- a production-safe proof demonstrates canonical revision can be ahead of materialized revision and converge automatically without new business revision;
- a production-safe proof demonstrates unchanged output skip behavior or equivalent measurable write reduction;
- no user/chat workflow change;
- canonical PRJ-0002 evidence is recorded through receipt-gated Project OS transactions.

## Explicit non-goals

This package does **not** implement:

- direct PC/filesystem access;
- multi-tenant SaaS isolation;
- alternate persistence providers;
- full-text/vector search;
- final performance SLO budgets;
- automatic candidate deployment/cutover;
- a new end-user UI;
- schema migration machinery.

Those concerns belong to later approved roadmap packages.

## Relationship to revised roadmap

This package establishes the projection/read-model foundation required by later product-grade improvements:

- `IMP-ARTIFACT001` — destination concurrency/staleness safety;
- `IMP-SCHEMA001` — compatibility and migrations;
- `IMP-MODEL001` — formalized lifecycle/concurrency model;
- `IMP-PERSIST001` — provider abstraction beyond Dropbox-specific production assumptions;
- `IMP-INDEX001` — fast structured/full-text read/search model;
- `IMP-OBSERVE001` — product observability over projection/commit signals;
- `IMP-SECURITY001` — installation/client security hardening;
- `IMP-PERF001` — measured load/performance engineering;
- `IMP-DEPLOY001` — reproducible deployment and eventual transparent automatic cutover;
- `IMP-UX001` — zero-complexity user experience;
- `IMP-MAINT001` — maintainability, runbooks, and reconstruction documentation.

The complete approved sequence is recorded separately in `docs/project-os-improvement-roadmap.md`.
