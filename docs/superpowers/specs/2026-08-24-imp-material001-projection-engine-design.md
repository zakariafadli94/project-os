# IMP-MATERIAL001 — Projection Engine and Coherent Materialization Design

## Status

Architecture approved in chat on 2026-08-24. This written specification is awaiting final user review before implementation planning. No runtime behavior changes are authorized by this document alone. Production continuity mode remains `stable` until implementation is separately proven, merged, deployed, health-validated, and canonically closed.

## Goal

Turn Project OS materialization from a synchronous full-workspace rewrite into a production-grade projection engine that is fast, resumable, verifiable, reconstructible, and independent of any particular workstation.

A canonical business commit remains the durable truth. Human-facing Markdown, Obsidian views, and future read/search indexes are derived projections of that truth. Projection failure must never create an extra business revision, erase committed work, or require a user/chat to run a sync command.

## Product-level objective

Project OS should be viable as a robust R&D persistence layer outside chat, deployable as an isolated client installation without depending on a computer being online.

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
- `STATE.md` and `HANDOFF.md` are always rendered from the same canonical `ProjectState` target revision and the same projection version.
- Project OS never declares a target materialization complete until all required outputs for that target have been verified or explicitly carried forward from a previously verified generation.
- If projection work is interrupted, Project OS resumes automatically without creating a new business revision.
- Exact replay of projection work is idempotent.
- Dropbox remains the durable external persistence provider for the current product.
- Hot state introduced by this package must be reconstructible from canonical Dropbox records plus durable completed-materialization evidence.
- The architecture must not depend on a specific workstation being online.
- Production continuity remains `stable` while this package is introduced and validated.

## Current defect

`ProjectRepository.writeHumanViews()` currently rewrites every decision, constraint, task, research record, and deliverable, then rewrites all global human views (`BRIEF`, `DISCOVERY`, `ROADMAP`, `PROJECT`, `STATE`, `PLAN`, `HANDOFF`) for every materialized project-state revision.

This creates five product-level problems:

1. **write amplification** — unrelated entities are repeatedly uploaded even when their semantic content did not change;
2. **latency coupling** — the business commit path waits for potentially many Dropbox writes;
3. **mixed-generation crash windows** — interruption can leave `STATE.md`, `HANDOFF.md`, and other views reflecting different source revisions while the canonical commit is already newer;
4. **poor resumability** — materialization is retried as a monolithic procedure rather than explicit per-output work with progress;
5. **revision-induced false changes** — current frontmatter includes the project revision, so blindly rendering every file from every new `ProjectState` makes bytes change even when the note's actual business content did not.

The fifth issue is important: simple byte hashing after full re-render is not sufficient to eliminate unnecessary writes because a newer global project revision would change frontmatter on otherwise unchanged notes.

## Chosen approach

Implement an asynchronous, generation-aware projection engine with four layers:

1. **canonical target** — the immutable commit record / committed `ProjectState` revision to project;
2. **projection planner** — determines expected outputs and their semantic input fingerprints;
3. **materialization coordinator/ledger** — tracks target revision, projection version, output progress, retries, carry-forward, and supersession/coalescing;
4. **persistence writer** — writes only changed outputs to Dropbox with bounded concurrency, verifies uncertain results, and publishes durable completion evidence.

The canonical commit record remains business truth. Durable completed-materialization records are projection evidence. Hot per-output progress may live in Durable Object SQLite but must never be the only recoverable record of a completed generation.

## Canonical commit path versus projection path

### Required target architecture

A successful transaction should converge toward:

```text
validate transaction
    -> write immutable canonical commit record
    -> persist/return committed business receipt
    -> schedule projection target
    -> project asynchronously
```

Human-view materialization must no longer be a prerequisite for acknowledging the durable business result once the canonical commit/receipt contract is satisfied.

Scheduling itself is not business truth. If immediate scheduling fails after commit, the canonical commit remains valid and periodic/reconciliation logic must later detect projection lag and recover it.

### Important compatibility constraint

`IMP-MATERIAL001` must preserve the `IMP-COMMIT001` rule that the immutable commit record is canonical commit truth. Any reordering of standalone receipts, snapshots, or view publication must be proven against existing crash-window tests. The implementation plan must not weaken durability to gain latency.

## Projection version

A materialization generation is identified by both:

- canonical target revision; and
- **projection version** (renderer/projection schema version).

Conceptually:

```text
project_id: PRJ-0002
target_revision: 72
projection_version: 2
```

