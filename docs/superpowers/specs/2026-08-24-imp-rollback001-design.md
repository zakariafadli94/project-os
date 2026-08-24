# IMP-ROLLBACK001 — Automatic Safe Rollback Design

## Status

Design approved in chat; written specification awaiting final review before implementation planning. Production continuity mode remains `stable` until the package is fully proven and production-validated.

## Goal

Give Project OS a data-preserving rollback mechanism for future candidate execution paths. If a candidate path fails technically, Project OS must return to the stable path automatically without asking the user or any chat to migrate, retry differently, choose a version, or reconstruct state manually.

Rollback changes the **execution path**, never the canonical project history. Project OS must not rewind Dropbox, delete accepted work, or restore an older project snapshot as part of normal rollback.

## User-level invariants

- The user continues the same natural-language workflow before, during, and after rollback.
- Existing chats receive no migration or version-selection instructions.
- A technical candidate failure is handled internally.
- Canonically committed work is preserved.
- A transaction is never applied twice because a candidate failed after commit.
- A normal business result (`committed`, `rejected`, or `conflict`) is final for that execution and is not treated as a technical candidate failure.
- Rollback is project-isolated: a failure while executing work for one project must not mutate or roll back another project.
- Production remains on the stable path while this package is introduced and verified.

## Chosen approach

Implement a small continuity rollback executor that can run the same logical transaction through two internal execution paths:

1. **candidate path** — the future/new behavior being evaluated;
2. **stable path** — the known-good behavior retained by the continuity contract.

The executor receives the original transaction once. It always preserves the same `transaction_id` when falling back from candidate to stable.

This design deliberately does not introduce snapshot rewind. The crash-safe commit record from `IMP-COMMIT001` is the source of truth that makes post-commit rollback safe.

## Transaction flow

### Stable-only mode

When the effective continuity path is `stable`, the transaction goes directly to the stable executor. No candidate code runs.

### Candidate success

When the effective continuity path is `candidate`, Project OS calls the candidate executor first.

If the candidate returns a valid business receipt (`committed`, `rejected`, or `conflict`), that receipt is returned unchanged. The stable executor is not called.

A business rejection or conflict is therefore not a rollback trigger. Rollback exists for **technical execution failure**, not to override valid business semantics.

### Candidate technical failure before canonical commit

If the candidate throws or returns a technical failure before the transaction has a canonical committed receipt/commit record, the rollback executor calls the stable executor with the exact same transaction and exact same `transaction_id`.

The stable path then performs the operation normally once.

### Candidate technical failure after canonical commit

If the candidate fails after the immutable canonical commit record has already been published but before derived materialization/local state completes, the rollback executor still calls the stable path with the same transaction and `transaction_id`.

ProjectGuard's existing reconciliation from `IMP-COMMIT001` detects the already committed record, repairs missing materializations if needed, persists local state, and returns the original committed receipt.

The stable fallback must therefore converge to the already committed business result rather than creating a new revision or duplicate effect.

## Failure classification

The rollback executor distinguishes two categories only:

### Business result

A valid `Receipt` with status:

- `committed`
- `rejected`
- `conflict`

This is returned as-is and never causes fallback.

### Technical failure

Examples include:

- thrown exception;
- transport/runtime failure;
- unavailable candidate handler;
- malformed/non-receipt candidate response;
- injected deterministic failure in tests.

Technical failure permits fallback to stable only when the continuity decision already selected the candidate path.

The stable fallback itself is not recursively wrapped in another candidate attempt. If stable fails technically, the error surfaces through existing infrastructure and canonical recovery rules; Project OS does not loop indefinitely.

## Components

### `src/continuity/rollback.ts`

Owns the generic rollback orchestration contract. It should expose a small function such as `executeWithRollback` that accepts:

- selected continuity path;
- original transaction;
- candidate executor;
- stable executor.

Responsibilities:

- execute stable directly when selected path is stable;
- execute candidate first when selected path is candidate;
- identify a valid business receipt;
- fallback exactly once on technical candidate failure;
- preserve the original transaction object/transaction ID for fallback;
- return structured execution metadata useful for tests/observability without changing the user-facing receipt.

The module must not contain Dropbox-specific persistence logic. Commit safety remains owned by ProjectGuard/ProjectRepository.

### Worker transaction routing

`src/index.ts` remains the ingress point. The normal `/v1/transactions` contract does not change.

The routing layer will be adapted so transaction execution can be supplied as stable/candidate functions to the rollback executor. In production `stable` mode, only the stable function is selected, preserving current behavior.

