# IMP-MODEL001 — Formal Lifecycle and Concurrency Model

Status: design approved by user on 2026-08-25; written specification pending final written-spec review before implementation planning.

Validated against:

- PRJ-0002 canonical revision `85`;
- GitHub `main` commit `820030be0f775aa89689a4bdb56ac6495e21dfe1`;
- `docs/project-os-improvement-roadmap.md` package `IMP-MODEL001`;
- current `src/domain/project-state.ts`, `src/domain/transaction.ts`, `src/domain/transitions.ts`, `src/domain/project-state-normalizer.ts`;
- current `docs/project-os-sop.md` concurrency, lifecycle, authority and receipt contracts.

## 1. Goal

Stabilize Project OS domain lifecycle and concurrency semantics before persistence-provider abstraction, indexing and product read models depend on them.

MODEL001 makes the current domain rules explicit, deterministic and testable while preserving the existing persisted `ProjectState 1.0` shape and transaction schema.

The package closes ambiguity in stale transaction handling and phase lifecycle behavior without introducing a schema migration.

## 2. Non-goals and dependency boundary

MODEL001 does **not**:

- bump `ProjectState.schema_version`;
- add fields to `ProjectState`, task, phase, decision, research or deliverable records;
- add new public transaction operations or payload fields;
- add persisted task dependency graphs such as `depends_on`;
- add per-entity revision/version counters;
- add a persisted research lifecycle/status field;
- implement `IMP-SCHEMA001` readers, writers, upcasters or migrations;
- change MutationGate from `observe` to `enforce`;
- repair or reconcile historical PRJ-0003 mutation deviations;
- alter the canonical commit boundary, materialization architecture or managed-document lifecycle;
- introduce distributed locks or a second concurrency coordinator;
- infer new aggregate parent/child completion dependencies that the current model cannot represent safely.

Any model capability requiring new persisted structure belongs behind `IMP-SCHEMA001` or a later explicitly approved package.

## 3. Existing architecture retained

ProjectGuard remains the per-project serialization boundary. Before applying a transaction, it reconciles canonical commit history and invokes the deterministic domain transition function against the latest known current state.

MODEL001 therefore does not add a new locking layer. It defines which transactions are allowed to rebase over intervening commits and which must conflict when their `base_revision` is stale.

Canonical truth remains:

1. immutable validated canonical commit records;
2. the resulting current `ProjectState` reconstructed from that history;
3. reconstructible snapshots and Markdown projections.

A projection or snapshot is never promoted to business history merely because it is newer or visible.

## 4. Compatibility model

### 4.1 Existing records remain readable

MODEL001 applies stricter invariants to **new mutations**, not to historical snapshot loading.

Existing persisted `ProjectState 1.0` records remain readable when they satisfy the existing schema/normalizer contract, even if historical state contains a combination that new transitions would no longer create.

Example: an archived historical project may still contain an active plan phase in its snapshot. MODEL001 must not make that historical project unrecoverable or silently rewrite it.

### 4.2 No hidden migration

MODEL001 performs no read-time rewriting, no business revision for cleanup and no bulk normalization of historical states.

If a future package wants to strengthen persisted-state validation itself, that work must be handled under schema compatibility/migration rules.

## 5. Concurrency contract

### 5.1 Definitions

A transaction is **current** when:

```text
transaction.base_revision == current_project.revision
```

A transaction is **stale** when:

```text
transaction.base_revision < current_project.revision
```

A transaction with `base_revision > current_project.revision` remains a `REVISION_AHEAD` conflict.

### 5.2 Rule

Only operations whose semantics are independent append/create operations may rebase over a stale project revision.

All lifecycle mutations, direction-changing mutations and replacement-style mutations require the exact current project revision.

### 5.3 Exact-current operations

The following families require `base_revision == current revision`:

- project lifecycle: `project.pause`, `project.resume`, `project.complete`, `project.archive`;
- project framing replacement: `project.framing.update`;
- artifact routing: `artifact.route.configure`;
- decisions: `decision.accept`, `decision.supersede`;
- task lifecycle: `task.start`, `task.complete`, `task.block`;
- plan lifecycle/content: `plan.phase.create`, `plan.phase.update`, `plan.phase.complete`;
- discovery synthesis replacement: `discovery.synthesis.update`;
- normative deliverables: `deliverable.create`, `deliverable.start`, `deliverable.revise`, `deliverable.submit_review`, `deliverable.accept`, `deliverable.supersede`, `deliverable.abandon`;
- legacy deliverable lifecycle mutation: `deliverable.complete`.

