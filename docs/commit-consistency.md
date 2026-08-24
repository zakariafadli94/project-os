# Project OS Crash-Safe Commit Contract

Status: implementation spec for `IMP-COMMIT001`.

## Goal

A Project OS transaction must never leave canonical Dropbox state and ProjectGuard local SQLite as two competing realities after a crash or partial write. The user and every chat continue normal work without recovery commands or version selection.

## Canonical commit boundary

For new V2 commits, the atomic business commit boundary is one immutable canonical commit record stored under the project machine root at a deterministic revision path. The record contains the transaction, resulting project state, domain event, and committed receipt together.

A commit record is written before any derived snapshot, Markdown view, standalone receipt, or local SQLite cache is advanced. If the record does not exist, the transaction is not committed. If the record exists, the transaction is committed and any missing derived state is repairable from that record.

## Commit sequence

1. Reconcile any previously committed record that local SQLite has not absorbed yet.
2. Validate and apply the new transaction against the reconciled state.
3. Publish exactly one immutable commit record for the resulting revision.
4. Materialize the event, machine snapshot, human workspace, standalone receipt, and archive side effects idempotently from that record.
5. Persist the resulting state and receipt in local SQLite only after materialization succeeds.
6. Perform registry status side effects after local persistence; existing replay behavior repairs these if they fail.

The immutable record is the only new source of commit truth. Machine `state.json`, `manifest.json`, Markdown views, event files, standalone receipts, and local SQLite remain materialized/indexed representations and may be repaired from the record.

## Deterministic recovery

Commit records are addressed by project revision rather than by a mutable head pointer. Starting from the best known local or snapshot revision, ProjectGuard probes the next deterministic commit-record path (`revision + 1`) and absorbs records sequentially until the next path is absent.

This avoids a second crash window around a mutable head file. A brand-new or locally damaged ProjectGuard can use the existing canonical snapshot as its baseline, absorb the commit record for that same revision when present to recover its receipt, then absorb every later contiguous record.

Before a recovered record is accepted, ProjectGuard validates that project binding, previous/new revision, event revision, state revision, event ID, transaction ID, and committed receipt all agree. A malformed or non-contiguous record fails closed instead of being guessed or skipped.

## Interrupted materialization

If Dropbox fails after the immutable commit record is created but before derived files or the standalone receipt are fully materialized, the current request may fail. The next request or exact replay must detect the committed record, re-run materialization idempotently, persist local SQLite, and return the original committed receipt. The business effect is never applied twice.

The deterministic Dropbox fault-injection harness from `IMP-FAULTTEST001` proves this window by failing a derived write after the commit record has been published. Tests verify both exact replay and different subsequent work converge from the committed record without a duplicate revision or business effect.

Archived workspaces have an additional invariant: once the final archived workspace already exists and the active workspace is absent, replay must not recreate an active copy merely to regenerate the archived views. If the archive does not yet exist, the final archived-state views are materialized in the active workspace and then moved once. If both active and archived copies already exist before materialization, recovery fails closed rather than deleting or merging potentially divergent content automatically.

## Backward compatibility

Projects created before `IMP-COMMIT001` have no historical commit records. Their existing V2 `state.json` remains the baseline. The first post-upgrade transaction creates the first commit record at the next revision. Recovery does not require retroactive journal backfill.

A new project whose revision-1 commit record was published but whose first snapshot failed to materialize can recover directly from `REV-000001.json`; no pre-existing `state.json` is required for that case.

Legacy and shadow layout behavior are not migrated by this improvement. Production currently runs V2; V2 receives the new commit boundary while existing legacy/shadow semantics remain unchanged until a separately governed migration requires otherwise.

## Scope boundary

This package closes the ProjectGuard transaction crash window between canonical Dropbox publication and local SQLite persistence. It does not claim to provide full version rollback, multi-file human-view atomicity, schema migration, or generalized Dropbox read retry; those remain owned by later roadmap packages (`IMP-ROLLBACK001`, `IMP-MATERIAL001`, `IMP-SCHEMA001`, `IMP-DROPRES001`).

`project.create` still has RegistryGuard-level orchestration after ProjectGuard commits the project state. The ProjectGuard half of that creation uses the same commit record, but RegistryGuard's own registry publication lifecycle is not silently redefined here.

## Completion gate

`IMP-COMMIT001` is complete only when:

- deterministic RED/GREEN tests reproduce and close the post-record/pre-local crash window;
- exact replay after interrupted materialization returns the original receipt and does not increment revision again;
- a different subsequent transaction first reconciles the committed record and continues from the canonical revision;
- an interrupted archive replay preserves the archive without resurrecting an active workspace;
- loss of local ProjectGuard SQLite still recovers from existing snapshots plus contiguous commit records;
- pre-upgrade projects without commit records continue normally;
- a revision-1 record can recover a new project when the first snapshot was never written;
- the entire existing test suite passes;
- Wrangler deploy dry-run passes;
- production deploy and health verification pass while continuity mode remains `stable`.