This is required because renderer behavior may legitimately change during a software upgrade even when the project's business revision does not.

A new projection version must be able to rematerialize the current canonical revision **without creating a new business revision**.

Renderer/projection-version changes invalidate relevant semantic input fingerprints so stale bytes are not incorrectly carried forward.

## Materialization generation model

Each target generation is scoped by project, canonical revision, and projection version.

Conceptually:

```text
project_id: PRJ-0002
target_revision: 72
projection_version: 2
status: pending | running | complete | superseded
outputs:
  STATE.md:
    input_hash: ...
    content_hash: ...
    source_revision: 72
    status: verified
  BRIEF.md:
    input_hash: ...
    content_hash: ...
    source_revision: 68
    status: carried_forward
```

`source_revision` means the business revision whose semantic content last required physical rendering of that output. It does **not** have to equal the generation target revision for non-critical carried-forward views.

A generation becomes `complete` only after every required output is either:

- physically verified at its desired content hash; or
- safely carried forward from a previously completed generation because its semantic input fingerprint and projection version are unchanged.

## Durable completion evidence

Completed materialization evidence must survive loss of Durable Object hot state.

The target design requires:

1. an **immutable completed-generation record** in machine-managed durable external storage containing at minimum project ID, target revision, projection version, output paths, semantic input hashes, content hashes, source revisions, and completion timestamp;
2. a small **materialization head** record pointing to the latest completed generation for the project.

Publication order is:

```text
verify all generation outputs
    -> publish immutable completed-generation record
    -> advance materialization head
```

If the head write fails after the immutable generation record exists, reconciliation can safely repair the head. The head must never advance before the immutable completed-generation record exists.

Hot per-output progress does not need to be copied to Dropbox after every output; doing so would recreate write amplification. It is an optimization ledger, while the completed-generation record is the durable projection checkpoint.

## Semantic input fingerprints versus content hashes

The engine uses two different hashes for two different purposes.

### `input_hash`

A deterministic fingerprint of the **semantic inputs** that affect one output, plus projection version.

It excludes the global project revision unless that revision is intentionally part of the view's semantics.

Purpose:

- decide whether an output needs to be re-rendered at all;
- safely carry an unchanged output into a newer generation without touching Dropbox;
- avoid false changes caused only by revision-bearing frontmatter.

### `content_hash`

A hash of the exact persisted output bytes.

Purpose:

- idempotency;
- post-failure verification;
- conflict detection;
- durable completed-generation evidence.

### Carry-forward rule

If a previous completed generation has the same `input_hash` for an output under the same projection version, the new generation may carry forward its previous `content_hash` and `source_revision` with **zero render and zero Dropbox write**.

If the semantic input hash changed, the output is rendered for the new target and verified by content hash.

This distinction is a hard architectural requirement.

## Frontmatter and revision semantics

Current project notes embed a `revision` value. Under incremental materialization, non-critical files may retain an older revision because their content was safely carried forward unchanged.

For non-head/entity/content views, that revision is interpreted as the **source/content revision of the persisted bytes**, not a promise that every file in the workspace was physically rewritten at the latest project revision.

Generation coherence is represented by the completed-generation manifest/head, not by forcing every Markdown file to contain the same revision number.

`STATE.md` and `HANDOFF.md` are different: they are head/recovery views and must always be physically generated for the completed target revision so they agree with the materialization head.

Machine recovery must not infer global project freshness from an arbitrary entity note's frontmatter. It uses canonical state plus materialization evidence.

## Projection planning

### Critical head views

The following are critical for project resumption and must be generated/verified for the target generation:

- `STATE.md`
- `HANDOFF.md`

Their `input_hash` intentionally includes the canonical target revision and projection version, so a completed materialization head always has an explicitly current pair.

### Other global aggregate views

The following global views are cheap to render but should not be physically rewritten when their semantic inputs are unchanged:

- `BRIEF.md`
- `DISCOVERY.md`
- `ROADMAP.md`
- `PROJECT.md`
- `PLAN.md`

The planner defines deterministic semantic dependencies for each renderer and computes an `input_hash`. If unchanged from the prior completed generation, the previous file is carried forward. If changed, the view is rendered in memory and persisted only when required.

### Entity views

Entity notes are incremental. The planner identifies affected decisions, constraints, tasks, research records, and deliverables from the committed event/transaction/state delta.

The implementation must remain conservative: when dependency analysis is uncertain, it may mark an output as potentially changed. It must then compute the correct semantic input fingerprint rather than blindly rewrite it.

