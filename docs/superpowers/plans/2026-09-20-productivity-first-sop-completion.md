# Project OS — Productivity-First Recovery and SOP Completion Plan

> **For agentic workers:** execute in this conversation and existing worktree only. Use test-first changes and verify each gate before proceeding. No new chat, worktree, automation, service or production test project.

**Goal:** Restore everyday project throughput first, then finish the still-open SOP enforcement programme without calling a partial fix completion.

**Architecture:** Keep Dropbox canonical and all durable changes behind typed ProjectGuard transactions, committed receipts and physical finalization. Reuse the deployed ProjectGuard, RegistryGuard, MaterializationGuard and Control Tower boundaries. This plan sequences proven residual defects before the outstanding tasks of the accepted SOP plan at `docs/superpowers/plans/2026-09-12-sop-enforcement-runtime.md`.

**Current baseline:** PR #235 was merged at `471b19facb4fac7b4002f86e08de15818dbaa2f5`. PRJ-0007 module 10 was finalized at revision 83. The previous integration suite passed 1,447 tests, but that does not prove the residual defects below are fixed. Refresh production state before any later production mutation.

## Global constraints

- Never directly edit machine-managed Dropbox files or infer persistence without a `committed` receipt.
- Keep business repairs separate from technical recovery; never duplicate an accepted transaction.
- Do not broaden REVIEW_CANDIDATE enablement as a side effect of supporting managed `review.write`.
- Independent projects must remain usable while one project has convergence debt.
- Record actual evidence and residual gaps; no arbitrary percentage-complete claim.

## Phase 1 — Remove current productivity blockers

### Task 1: Admit the supported managed `review.write` operation

**Files:** `src/rules/check-catalogue.ts`, `test/admission-operation-context.spec.ts`, targeted managed-document admission tests.

1. Reproduce a parsed `review.write` request reaching `normalizeDocumentAdmission` and then `evaluateRules`; observe `INVALID_OPERATION_CONTEXT` before changes.
2. Add `review.write` to the server-owned operation catalogue and the physical-operation set only where its actual checks apply. Do not change the unrelated artifact `REVIEW_CANDIDATE` toggle.
3. Verify a valid request reaches normal admission, while stale version, invalid authority and wrong payload remain rejected.
4. Run targeted tests and the full suite. Commit this defect independently.

**Gate:** managed REVIEW deposit is accepted through the normal governed path and produces a traceable receipt/finalization; no alternative entry bypasses checks.

### Task 2: Make receipt and context reads responsive under load

**Files:** the measured failing boundary in Control Tower, ProjectGuard or Dropbox client; targeted transport/read tests.

1. Measure a small set of authenticated context and receipt reads at each boundary, recording duration and correlation ID without secrets.
2. Reproduce the slow or unavailable boundary in a failing test. Distinguish platform connector delay from application delay.
3. Correct only the demonstrated bottleneck; retain bounded `PROJECT_OS_READ_UNAVAILABLE` for genuine failure and avoid any write/retry side effect on a read.
4. Verify repeated reads during active materialization and when a downstream dependency stalls.

**Gate:** a busy project gives a timely answer or an actionable bounded error; receipt discovery never becomes an ambiguous silent wait.

**Measured 2026-09-20:** production reads of PRJ-0003 and PRJ-0007 each exceeded the 10-second Control Tower deadline during document reconciliation. The ProjectGuard diagnostic wrapper serialized even read-only context calls behind that work. The targeted fix lets canonical context reads bypass that outer queue; receipt and execution reads instead return explicit `PROJECT_OS_READ_BUSY` while a serialized write is active, preventing a misleading `not_received` or 404. This improves bounded feedback but does not promise receipt availability during a long reconciliation. Verify the deployed behaviour under real load before closing this gate.

### Task 3: Remove the intermittent deployment-test false positive

**Files:** `test/rollback-project-guard.spec.ts` and its test helper only, unless investigation proves a production defect.

1. Reproduce the case where `runDurableObjectAlarm(stub) === false` precedes the expected materialized head/state.
2. Make the helper check the actual head and state evidence before declaring projection complete; wait through bounded scheduled progress without masking a terminal error.
3. Run the test repeatedly, then the full suite, typecheck and Cloudflare dry-run build.

**Gate:** the test reflects physical completion and is stable; an actual projection failure still fails it.