A stale request in these families returns a deterministic `conflict`, not a semantic auto-merge and not an order-dependent commit.

### 5.4 Stale-rebasable operations

The only stale-rebasable existing operations are:

- `research.add`;
- `constraint.add`;
- `task.create`;
- deprecated compatibility operation `deliverable.add`.

They remain eligible only when their target ID is still unused and all current-state references/invariants still validate.

This is revalidation against current state, not blind stale acceptance.

### 5.5 Why `task.create` remains rebasable

Creating a new task with a globally unique task ID is independent of an unrelated concurrent task/research mutation, provided any referenced phase still exists and remains valid for new work.

If the referenced phase is no longer eligible, the transaction is rejected against current state.

### 5.6 Why task lifecycle becomes exact-current

`task.start`, `task.block` and `task.complete` change the same mutable lifecycle state. Accepting them from a stale project revision can make the outcome depend on request arrival order.

MODEL001 deliberately trades permissive stale completion for deterministic conflict behavior.

## 6. Project lifecycle

Persisted statuses remain:

```text
active
paused
completed
archived
```

Allowed project transitions remain:

```text
active -> paused
paused -> active
active -> completed
paused -> completed
active -> archived
paused -> archived
completed -> archived
```

`archived` is terminal.

`completed` accepts only archival as a later canonical project mutation under the current V1 contract.

MODEL001 does not redefine `paused` as a universal hard freeze of every child entity. It remains the existing project lifecycle status; any future stronger pause policy would require a separate decision because it could change normal workflow semantics.

Project completion remains an explicit project-level decision. MODEL001 does not infer project completion from child entities and does not newly require every task, phase or deliverable to be terminal before `project.complete`. The current model has no task cancellation/dependency semantics sufficient to make such an aggregate gate safe without changing established workflows.

## 7. Task lifecycle

Persisted task statuses remain:

```text
pending
active
blocked
completed
```

Allowed transitions are:

```text
pending -> active
pending -> blocked
pending -> completed
active  -> blocked
active  -> completed
blocked -> active
blocked -> blocked   (explicit blocked-reason refresh)
blocked -> completed
```

`completed` is terminal.

Rationale for direct `pending -> completed`: Project OS supports natural-language operational work where a small task may be created and then immediately reported complete without an artificial mandatory start transaction.

`task.start` clears `blocked_reason`.

`task.complete` clears `blocked_reason` and may store the optional result.

`task.block` requires a non-completed task and stores the explicit reason. When the task is already blocked, an exact-current `task.block` may replace the block reason while keeping the task blocked; this preserves the existing only-way-to-refresh-block-context behavior without treating it as a stale merge.

All task lifecycle mutations require exact current project revision.

## 8. Plan phase lifecycle

Persisted phase statuses remain:

```text
pending
active
completed
```

### 8.1 Single-current-phase invariant

For states created or mutated under MODEL001:

- at most one phase is `active`;
- when an active phase exists, `current_phase_id` points to that phase;
- a `pending` phase is not current;
- a `completed` phase is terminal.

Historical states remain readable under the compatibility rule in section 4.

### 8.2 Creation

`plan.phase.create` remains exact-current.

If no phase exists, the first phase becomes `active` and becomes `current_phase_id`.

Later phases are created as `pending`.

### 8.3 Update

A completed phase cannot be updated.

Pending and active phases may be updated while they remain non-terminal.

### 8.4 Completion

Only the phase that is both:

```text
phase.status == active
and
phase.phase_id == current_phase_id
```

may be completed.

Attempting to complete a pending/non-current phase is rejected.

After completion, the next pending phase is promoted deterministically using the current compatibility rule: lexicographically lowest `phase_id`. Introducing explicit phase ordering would require a separately approved model/schema capability.

If there is no pending phase, `current_phase_id` becomes `null`.

### 8.5 New work cannot attach to a completed phase

`task.create` and normative `deliverable.create` reject a referenced `phase_id` whose phase is completed.

They may attach to an existing active or pending phase.

This prevents new operational work from being introduced into a phase whose lifecycle has already closed while preserving advance planning against pending phases.

### 8.6 No inferred child-completion dependency in MODEL001

Completing the current phase does not newly require every task or deliverable attached to that phase to be terminal.

That stronger dependency rule is intentionally not introduced because the existing task model has no explicit cancelled/abandoned task state and no persisted dependency graph. Enforcing aggregate child closure now could strand legitimate workflows or force false `completed` records.

MODEL001 formalizes phase identity/progression and concurrency only. Explicit dependency gates remain a later, separately designed capability.

## 9. Decision lifecycle

Persisted statuses remain:

```text
accepted
superseded
```