Correctness has priority over saving render CPU; network write reduction is the main optimization target.

### Determinism

For a given projection version and semantic input set, `input_hash`, rendered bytes, and `content_hash` must be deterministic.

## Hash-based write elimination

Required behavior:

- same semantic `input_hash` as a prior completed generation -> carry forward, no render/write;
- newly rendered bytes whose destination is already verified at the same `content_hash` -> no upload;
- uncertain provider result -> verify only the specific uncertain output;
- unchanged entity/content view -> no Dropbox write merely because project revision increased;
- exact replay of a completed generation -> zero additional Dropbox writes.

This is a hard efficiency acceptance criterion, not an optional optimization.

## `STATE.md` and `HANDOFF.md` coherence

`STATE.md` and `HANDOFF.md` are critical recovery/read surfaces and receive special treatment.

For each generation:

1. both are rendered from exactly the same target `ProjectState` object/revision;
2. both use the same projection version;
3. both include the same target project revision in frontmatter/body where applicable;
4. both are persisted near the end of generation publication;
5. both are verified against desired hashes/content before generation completion;
6. immutable completed-generation evidence is not published if either one is missing, stale, or mismatched.

Dropbox does not provide a general atomic transaction that makes two independent files visible simultaneously. This package does **not** claim impossible multi-file visibility atomicity to arbitrary manual Dropbox readers.

The precise guarantee is: **Project OS never treats a partially published pair as a complete coherent generation.** Machine consumers prefer canonical state or the last completed materialization when the current target is incomplete.

## Materialized head semantics

Project OS must distinguish:

```text
canonical_revision = 72
materialized_head = { revision: 71, projection_version: 2 }
```

from:

```text
canonical_revision = 72
materialized_head = { revision: 72, projection_version: 2 }
```

and from a renderer upgrade such as:

```text
canonical_revision = 72
materialized_head = { revision: 72, projection_version: 1 }
target_projection_version = 2
```

The head may advance only after complete immutable generation evidence exists. It must never advance optimistically.

## Resume semantics

Projection work is resumable per output.

If a target generation contains 20 outputs and 17 are complete before a crash, recovery should resume remaining/uncertain outputs rather than blindly rewrite all 20.

Required recovery sources, in order of authority:

1. canonical commit record for the target revision;
2. validated target `ProjectState` contained in that record;
3. latest immutable completed-generation record/head;
4. hot materialization progress if available;
5. selective Dropbox verification for outputs whose new-state completion is uncertain.

If Durable Object hot projection state is lost mid-generation, the coordinator reconstructs the target plan from canonical state, compares semantic input hashes against the last completed generation, carries forward unchanged outputs, and selectively verifies or writes changed outputs.

Projection recovery never increments the project business revision.

## Scheduling and retry

Preferred path: schedule projection promptly after canonical commit rather than waiting for periodic inbox scans.

Durable Object alarm/scheduling or an equivalent internal mechanism should wake projection work and retry incomplete targets.

Periodic/scheduled reconciliation remains a safety net that can detect:

- canonical revision ahead of materialized head;
- projection version ahead of materialized head;
- completed immutable generation whose head pointer was not advanced;
- lost hot progress.

Retries are bounded per attempt and use the existing resilient Dropbox transport for transient provider failures. Permanent/semantic conflicts remain visible and are not silently overwritten.

## Revision coalescing

Human projections are current-state views, not the canonical historical ledger. Intermediate unmaterialized **business revisions** may therefore be coalesced when a newer canonical revision supersedes them before publication.

Example:

```text
materialized_revision = 71
pending canonical revisions = 72, 73, 74, 75
```

The engine may project directly to revision 75 rather than fully publish 72, 73, and 74, provided:

- canonical commit records 72–75 remain untouched and queryable;
- no business effect is skipped;
- hot ledger records older pending targets as superseded/coalesced rather than complete;
- no contract requiring per-revision human publication is skipped;
- recovery can explain why materialized head moved from 71 directly to 75.

Projection-version upgrades are not silently coalesced away if the current target explicitly requires the newer projection version.

## Bounded concurrency

Independent Dropbox output writes may execute concurrently through a small bounded worker pool.

Requirements:

- concurrency limit is explicit and configurable/testable rather than unbounded `Promise.all`;
- `STATE`/`HANDOFF` completion verification is ordered after prerequisite writes for the generation;
- one output failure does not corrupt successful output status;
- retries do not duplicate business operations;
- concurrency behavior is stress-tested under transient Dropbox faults.