No new user route, command, header, or version selector is introduced.

### Continuity policy

`src/continuity/policy.ts` remains the eligibility decision maker. `IMP-ROLLBACK001` does not weaken the existing proof gate.

The new rollback executor consumes an already resolved `effective_path`; it does not decide whether a candidate is eligible.

`rollback` mode continues to resolve to `stable`.

## Candidate path representation for this package

There is not yet a production candidate implementation to switch to. Therefore this package will introduce the rollback executor and test it with deterministic candidate executors/faults, but production remains configured with:

`PROJECT_OS_CONTINUITY_MODE=stable`

No candidate is activated merely by merging this package.

Future improvements can plug their candidate executor into the same rollback contract once their continuity proofs are complete.

## Project isolation

Rollback is scoped to one transaction and one ProjectGuard binding at a time.

The executor must never alter project IDs or redirect a failed transaction to another Durable Object. Tests will run failures for one project while confirming a second project's transactions continue independently and unchanged.

## History preservation

Rollback never deletes or rewrites:

- canonical commit records;
- domain events;
- receipts;
- historical project revisions;
- accepted decisions/deliverables.

If candidate work already committed, stable fallback recovers that exact committed revision. If candidate work did not commit, stable execution creates the single canonical revision normally.

## Idempotency requirements

The original transaction ID is the rollback correlation key.

Required outcomes:

- failure before commit + stable fallback → one committed revision;
- failure after commit + stable fallback → same original committed receipt, no extra revision;
- exact replay after rollback → same receipt;
- candidate returns rejected/conflict → no stable call;
- repeated technical candidate failure must not produce repeated stable business effects.

## Observability

The rollback executor may return internal metadata such as:

- selected path;
- final path;
- whether fallback occurred;
- failure phase/category.

This metadata is for internal tests/logging only. `/v1/transactions` continues returning the normal receipt contract.

No new persistent rollback ledger is introduced in this package because the canonical commit record and receipt already provide the durable business truth needed for recovery. A durable rollout/circuit-breaker state may be added later when a real continuously evaluated candidate deployment exists.

## Error handling

- Candidate business receipt: return it.
- Candidate technical failure: attempt stable once.
- Stable business receipt: return it.
- Stable technical failure: propagate existing error behavior; no infinite retry/fallback loop.
- Malformed candidate result: classify as technical failure and fallback stable.
- Project binding mismatch or canonical corruption: fail closed through existing ProjectGuard validation; never auto-merge conflicting realities.

## Testing strategy

Use the deterministic fault harness from `IMP-FAULTTEST001` and the commit-record foundation from `IMP-COMMIT001`.

Required tests:

1. Stable effective path never calls candidate.
2. Candidate `committed` receipt does not call stable.
3. Candidate `rejected` receipt does not call stable.
4. Candidate `conflict` receipt does not call stable.
5. Candidate technical failure before commit falls back to stable and commits exactly once.
6. Candidate technical failure after canonical commit falls back with the same `transaction_id`, ProjectGuard reconciles the existing commit, and no second revision/business effect is created.
7. Exact replay after such rollback returns the same committed receipt.
8. Stable technical failure is surfaced and is not recursively retried through candidate.
9. Project isolation: candidate failure for project A does not affect project B.
10. Current production-stable routing remains behaviorally unchanged.
11. Full existing suite remains green.
12. Wrangler deploy dry-run succeeds.

## Production validation

The package is not complete at merge time. Completion requires:

- final PR CI green;
- production deployment of the exact merge commit succeeds;
- production health check succeeds;
- continuity configuration remains `stable`;
- no user/chat workflow change;
- canonical PRJ-0002 evidence is recorded through receipt-gated Project OS transactions.

## Non-goals

This package does not:

- activate automatic candidate rollout in production;
- implement versioned traffic splitting;
- rewind Dropbox or project state;
- solve atomic generation of every Markdown file;
- add schema migrations;
- add generalized Dropbox read retry;
- redesign RegistryGuard project-creation orchestration;
- introduce a durable global circuit breaker before a real candidate rollout mechanism needs one.

Those concerns remain owned by later roadmap items or by a future continuity rollout package.

## Resulting capability

After `IMP-ROLLBACK001`, Project OS will possess the data-preserving **rollback primitive** required by the continuity contract: a future eligible candidate path can fail technically and execution can fall back to stable using the same operation identity, while committed work remains canonical and duplicate business effects are prevented.

This is the missing rollback proof layer; it is not yet the final automatic deployment/switching system by itself.