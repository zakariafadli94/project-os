# Project OS Crash-Safe Commit Contract

Status: operational commit contract after `IMP-COMMIT001` + `IMP-MATERIAL001`.

## Goal

A Project OS transaction must never leave two competing business realities after a crash or partial write. The user and every chat continue normal work without recovery commands or version selection.

## Canonical commit boundary

For V2 commits, the atomic business commit boundary is one immutable canonical commit record stored under the project machine root at a deterministic revision path. The record contains the transaction, resulting project state, domain event and committed receipt together.

A commit record is written before derived snapshots, Markdown views, standalone receipt copies, materialization evidence, or local caches can become authoritative. If the record does not exist, the transaction is not committed. If it exists and validates, the transaction is committed and derived state is repairable from it.

The immutable commit record remains the single business source of truth introduced by `IMP-COMMIT001`.

## Commit sequence after `IMP-MATERIAL001`

The V2 critical path is now:

1. reconcile any canonical commit record that local ProjectGuard state has not absorbed;
2. validate and apply the new transaction against reconciled canonical state;
3. publish exactly one immutable canonical commit record for the resulting revision;
4. persist the resulting state/receipt in ProjectGuard SQLite so immediate replay is idempotent;
5. request asynchronous materialization for the new canonical revision;
6. return the committed business result;
7. separately materialize machine derivatives and human workspace, verify a complete projection generation, publish immutable materialization evidence, then advance materialization head.

Registry/status side effects retain their existing ownership. For `project.create`, RegistryGuard still publishes the standalone committed receipt only after its registry finalization succeeds.

## Expected projection lag

After `IMP-MATERIAL001`, these values are allowed to differ temporarily:

```text
canonical commit revision = 72
machine snapshot revision = 71
materialization head = 71
human STATE/HANDOFF = completed generation 71
```

This is expected asynchronous lag, not a failed business commit and not a rollback condition.

The canonical commit record is authoritative. Machine `state.json`, `manifest.json`, standalone receipts, events and Markdown views are derived/reconstructible materializations. The latest human generation proven coherent is identified by `materialization-head.json` plus its immutable completed-generation record.

The projection engine must converge toward the canonical revision automatically through ProjectGuard alarms and scheduled reconciliation.

## Deterministic canonical recovery

Commit records are addressed by project revision rather than a mutable business head pointer. Starting from the best known local/snapshot revision, ProjectGuard probes the next deterministic commit-record path (`revision + 1`) and absorbs records sequentially until the next path is absent.

A brand-new or locally damaged ProjectGuard can use an existing canonical snapshot as a baseline, absorb the commit record for that same revision when present to recover its receipt, then absorb every later contiguous record. If the snapshot itself is absent, a valid revision-1 commit record can bootstrap recovery.

Before a recovered record is accepted, ProjectGuard validates project binding, previous/new revision, event revision, state revision, event ID, transaction ID and committed receipt. A malformed or non-contiguous record fails closed instead of being guessed or skipped.

Recovered commits are persisted locally and projection work is requested. Recovery does not require human Markdown to be current before the canonical state is usable.

## Materialization recovery

Projection recovery is separate from canonical business recovery.

`IMP-MATERIAL001` adds:

- immutable completed-generation records;
- a repairable materialization head;
- a reconstructible SQLite progress ledger;
- deterministic semantic/content hashes;
- per-output resume;
- revision coalescing for current-state human views.

If a projection crashes mid-generation, the business revision does not change. Verified per-output work is reused when possible.

If all outputs were verified and the immutable completed-generation record was written but advancing `materialization-head.json` failed, reconciliation validates the completed record and repairs the head without rewriting the workspace.

See `docs/materialization.md` for the full projection contract.

## Exact replay

Exact transaction replay is keyed by the original `transaction_id`.

If the canonical commit exists, replay converges to the original business receipt and never creates another revision merely because materialization is incomplete or failed.

A projection retry is not a new transaction and never applies the domain operation again.

## Archived workspaces

Archive business state commits before workspace movement.

The projection engine owns human workspace archive completion:

- render/verify the archived target;
- move the active workspace when necessary;
- verify critical `STATE.md`/`HANDOFF.md` at archive destination;
- publish completed generation with `workspace_location: archive`;
- advance materialization head only after those checks.

If archive already exists and active workspace is absent, replay is idempotent. If both represent conflicting realities, projection fails closed rather than deleting/merging content automatically.

## Backward compatibility

Projects created before `IMP-COMMIT001` have no historical commit records. Their existing V2 `state.json` can remain a recovery baseline; the first later transaction creates a commit record at the next revision.

Historical V2 snapshots that predate materialization generation records remain supported. The authenticated administrative materialize route can regenerate the workspace without creating a business revision.

Legacy/shadow layout semantics are not silently redefined by `IMP-MATERIAL001`. Production remains V2.

## Scope boundary

This contract covers:

- canonical transaction commit truth;
- deterministic canonical recovery;
- separation of business commits from derived projection work;
- idempotent replay across partial projection failures.

It does not define schema migrations, alternate persistence providers, final performance SLOs, multi-tenant isolation or automatic software rollout. Those belong to later roadmap packages.

## Completion invariants

The combined commit/materialization system must maintain all of these:

- one logical transaction produces at most one canonical business revision;
- commit record existence/validation determines business truth;
- projection failure never rewinds a committed revision;
- canonical revision may be ahead of materialization head and converges automatically;
- exact replay returns the original receipt;
- loss of hot ProjectGuard/materialization SQLite can recover from durable external evidence;
- `STATE.md` and `HANDOFF.md` only advance as a completed pair for one target revision/projection version;
- unexpected destination edits fail closed;
- production continuity remains `stable` until the separate automatic rollout package is implemented and proven.