The implementation plan selects a conservative initial default from runtime/provider constraints and measurement, not intuition alone.

## Persistence-provider boundary

Dropbox remains the only production persistence provider in this package. `IMP-MATERIAL001` must not build SharePoint, Google Drive, S3, or local-disk providers.

New projection code must avoid spreading new Dropbox-specific assumptions through business/projection planning. Writer/coordinator code should consume the existing transport/provider-style boundary so `IMP-PERSIST001` can later formalize provider abstraction without rewriting the projection engine.

This package must not perform a broad premature persistence refactor; it creates clean seams only where required by the projection engine.

## Hot state versus durable external truth

### Dropbox / durable external persistence

Dropbox currently owns durable, portable evidence including:

- immutable canonical commit records;
- canonical snapshots/events/receipts;
- human workspace files;
- immutable completed-materialization records introduced by this package;
- materialization-head pointer/checkpoint introduced by this package.

### Durable Object / SQLite

Durable Object SQLite may own hot operational projection state such as:

- current target revision/projection version;
- per-output `input_hash` / desired `content_hash`;
- output state (`pending`, `written`, `verified`, `failed`, `carried_forward`);
- retry counters/timestamps;
- coalescing/supersession state;
- immediate work scheduling metadata.

This hot state is rebuildable acceleration, not business truth and not the only completed-generation evidence.

## No direct PC access

This design explicitly excludes:

- direct access to arbitrary files on the user's computer;
- a local Project OS bridge;
- macOS/Windows filesystem permissions;
- a desktop daemon required for correctness;
- a local index that exists only on one user's machine.

The supported local path remains optional Dropbox Desktop synchronization for Obsidian/human use.

Any future non-Dropbox source connector requires its own explicitly approved package and security model.

## Observability emitted by this package

`IMP-MATERIAL001` should expose structured internal signals sufficient for later `IMP-OBSERVE001`.

At minimum, each projection attempt should correlate:

- `project_id`;
- canonical target revision;
- projection version;
- materialization/generation identity;
- source transaction/event ID where available;
- outputs planned;
- outputs carried forward;
- outputs rendered;
- outputs skipped by verified content hash;
- outputs uploaded;
- outputs verified;
- retry count;
- coalesced revisions;
- total materialization duration;
- final state (`complete`, `pending`, `failed`, `superseded`).

This package does not build a full metrics backend; it emits consistent structured signals.

## Performance and efficiency acceptance criteria

The package must demonstrate all of the following in deterministic tests/benchmarks:

1. A mutation affecting one task does not upload unrelated task/decision/research/deliverable entity notes.
2. A task-only mutation does not rewrite `BRIEF.md` when its semantic `input_hash` is unchanged, even though the project revision increased.
3. Exact replay of a completed materialization produces zero additional Dropbox writes.
4. Recovery after a mid-generation crash resumes missing/uncertain outputs without creating a new business revision.
5. Multiple fast canonical revisions may coalesce to the newest safe target without deleting intermediate canonical commit records.
6. `STATE.md` and `HANDOFF.md` cannot advance completed materialization evidence unless both match the same target revision and projection version.
7. A transient Dropbox failure on one output does not force unrelated already verified/carried-forward outputs to be rewritten.
8. The business commit/receipt path no longer waits for full human-workspace materialization once canonical durability is satisfied.
9. Loss of hot projection state can reconstruct target work from canonical commits and durable completed-generation evidence.
10. A projection-version upgrade can rematerialize the current canonical business revision without generating a new business revision.
11. Completed immutable generation evidence is published before materialization head advances.
12. Production user/chat API behavior remains unchanged.

Exact latency SLO numbers are deferred to `IMP-PERF001`, which will establish measured product budgets at scale. `IMP-MATERIAL001` must record enough timing/write-count data for those later benchmarks.

## Failure handling

### Canonical commit succeeds, projection fails

Business result remains committed. Projection generation remains pending/failed and is retried/reconciled. No rollback of canonical business history occurs.

### Immediate scheduling fails

Business result remains committed. Structured failure is recorded; periodic reconciliation detects canonical/materialization lag and rebuilds the target.

### Output upload result is uncertain

Verify that specific output against desired content/hash, then mark it complete or retry. Do not rewrite the entire workspace.

### Existing destination contains different unexpected content

Fail closed for that output according to existing governed/machine-managed semantics. Do not silently merge or overwrite unexplained conflicting reality merely to advance materialized head.

### Hot projection ledger is lost

Rebuild from canonical commits and durable completed-materialization evidence; do not ask the user to reconstruct the project.

