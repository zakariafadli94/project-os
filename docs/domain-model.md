# Project OS Domain Lifecycle and Concurrency Model

## Authority

Canonical commit records are immutable business history. `ProjectState` is the current aggregate reconstructed from that history. Generated Markdown, materialization snapshots, heads and indexes are derived representations and must remain reconstructible.

A committed record preserves two revision facts when a stale additive transaction is safely rebased:

- `transaction.base_revision` is the revision the submitter actually used;
- `previous_revision` is the effective canonical revision immediately before the committed effect.

For exact-current operations those values are equal. For the explicitly stale-rebasable operations, `transaction.base_revision` may be lower than `previous_revision`; it may never be ahead of it. The original submitted base is retained as audit provenance rather than rewritten during commit.

## Concurrency

ProjectGuard serializes same-project mutation execution. No second distributed locking layer is part of MODEL001.

A stale transaction may rebase only for these four operations:

```text
research.add
constraint.add
task.create
deliverable.add
```

`deliverable.add` is deprecated compatibility behavior. All four operations are revalidated against current canonical state before commit. A semantic violation after rebase is a business rejection, not a conflict.

Every other operation requires the current project revision. If its submitted `base_revision` is behind current state, the result is `conflict` with `STALE_REVISION` and no business revision/event is created. A base revision ahead of canonical state also conflicts.

This distinction is intentional:

- **conflict** means the submitted concurrency base is unsafe for that operation;
- **rejected** means the operation was evaluated against the applicable state but violates a domain invariant;
- **committed** means exactly one new canonical business revision was created.

Never semantically auto-merge competing lifecycle or direction-changing mutations.

## Project lifecycle

Supported transitions remain:

```text
active -> paused -> active
active|paused -> completed
active|paused|completed -> archived
```

`archived` is terminal. A completed project supports archival only. Project completion does not infer or fabricate task, phase or deliverable completion.

MODEL001 does not reinterpret `paused` as a global freeze of all child mutations; that would be a separate business-policy decision.

## Task lifecycle

Supported transitions are:

```text
pending -> active|blocked|completed
active  -> blocked|completed
blocked -> active|blocked|completed
completed -> terminal
```

`blocked -> blocked` is an exact-current blocker-reason refresh. Starting a blocked task clears its blocker. Completing a task clears its blocker. Direct `pending -> completed` remains supported so natural user statements such as “this task is done” do not require a synthetic start event.

Task lifecycle mutations are exact-current operations. `task.create` alone remains stale-rebasable when its stable ID is unique and all current-state references remain valid.

## Phase lifecycle

The first created phase is `active` and becomes `current_phase_id`. Later phases are `pending`.

Only the single active phase referenced by `current_phase_id` may complete. Completing a pending/non-current phase is rejected. If historical state contains another active phase, completion fails closed rather than choosing one implicitly.

After the current phase completes, the lexicographically lowest pending `phase_id` is promoted to `active`. When no pending phase remains, `current_phase_id` becomes `null`.

New tasks and normative `deliverable.create` records cannot attach to a completed phase. Phase completion does not infer or fabricate child task/deliverable completion.

Explicit persisted phase ordering, dependency graphs and richer scheduling semantics are deferred because they require a separately approved schema/model change.

## Decisions

A decision is accepted, then may later be explicitly superseded by another currently accepted decision. Supersession never deletes or rewrites the historical decision.

New governed deliverables may reference only decisions that are currently `accepted`. Existing historical deliverable relationships are not rewritten when a governing decision is later superseded.

## Research and constraints

Research is append-only canonical evidence. MODEL001 does not add a mutable research status. Current synthesis/classification belongs in Discovery.

Constraints are append-only in the current schema. `research.add` and `constraint.add` remain stale-rebasable because they add stable-ID evidence without changing existing lifecycle direction, subject to current-state validation and ID uniqueness.

## Deliverables

The normative lifecycle remains:

```text
planned -> in_progress -> review -> accepted -> superseded
                     ^        |
                     | revise |
                     +--------+
```

Revision from `in_progress` or `review` returns the item to `in_progress` with a changed version. Abandonment remains explicit from supported non-terminal states. `legacy_completed` remains a compatibility state and does not imply modern acceptance.

Modern deliverable lifecycle/direction operations require the current project revision. Deprecated `deliverable.add` remains stale-rebasable for compatibility; deprecated `deliverable.complete` is exact-current.

## Immutable history and current state

The immutable canonical commit record is the authoritative historical fact for each committed revision. It binds:

- the originally submitted typed transaction;
- the effective `previous_revision` and contiguous `new_revision`;
- the resulting current state;
- the domain event;
- the committed receipt.

`ProjectState` is the current aggregate, not a replacement for immutable history. Decision supersession and deliverable supersession retain historical entities. Generated state/Markdown and materialization evidence can be rebuilt from canonical sources according to their existing contracts.

## Historical compatibility

MODEL001 does not bump `ProjectState` or transaction schema version, add persisted fields, or perform bulk migration.

A structurally valid schema-1.0 historical snapshot remains readable even if its stored lifecycle combination could no longer be newly produced under MODEL001. Read/normalize paths must not silently repair, reject or rewrite such state merely to satisfy the new write-time invariants.

New mutations are evaluated under MODEL001 rules against the current state. Historical compatibility does not grant permission to recreate an invalid combination.

## Deferred schema-dependent capabilities

The following remain outside MODEL001 and require `IMP-SCHEMA001` or another separately approved package:

- persisted task/phase dependency graphs;
- per-entity revisions or optimistic-lock versions;
- explicit persisted phase-order fields;
- mutable research statuses;
- generalized durable relations or dependency metadata;
- migrations or a ProjectState schema bump.

MODEL001 also does not change MutationGate rollout state, repair PRJ-0003, or resume SCHEMA runtime implementation. MutationGate remains governed by its independent observe/enforce rollout gate.