### Task 4: Correct misleading module-10 document status

**Files:** no direct canonical file edits. Use the managed-document operation and exact approved bodies as source.

1. Read the five current published versions and identify the exact stale `Version de revue 0.1` / `À VALIDER` statements.
2. Confirm which editorial replacements preserve the founder-approved substance. If a wording choice changes meaning, seek a business decision rather than inventing one.
3. Submit governed document revisions, verify `committed` receipts, publication/finalization and current navigation.

**Gate:** all five documents communicate their real approved status, with history preserved.

**Observed 2026-09-20:** all five files were found in PRJ-0007 `DELIVERABLES/.../10-RISQUES-TESTS-ET-PORTES-DE-DECISION/`; each says `Version validée 1.0` and cites `DEC-REFM10VALID001` at revision 83. No editorial repair is indicated by these current files. This read-only finding does not substitute for verifying the publication receipts if that gate is later audited.

### Task 4a: Close the governed archive-relocation gap before promising cleanup

The PRJ-0003 anomaly filed in PRJ-0002 `INPUTS/PRJ-0003-20260920-GOVERNED-ARCHIVE-RELOCATION-GAP.md` shows that existing `working.supersede` cannot move an unchanged current document to `ARCHIVES`, and no generic typed move is available for REVIEW or published DELIVERABLES. This is a reported anomaly to investigate, not permission to invent a business archival decision.

1. Inventory the exact current document identities, versions, zones and desired destinations; distinguish outdated versions from documents still approved or under review.
2. Confirm the governing archival rule and the founder-approved disposition for any ambiguous current item. Keep those items in place until that decision exists.
3. Add one minimal typed, authority-checked relocation operation only for demonstrated missing cases. Preserve immutable history, document identity, receipts and idempotency; forbid arbitrary path writes and cross-project moves.
4. Prove one current WORKING, REVIEW and published item can be relocated only when eligible, with an exact receipt and physical finalization. Prove duplicate and stale-version requests do not duplicate or delete content.
5. Reconcile the 17 PRJ-0003 candidates through separately traceable governed operations after refreshing canonical state. Never directly move Dropbox files.

**Gate:** governed archival is possible without a bypass, and each actual relocation has a committed receipt and verified destination; unresolved business choices remain explicit.

## Phase 2 — Finish the open SOP programme

### Task 5: Reconcile the accepted coverage matrix with deployed code

Refresh the existing SOP matrix against production and mark each G01–G14 guarantee and each supported entry as **proven**, **partially equipped**, **not equipped**, or **external dependency**. Inventory accepted global/project rules separately from prose-only SOPs. Confirm the Control Tower/connector capability actually visible to independent chats; repository code alone is not proof of platform availability.

**Gate:** every mandatory rule has a source, operation scope, deployed check and executable evidence or an explicit unresolved gap.

### Task 6: Close technical enforcement gaps, smallest first

Complete only matrix-backed deficiencies in the accepted SOP plan Tasks 1–6: rule lifecycle/authority, cumulative global+local evaluation, common admission on every entry including admin/inbox/fallback, exact-version approvals and exceptions, post-execution evidence/finalization, document/package/phase controls (including Task 4a), and external Dropbox drift detection. Each gap gets one red test, minimal implementation, targeted green test and a separate reviewable commit. Do not activate an unequipped rule.

**Gate:** no declared active rule can be bypassed through a supported entry, and unsupported obligations remain visibly `accepted_unenforced`.

### Task 7: Production activation and historical repairs

Follow accepted SOP plan Tasks 7–10: independent code/coverage review, complete suite/typecheck/dry-run, merge and deploy exact verified `main` SHA, then qualified typed activation and separately receipted repairs for PRJ-0002, PRJ-0003, PRJ-0007 and PRJ-0008. Verify physical effects and independent-project throughput. Never treat an old report as current without refreshing the canonical state.

**Gate:** G01–G14 demonstrated with named evidence, active rules enforced, project repairs finalized, code identity verified in production, and unresolved business choices or platform limits stated plainly.

## Completion rule

Phase 1 completion means daily work is unblocked; it does **not** mean Project OS SOP enforcement is complete. The whole programme is complete only when Phase 2 gates and the accepted SOP plan's final definition of done are met. Human alerts remain optional and non-blocking.
