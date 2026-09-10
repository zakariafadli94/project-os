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

Admission context is transported unchanged through candidate and stable execution. An admission failure is authoritative and never triggers fallback. A rollback runtime is eligible only if it can read the convergence journal, preserve bounded continuation and enforce an already-established strict-admission floor; rollback never deletes durable repair evidence or lowers a canonical revision.

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

This document is the source-controlled continuity contract for the implementation. The durable Project OS decision record is written only after production validation through the canonical transaction path.

## 2026-09-09 convergence rollout boundary

Local convergence and admission tests are complete, and the production continuity decision remains `stable`. The implementation SHA `00250b623ee88bdcbed71252223b4adaee179c17` passed the 193-file / 935-test suite, the 26-file / 148-test persistence high-risk gate, static contracts, and a direct Wrangler dry-run that exited before upload. Regression SHA `3bbf7d2102dffeca834368cc8c5336840a2f8fda` then passed 193 files / 936 tests, including a six-attempt synthetic HANDOFF exhaustion, immutable alert, and scheduled recovery without a new canonical commit. The independent production proofs still missing are migration of the external promotion/fallback paths, a monitoring acknowledgement and recovery exercise, and the isolated 24-hour canary. These conditions preserve the stable reader/writer path; they do not authorise a merge, deployment, activation downgrade, or PRJ-0003 repair.

The final local rectification gate at `b7bca495c4805256db49b8db937d4b4ffc133176` passed the complete 201-file / 971-test suite, static contracts, the 26-file / 148-test persistence gate, and a bundle-only Wrangler dry-run. It does not alter the continuity decision: owner-compatible promotion/fallback integration, monitoring ACK/recovery, and an isolated 24-hour canary are still absent. No activation, deployment, canonical Dropbox mutation, or PRJ-0003 repair occurred.

The last local hardening SHA `d63578252e7d64329540ce001ad0dc908d906454` bounds a monitoring acknowledgement body that stalls after the HTTP response. The new regression was red before correction, then the full 201-file / 972-test suite, static gates, persistence gate, and direct bundle-only dry-run passed. Continuity remains `stable`: this local timeout proof is not an external monitoring ACK, canary, activation, deployment, or permission to repair PRJ-0003.

## 2026-09-10 isolated canary state

Continuity remains `stable` for every real project. The only enabled convergence writer is synthetic PRJ-0008 on Worker version `7e624e43-d288-4cf5-97bd-cbc43c11aa33`; its ordinary current-state materialization is verified at revision 2 / projection version 3. The live historical admission reader can now read PRJ-0003 revision 267, but PRJ-0003 remains in the stable path with no writer activation, canonical mutation, or repair.

The new Worker deployment began the 24-hour isolated qualification window at `2026-09-10T17:26:03Z`. The deferred human-alert policy changes only the human-delivery ACK requirement. Reader compatibility, fencing, recovery, capacity, transport, rollback compatibility, and the full canary window remain mandatory before any extension.

## Governed Control Tower continuity boundary

The OAuth-protected Control Tower is an optional ingress channel, not a replacement persistence plane. Its deployment and route-only rollback leave `project-os-guard`, the canonical Dropbox inbox, and stable project traffic unchanged. Initial production qualification is restricted to unauthenticated denial, authenticated tool discovery, and read-only synthetic PRJ-0008 context; mutation, replay, visibility, and rollback evidence are recorded separately before normal projects are released. PRJ-0003 stays read-only until its independent convergence gate passes.
