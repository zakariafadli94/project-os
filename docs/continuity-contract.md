# Project OS Continuous Evolution Contract

Status: implementation baseline for `IMP-CONTINUITY001`.

## Purpose

Project OS must be able to evolve while normal project work continues. Internal versioning, migration, validation, rollback, and recovery must not become user procedures.

## Non-negotiable continuity rules

1. **No user workflow change.** Users and chats continue to work through normal natural-language interaction. No migration command, sync command, version selection, or special chat procedure may be required.
2. **Zero planned work stoppage.** Improvements must be prepared and validated without requiring active projects or conversations to stop.
3. **Stable path retained until proof.** A candidate implementation cannot replace the stable path until continuity evidence is complete.
4. **Automatic backend selection.** Technical path selection is a Project OS responsibility. The user is never asked to select stable vs candidate behavior.
5. **Project isolation.** An improvement must not require cross-project mutation and must prove that unrelated projects remain unaffected.
6. **Rollback readiness.** A candidate cannot be eligible unless a safe rollback/neutralization path is proven and current work/history remain recoverable.
7. **Old/new chat compatibility.** Chats started before and after a change must resolve the same canonical project reality.
8. **Proof before durable activation.** Prototype, recommendation, CI success, or partial validation alone cannot authorize candidate activation.
9. **History preservation.** Improvements may transform representation but must not erase accepted decisions, events, prior versions, or valid deliverables.
10. **Safety over speed.** If a faster rollout conflicts with continuity/integrity, the safer path wins.
11. **Continuity work precedes optimizations.** Recovery, crash consistency, rollback, and proof infrastructure are prerequisites for broader optimization.
12. **Reports do not block execution.** Technical progress reports are informational. Work continues unless a real business-direction decision requires user authority.

## Runtime continuity modes

The continuity contract defines three modes:

- `stable`: always use the existing stable path.
- `automatic`: a candidate path is eligible only when every required continuity proof is true; otherwise Project OS fails closed to stable.
- `rollback`: force the stable path even if a candidate would otherwise be eligible.

An invalid or missing mode is treated as `stable`.

Production is introduced with `PROJECT_OS_CONTINUITY_MODE=stable`. Moving production to `automatic` is not part of this foundation rollout and is forbidden until a concrete candidate improvement supplies the complete proof set through its own production-validation sequence.

## Required proof set

A candidate is not eligible until all of these are proven:

- user workflow unchanged;
- zero downtime;
- project isolation;
- canonical-state compatibility;
- old/new chat compatibility;
- stable path retained;
- rollback proven;
- history preserved;
- production proof complete.

A missing proof creates an explicit blocker and keeps the effective path on `stable`.

## Control-plane surfaces

`GET /v1/admin/continuity` is authenticated and read-only. It reports the configured continuity mode and the effective fail-closed path.

`POST /v1/admin/continuity/evaluate` is authenticated and non-mutating. It evaluates a proposed proof set and reports the path the policy would select. It does not activate a candidate, change configuration, migrate data, or switch production traffic.

## Current implementation boundary

`IMP-CONTINUITY001` establishes the fail-closed policy and continuity control-plane contract. It intentionally does not pretend that generic rollback of partially completed business writes is safe: crash-consistent commit/recovery and storage rollback are implemented by the dependent roadmap packages (`IMP-RECOVERY001`, `IMP-COMMIT001`, `IMP-ROLLBACK001`).

Future candidate features must use this continuity policy as their activation gate and obtain real proof evidence internally before using candidate behavior. They must not add a second user-facing workflow.

## Completion criteria for this foundation

- the default deployed behavior remains stable;
- continuity status is authenticated and read-only;
- continuity evaluation is authenticated and non-mutating;
- automatic candidate eligibility requires the complete proof set;
- rollback mode always resolves to stable;
- missing/invalid configuration fails closed;
- existing Project OS routes and project workflows remain unchanged;
- the full regression suite and Wrangler dry-run pass before merge;
- production health is verified after deployment;
- PRJ-0002 canonical state is updated only after production validation, through typed Project OS transactions and committed receipts.