### Materialization head update fails after generation record publication

The immutable completed-generation record remains valid evidence. Reconciliation repairs the head pointer without rerunning business operations.

### Newer revision arrives during an older projection

Planner/scheduler may coalesce the older incomplete target when safe. Never mark the older target complete unless it was actually fully verified/published.

### Projection version changes

Current canonical revision is scheduled again under the new projection version. No business revision is created merely to refresh derived representations.

### Archived project

Archive semantics remain governed by existing lifecycle behavior. Projection retry must preserve the invariant that archived workspaces do not reappear as active.

## Compatibility constraints

- No transaction schema change is required solely for projection scheduling.
- No user-facing route or natural-language instruction change.
- No direct edits to machine-managed canonical Project OS state files.
- Existing commit records and recovery logic remain authoritative.
- Existing exact transaction replay/idempotency remains intact.
- Existing Dropbox resilient transport remains the retry layer for provider operations.
- Production layout remains V2.
- Production continuity mode remains `stable` throughout implementation and validation.
- Arbitrary entity-note frontmatter must not be used as the authoritative current project revision after incremental carry-forward is introduced.

## Proposed component boundaries

The implementation plan should prefer focused modules rather than expanding `ProjectRepository` indefinitely.

### Projection planner

Consumes validated canonical commit/state plus projection version and produces deterministic desired outputs containing at least:

- path;
- semantic dependency/input fingerprint;
- whether the output is critical/head-level;
- render function or rendered content when needed;
- source entity/type metadata.

### Materialization coordinator

Owns:

- target selection;
- projection-version selection;
- coalescing;
- scheduling;
- hot generation status;
- resume/rebuild;
- immutable completion-record publication;
- materialization-head advancement/repair.

### Projection writer

Owns bounded provider writes, selective verification, content-hash idempotency, and conflict surfacing using resilient transport.

### ProjectRepository

Remains persistence adapter for canonical records and compatibility operations. Existing `writeHumanViews()` behavior may be decomposed/replaced behind projection modules rather than becoming the coordinator itself.

### ProjectGuard / worker routing

Commit path schedules projection work after canonical durability is established. Reconciliation paths detect/repair projection lag without changing the business result.

The implementation plan determines exact file names/interfaces after mapping current code, but these responsibility boundaries are normative.

## TDD and fault-testing strategy

Implementation must proceed test-first using the existing deterministic Dropbox fault harness.

Required proof cases include:

1. RED: current full materialization uploads unrelated entity notes after a one-task mutation.
2. GREEN: incremental entity planning avoids those uploads.
3. RED: current revision-bearing frontmatter forces `BRIEF.md` bytes to change after an unrelated task mutation.
4. GREEN: semantic `input_hash` carries `BRIEF.md` forward with zero Dropbox write.
5. RED: injected crash after `STATE` but before `HANDOFF` has no valid newer complete-generation record.
6. GREEN: materialization head stays on prior complete generation and retry completes the pair from the same target state.
7. Crash after N of M changed outputs; retry writes only missing/uncertain changed outputs.
8. Loss of hot projection state; reconstruction from canonical commits + completed-generation record converges to same generation.
9. Four rapid revisions while materialization lags; safe coalescing projects newest state and preserves all four canonical commit records.
10. Renderer/projection version bump at unchanged business revision rematerializes required outputs without new domain event/revision.
11. Transient write/list/download/move/delete failures remain compatible with `IMP-DROPRES001`.
12. Permanent/conflicting provider errors fail closed without advancing materialization head.
13. Bounded concurrency never exceeds configured limit in deterministic instrumentation.
14. Failure after immutable completed-generation record but before head update is repaired without rewriting verified outputs.
15. Archived project materialization remains archived and idempotent.
16. Existing commit crash-window, recovery, rollback, inbox, artifact, and rendering suites remain green.
17. `npm run check` passes.
18. `npx wrangler deploy --dry-run` passes.

## Production validation

`IMP-MATERIAL001` is not complete at merge time. Completion requires:

- final PR CI green on exact final head;
- production deployment of exact merge commit succeeds;
- production health check succeeds;
- production continuity remains `stable`;
- production-safe proof demonstrates canonical revision can be ahead of materialized head and converge automatically without new business revision;
- production-safe proof demonstrates at least one unrelated/unchanged output is carried forward with no upload;
- production-safe proof demonstrates `STATE` and `HANDOFF` belong to the same completed generation;
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
- general schema migration machinery.

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