Decisions are immutable historical records after acceptance except for explicit supersession metadata on the replaced decision.

`decision.supersede` requires:

- distinct original and replacement IDs;
- both records to exist;
- both records to be currently `accepted`;
- exact current project revision.

The original becomes `superseded`; the replacement remains `accepted`.

History is never deleted or rewritten.

## 10. Research model

Research remains append-only evidence with no persisted lifecycle status.

`research.add` may rebase over a stale revision only if its research ID is still unused.

Discovery synthesis remains the mutable current interpretation layer:

- confirmed findings;
- provisional findings;
- unresolved questions;
- next exploration.

Every referenced research ID in a discovery synthesis must exist in current state.

Changing a synthesis is replacement-style current-state editing and therefore requires exact current project revision.

## 11. Deliverable lifecycle

Persisted normative statuses remain:

```text
planned
in_progress
review
accepted
superseded
abandoned
legacy_completed
```

Normative lifecycle:

```text
planned -> in_progress -> review -> accepted
                 ^          |
                 |----------| revise
```

`deliverable.revise` requires a changed version and returns the item to `in_progress`.

`accepted`, `superseded` and `abandoned` remain terminal for normative work.

An accepted deliverable may be superseded only by another accepted deliverable.

`legacy_completed` remains a compatibility state and does not imply acceptance. Existing explicit compatibility paths remain exactly defined: `legacy_completed -> accepted` through `deliverable.accept` with an explicit acceptance note, or `legacy_completed -> abandoned` through `deliverable.abandon` with an explicit reason.

### 11.1 Reference invariants

For new normative `deliverable.create`:

- referenced `phase_id`, if present, must exist and must not be completed;
- every `decision_id` must exist and be currently `accepted`.

A superseded decision remains historical evidence but cannot newly govern a deliverable.

### 11.2 Legacy operations

`deliverable.add` remains a deprecated additive compatibility operation and may rebase when its new ID remains unused.

`deliverable.complete` mutates lifecycle and therefore becomes exact-current.

No legacy operation may infer explicit user acceptance.

## 12. Artifact-route governing decisions

Existing artifact route rules already require accepted governing decisions.

MODEL001 preserves that contract and documents the general invariant:

> A new current-state relationship that claims to be governed by a decision must reference a decision that is currently accepted, not merely historically present.

Existing historical relationships are not rewritten merely because their governing decision is later superseded.

## 13. Current state versus immutable history

MODEL001 formalizes the following compatibility contract for later `IMP-PERSIST001` and `IMP-INDEX001`:

### Immutable history

Canonical commit records and their domain events record what happened in revision order.

Superseded decisions/deliverables remain represented rather than erased.

### Current state

`ProjectState` is the latest current model obtained from canonical history.

Lifecycle statuses such as `accepted`, `superseded`, `active` and `completed` are current-state interpretations backed by immutable historical transitions.

### Projections/read models

Markdown, materialization snapshots and future indexes/read models are derived representations.

They may lag canonical history and must remain reconstructible. They do not define business truth independently.

## 14. Determinism and error classification

MODEL001 preserves the existing result categories:

- `commit`: valid mutation creating one new canonical project revision;
- `rejected`: operation is invalid against the current business state;
- `conflict`: request cannot safely apply because its concurrency precondition is stale/ahead.

Stale exact-current operations use `conflict`.

Examples of current-state invalidity such as "completed task is terminal", "phase is not current", "referenced phase is completed", or "governing decision is superseded" use `rejected`.

This distinction allows callers to tell concurrency retry/review situations apart from invalid requested business transitions.

## 15. Implementation shape

The implementation should keep transition semantics focused in `src/domain/`.

Preferred shape:

- introduce a small explicit concurrency-policy helper/table in the domain layer rather than growing another ad-hoc set in `applyTransaction`;
- keep lifecycle legality in deterministic pure transition logic;
- avoid changing ProjectGuard orchestration except where tests demonstrate a necessary integration assertion;
- do not change Durable Object serialization, canonical commit ordering or Dropbox repository behavior;
- update SOP/model documentation to reflect the exact implemented rules.

The exact file split is finalized in the implementation plan after written-spec review.

## 16. TDD acceptance matrix

Implementation must begin with failing tests that prove the current ambiguities.

### 16.1 Concurrency

Tests must cover:

- stale `task.start` conflicts;
- stale `task.block` conflicts;
- stale `task.complete` conflicts;
- stale `deliverable.complete` conflicts;
- stale independent `research.add` still commits when ID is new;
- stale independent `constraint.add` still commits when ID is new;
- stale `task.create` commits when ID is new and referenced phase remains eligible;
- stale `task.create` rejects if its referenced phase became completed;
- exact-current direction/lifecycle mutations preserve existing valid behavior;
- `REVISION_AHEAD` behavior remains unchanged.

