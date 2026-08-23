# Project OS Continuous Evolution Contract

## Purpose

Project OS must be able to evolve without turning its user or its chats into operators of the migration. This contract is the permanent safety boundary for every improvement after `IMP-CONTINUITY001`.

## User-level invariants

Every improvement must preserve all of the following:

1. The user keeps the same natural-language workflow. No migration commands, version selection, sync commands, or special chat instructions are introduced.
2. Active work continues while an improvement is prepared, verified, enabled, disabled, or rolled back.
3. A candidate path never becomes effective before its continuity evidence is complete.
4. Switching between stable and candidate behavior is an internal Project OS responsibility.
5. A change cannot use one project as an unsafe migration vehicle for another project; project isolation must be proven.
6. A rollback path must exist and be proven without accepted data loss before a candidate can be selected.
7. Old and new chats must resolve the same canonical project state; conversation history is never a second source of truth.
8. A prototype, recommendation, passing unit test, or build artifact is not a durable production change. Production proof is required.
9. Historical decisions, events, receipts, deliverables, and prior versions remain traceable.
10. Safety and continuity take precedence over rollout speed.
11. Continuity protections are implemented before dependent optimizations or functional expansion.
12. Progress reports are informational. Technical work continues automatically unless a genuine user-owned business decision is required.

## Machine-enforced gate

`src/continuity/policy.ts` defines a fail-closed gate. A candidate can be selected in `automatic` mode only when it is available and every required proof is true:

- user workflow unchanged;
- zero downtime proven;
- project isolation proven;
- canonical compatibility proven;
- old/new chat compatibility proven;
- stable path retained;
- rollback proven;
- history preserved;
- production proof complete.

If any proof is missing, `effective_path` remains `stable` and the result contains explicit blocker codes.

`rollback` mode always resolves to the stable path. `stable` mode always remains on the stable path. An unknown or missing configured mode fails closed to `stable`.

## Stable-first deployment

The initial production configuration is explicitly `PROJECT_OS_CONTINUITY_MODE=stable`. `IMP-CONTINUITY001` therefore adds the control plane without switching existing transaction, artifact, inbox, project, or chat behavior.

Candidate evaluation is deliberately an internal library contract. The only Worker endpoint added by this improvement is an authenticated read-only status endpoint (`GET /v1/admin/continuity`). Normal user and project routes do not change.

## Relationship to later roadmap items

This gate controls **eligibility to switch**. It does not pretend that cross-store crash consistency, destructive recovery, or data-preserving rollback already exist. Those proofs are supplied by later roadmap items (`IMP-FAULTTEST001`, `IMP-RECOVERY001`, `IMP-COMMIT001`, `IMP-ROLLBACK001`). Until those proofs exist for a candidate, the gate keeps Project OS on the stable path automatically.

This separation is intentional: Project OS gains a continuity guard before any risky migration mechanism is allowed to use it.

## Failure policy

- Missing proof: stay stable.
- Unknown continuity mode: stay stable.
- Candidate unavailable: stay stable.
- Rollback mode: use stable.
- Business-direction conflict: preserve both realities and require user arbitration; never auto-merge it.
- Technical report/checkpoint: continue automatically; do not create a user approval gate.

## Completion evidence for IMP-CONTINUITY001

The improvement is ready for production validation only when:

- the new continuity tests pass together with the entire pre-existing suite;
- Wrangler dry-run succeeds;
- production remains explicitly in stable mode;
- existing user-facing mutation and inbox behavior is unchanged;
- the authenticated continuity status reports the stable path after deployment;
- no canonical Project OS state is changed merely by installing the control plane.