### 16.2 Task lifecycle

Tests must cover every allowed task transition, exact-current blocked-reason refresh, and representative forbidden/terminal transitions.

### 16.3 Phase invariants

Tests must cover:

- first phase becomes active/current;
- later phase is pending;
- pending phase cannot be completed directly;
- only active/current phase completes;
- deterministic lexicographic `phase_id` promotion of the next pending phase;
- no remaining pending phase clears `current_phase_id`;
- completed phase cannot be updated;
- new task cannot attach to completed phase;
- new normative deliverable cannot attach to completed phase;
- phase completion does not fabricate child completion or require unavailable task-cancellation semantics.

### 16.4 Decision/research/deliverable invariants

Tests must cover:

- superseded decision cannot newly govern a normative deliverable;
- accepted decision may govern a deliverable;
- decision supersession preserves both records;
- research remains append-only;
- discovery references only existing research;
- accepted/superseded/abandoned deliverable behavior remains compatible;
- legacy completion does not imply acceptance;
- explicit legacy acceptance and abandonment remain compatible;
- deliverable supersession preserves historical output.

### 16.5 Compatibility/recovery

Tests must prove:

- historical schema-1.0 snapshots that are structurally valid remain readable even when they contain a historical lifecycle combination that new mutations would no longer create;
- loading history does not create a business revision;
- canonical commit replay/recovery still produces the same final current state;
- project/phase parent lifecycle does not retroactively rewrite child states;
- no test requires MutationGate enforcement, PRJ-0003 repair or SCHEMA runtime behavior.

### 16.6 Regression

The exact final implementation head must pass the full repository verification gate (`npm run check`) and Wrangler dry-run before merge/deployment review.

## 17. Rollout and production proof

MODEL001 has no feature flag and no schema migration.

Production rollout remains an exact-commit normal deployment with continuity `stable` and MutationGate remaining `observe`.

Production validation must prove at minimum:

1. production health succeeds on the exact merge commit;
2. continuity remains `stable`;
3. MutationGate remains `observe`;
4. a controlled current-revision lifecycle transaction behaves normally;
5. a controlled stale lifecycle transaction returns conflict and creates no project revision;
6. a controlled stale independent additive transaction can still commit when its current-state invariants remain valid;
7. existing projects remain readable/recoverable;
8. no PRJ-0003 repair and no SCHEMA runtime implementation occurs as part of MODEL rollout.

Production probes must avoid creating unnecessary lasting business facts; where a durable proof transaction is required, use a dedicated safe Project OS test context or an explicitly appropriate operational project and record the exact evidence.

## 18. Rollback

Because MODEL001 changes transition behavior but not persisted structure, rollback is code rollback to the previous compatible reader/runtime.

Canonical commits already created under MODEL001 remain valid schema-1.0 history.

Rollback must never rewind committed history or rewrite ProjectState records.

If rollback would re-enable a stale behavior that MODEL001 intentionally prohibited, that is an execution-path compatibility concern, not a reason to rewrite canonical history.

## 19. Completion gate

MODEL001 is complete only after:

- this written spec is explicitly reviewed/accepted;
- an implementation plan is written and explicitly approved;
- implementation follows TDD on an isolated branch/worktree;
- targeted tests and full `npm run check` pass on the exact final implementation head;
- Wrangler deploy dry-run passes;
- implementation PR is reviewed and merged;
- exact merge commit is deployed to production;
- health and production behavior proof succeed;
- continuity remains `stable`;
- MutationGate remains `observe` unless a completely separate explicit enforcement decision exists;
- canonical PRJ-0002 research/decision/task evidence is updated through receipt-gated Project OS transactions;
- the roadmap is revalidated for downstream `IMP-PERSIST001` and later packages.

## 20. Approved design summary

MODEL001 adopts a schema-1.0-compatible formal lifecycle/concurrency policy:

- keep existing persistent entity shapes;
- make lifecycle mutations exact-current;
- allow only narrowly defined independent additions to rebase;
- make task behavior deterministic while preserving exact-current blocked-reason refresh;
- enforce one current active phase for new mutations;
- prevent new work from attaching to completed phases;
- avoid inventing aggregate child-completion dependencies not supported by the current model;
- require currently accepted governing decisions for new governed relationships;
- preserve immutable history and historical snapshot readability;
- defer all new persisted dependency/version structures to SCHEMA or later packages.
