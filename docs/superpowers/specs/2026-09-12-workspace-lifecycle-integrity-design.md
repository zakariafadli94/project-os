# Project OS Workspace Lifecycle Integrity — Audit and Design

**Date:** 2026-09-12

**Scope:** active projects PRJ-0002, PRJ-0003, PRJ-0007, PRJ-0008; canonical machine state; human workspace; artifact queues; convergence runtime

**Mode:** read-only audit. No canonical Dropbox file was changed during this audit.

## Executive finding

The earlier permanent-convergence work is real and useful, but it solved a narrower problem than the one now visible to the founder. It makes canonical commits, receipts, machine state and generated projections recoverable. It does not govern the lifecycle of whole working packages, does not maintain a single authoritative view of what is current in `WORKING/`, `REVIEW/` and `DELIVERABLES/`, and cannot prevent a direct Dropbox move from bypassing ProjectGuard.

The result is a split-brain user experience:

1. canonical state can be committed and materially current;
2. visible project folders can still be stale, duplicated or manually reorganized;
3. `STATE.md` and `HANDOFF.md` do not describe those physical heads;
4. the machine can still label missing managed-document paths as `clean`;
5. an obsolete human-projection retry can loop even after a newer materialization head exists.

This is why the SOP appears not to be respected. The SOP is currently descriptive at folder level but enforceable only for individual typed transactions, managed documents and configured artifact routes.

## Sources reviewed

- Canonical registry and fresh `STATE.md` / `HANDOFF.md` for all active projects.
- Complete recursive Dropbox inventories for all active project roots.
- Managed-document heads and their provider paths.
- Materialization heads and convergence journals.
- Artifact incoming, staging, committed, receipt, rejected, failure and quarantine areas.
- The two anomaly inputs created on 2026-09-12.
- Existing Project OS operating contract, domain transitions, materialization planner, convergence engine, artifact routing and staged-artifact cleanup code.
- Existing remediation plans and rollout evidence through the global active-project convergence rollout.

## Verified portfolio snapshot

| Project | Canonical revision | Materialized revision | Visible workspace finding |
|---|---:|---:|---|
| PRJ-0002 | 169 | 169 | Small and structurally stable, but the two new anomaly inputs are not surfaced in current state. |
| PRJ-0003 | 267 | 267 | Large manual cleanup completed, but canonical navigation and 44 managed heads remain stale. |
| PRJ-0007 | 38 | 38 | Two archive roots, no current indexes, working/deliverable duplication, and a convergence retry loop. |
| PRJ-0008 | 3 | 3 | Synthetic canary remains active with two pending tasks after qualification completed. |

## Findings by severity

### Critical — PRJ-0007 human convergence is looping on a superseded revision

The provider materialization head is revision 38, but convergence still has:

- `active = revision 37`;
- `requested = revision 38`;
- one exhausted `human_handoff` obligation for revision 37;
- 289 recorded failures and 409 reserved attempts;
- a new wake scheduled roughly every five minutes;
- 636 attempt files and 4 incident files.

The current retry path resumes an exhausted human target. It does not first adopt a newer, independently verified provider materialization head. The recovery helper that can acknowledge older human obligations runs from an explicit admin materialization path, not from every alarm-driven convergence slice. Therefore an older target can remain permanently active while the visible head has already moved forward.

This is a correctness and capacity defect, not merely noisy logging. It wastes provider calls, keeps a project operationally pending and can contribute to mutation admission failures.

### Major — PRJ-0003 has 44 false-clean managed-document heads

The complete managed-head audit found 172 heads. Forty-four provider paths no longer exist: 43 under `WORKING/` and 1 under `REVIEW/`. Every missing path is still marked `reconciliation_status: clean`.

The missing paths are older A01/A02-era locations moved during manual folder cleanup. The cleanup made the visible workspace easier to navigate, but because it bypassed typed managed-document lifecycle operations the head store was not rebound or retired. A later reconciler may treat some of those removals as accidental deletion and restore obsolete visible paths.

### Major — PRJ-0003 `STATE.md` and `HANDOFF.md` point to paths that do not exist

Revision 267 still points to:

- `REVIEW/PRJ-0003-A03-COUNTER-AUDIT-R1-RETEST-04/`
- `REVIEW/A03-FOUNDER-VALIDATION-R4-20260909.md`

Both paths are absent. Current review work is instead under `PRJ-0003-A03-KNOWLEDGE-FOUNDER-GATE-R1` and its independent audit folder.

The generated state and handoff documents derive only from `ProjectState`. Physical folder changes are not canonical inputs, so manual cleanup cannot update them.

### Major — package lifecycle is not represented canonically

Project OS has stable identity for individual managed documents and artifact routes, but no canonical record saying which package is the current working, review or published head for a workstream. Consequently it cannot reliably:

- archive a superseded package as one operation;
- update all contained managed heads;
- generate a trusted current-work index;
- distinguish an intentional package archive from accidental deletion;
- prove that active zones contain only current heads.

### Major — phase completion permits unfinished child tasks

PRJ-0003 is in `PHASE-A03OFFERS`, while two active tasks remain attached to completed `PHASE-A02CERT`. The `plan.phase.complete` transition checks that the phase is current and uniquely active, but intentionally does not reject unfinished tasks in that phase. The existing test suite codifies this behavior.

This preserves data but creates an operationally misleading project state. Completion must require explicit disposition of unfinished tasks rather than silently carrying them forward.

### Moderate — archive routing is inconsistent across active projects

PRJ-0003 was manually consolidated during the audit into a root `ARCHIVES/` tree. The original distributed `WORKING/ARCHIVE` and `REVIEW/ARCHIVE` symptom is gone, but no systemic guard prevents recurrence.

PRJ-0007 still has both:

- root `ARCHIVE/` with 30 files and 9 folders;
- root `ARCHIVES/` with 1 file and 2 folders.

The artifact route schema accepts any governed root as `archive_prefix`; it does not require `ARCHIVES/`. Direct Dropbox folder creation or movement is outside ProjectGuard entirely.

### Moderate — founder navigation is manual, redundant or absent

PRJ-0003 has both `00-CURRENT/` directories and `00-CURRENT-INDEX.md` files. These are manual, noncanonical navigation aids. PRJ-0002, PRJ-0007 and PRJ-0008 have no equivalent generated index.

There is no single trusted answer to “what should I open now?” for each active zone.

### Moderate — active zones contain exact duplicate payloads

- PRJ-0003: `REVENUE-OS-IMPORT-INDEX.md` exists in both `ARTIFACTS/` and `DELIVERABLES/` with the same name and size.
- PRJ-0007: `AMM-C2-CAPACITE-v0.1.xlsx` exists in both `WORKING/` and `ARTIFACTS/DELIVERABLES/` with the same name and size.

These may be historical migration residue, but the system does not classify one copy as current and the other as retained history.

### Moderate — terminal artifact bytes remain in staging

The machine artifact staging area contains four files associated with terminal or rejected requests, including evidence mismatch and disabled-ingress canaries. Cleanup currently runs only after `canonical_verified`; rejected terminal requests are preserved indefinitely.

This does not block current ingress, but it produces storage and operator ambiguity. Terminal staging needs an evidence-checked retention/cleanup rule.

### Moderate — active-project lifecycle is not closed after operational use

PRJ-0008 is a synthetic qualification project with revision 3 and two pending tasks. Global convergence qualification is complete, yet the project remains active. It should be completed and archived through typed transactions after its evidence is retained.

### Moderate — new inputs are not visible from current state

PRJ-0002 contains the two new anomaly reports in `INPUTS/`, while its generated state reports no blocker and no intake summary. PRJ-0007 contains a large historical migration bundle and many checkpoint files in `INPUTS/`, but current state does not explain their disposition.

Inputs must not automatically become accepted business facts. Generated state should link directly to `INPUTS/`, while the read-only fleet audit reports pending count and oldest/newest timestamps without mixing provider observations into canonical business state.

### Low — production build provenance is missing

The ProjectGuard health endpoint is operational, but returns no deployment SHA or version tag. This prevents a direct proof that production contains a particular fix and complicates diagnosis of differences between repository and runtime.

## What is working correctly

- All four active canonical revisions have matching projection-version-3 materialization heads.
- PRJ-0002, PRJ-0003 and PRJ-0008 have no unresolved convergence machine-layer error.
- PRJ-0007 revision 38 is materially present despite the stale revision-37 human retry.
- PRJ-0007 managed-document heads all resolve to existing provider paths.
- Published and reference heads checked in PRJ-0003 resolve; the false-clean defect is concentrated in older working/review heads.
- The artifact incoming queue is empty.
- Existing typed transactions, receipts, mutation context, artifact routes and managed-document identity remain valid foundations and should be reused.
- The earlier global convergence plan achieved its stated scope; the new defects are predominantly missing workspace-lifecycle scope plus one stale-target convergence race.

## Root causes

1. **No canonical package head.** The model knows tasks, phases, deliverables and individual documents, but not the current package path per workstream and lifecycle stage.
2. **No folder-level typed lifecycle.** Moving a directory in Dropbox bypasses ProjectGuard, receipts, managed-head rebinding and convergence intent.
3. **Projection blind spot.** `STATE.md` and `HANDOFF.md` render `ProjectState` only; the materialization plan emits no current-zone index.
4. **Permissive phase terminal rule.** A phase can complete with unfinished tasks.
5. **Superseded human retry race.** Alarm-driven convergence can keep retrying an older human target after a newer verified materialization head exists.
6. **Terminal staging cleanup gap.** Cleanup is tied only to successful canonical verification.
7. **Weak operational visibility.** Generic `human_internal_failure` and missing deployment identity hide the exact production condition.

## Design options considered

### Option A — periodic folder cleaner

Scan all projects, infer the newest version from names and move older folders automatically.

Rejected. Filename inference is unsafe, full scans are expensive for projects with thousands of files, and automatic business interpretation would violate canonical authority.

### Option B — keep manual cleanup and add more SOP text

Document one archive root and ask every chat/operator to maintain indexes.

Rejected. This repeats the current failure mode: instructions are not enforcement, and manual indexes immediately drift from canonical state.

### Option C — one lightweight canonical workspace lifecycle record, executed by existing convergence

Add one typed operation that declares current package heads and explicit archive transitions. Store the intent in `ProjectState`; reuse ProjectGuard, committed receipts, MaterializationGuard and the existing provider-effect fencing to apply it. Generate current indexes and enrich state/handoff from this record.

Recommended. It closes the missing boundary without a new service, database, dashboard or filename-inference engine.

## Recommended design

### Canonical workspace heads

Add `workspace_heads` to `ProjectState`, keyed by stable `WORKSTREAM-*` ID. Each record contains a title and zero or one path for `working`, `review` and `published`. Paths are project-relative and constrained to their matching root.

One typed operation, `workspace.head.set`, replaces the head record for a workstream at the current base revision. Superseded visible paths are supplied explicitly as `archive_moves`; each destination must be under `ARCHIVES/<workstream-id>/...`.

No filename version guessing is allowed. The caller must state which head is current, and the committed receipt preserves that intent.

### Existing convergence applies physical changes

The materialization/convergence path turns each explicit archive move into a fenced, resumable provider effect:

1. observe the exact source identity;
2. create or verify the archive destination;
3. verify equivalent contents;
4. delete the unchanged source;
5. update or retire managed-document heads below the moved prefix;
6. write the generated current indexes and critical `STATE.md` / `HANDOFF.md` pair;
7. publish the materialization head only after final verification.

This is the same transaction-plus-convergence architecture already deployed; it adds a missing effect type rather than a parallel organizer.

### Exactly one navigation file per active zone

Generate one machine-managed `00-CURRENT.md` in each of `WORKING/`, `REVIEW/` and `DELIVERABLES/`. Remove the manual `00-CURRENT/` directory convention and `00-CURRENT-INDEX.md` duplication during one-time repair.

Each file lists only canonical workspace heads for that zone, plus revision and generated timestamp. `STATE.md` and `HANDOFF.md` gain a short “Open now” section linking to the same canonical heads and to `INPUTS/`. No full file inventory or provider-observed intake count is rendered into canonical projections.

### One archive root

All typed archive destinations must begin with `ARCHIVES/`. `artifact.route.configure` must reject any `archive_prefix` outside `ARCHIVES/`. The change-feed auditor reports `ARCHIVE`, `WORKING/ARCHIVE`, `REVIEW/ARCHIVE` and similar roots as drift; it never infers or moves them without a typed lifecycle intent.

### Phase completion invariant

`plan.phase.complete` rejects completion while any task attached to that phase is `pending`, `active` or `blocked`. The operator must explicitly complete the task or reassign it through a narrow `task.reassign` operation. History is preserved.

### Stale convergence target adoption

Before retrying a human obligation, convergence checks the provider materialization head. If a newer head is bound to a valid materialization record and its critical `STATE.md`/`HANDOFF.md` evidence is current, all older human obligations are acknowledged as superseded and the engine advances to the newest requested/canonical revision. It must not create another attempt for the obsolete revision.

An exhausted obligation without a newer verified head stops automatic hot-looping. It remains visible and can be retried by a new canonical request or explicit repair call.

### Terminal staging retention

After a durable terminal rejected receipt, unchanged staged bytes move to a machine quarantine/retention location with request ID and reason. A bounded cleanup removes them after the configured retention period. Changed or unverifiable bytes are never deleted automatically.

### No mandatory human notification

Human email/WhatsApp notification remains disabled and is not a production gate. Incidents, acknowledgements and diagnostic status remain durable and machine-readable. Pending delivery flags must not schedule work when no notification sink is configured.

## One-time repair scope

- **PRJ-0003:** declare current A03 workspace heads; archive/retire old heads without restoring obsolete A01 paths; replace manual indexes; regenerate state/handoff; verify zero clean missing heads.
- **PRJ-0007:** stop the revision-37 retry loop by adopting verified revision 38; consolidate `ARCHIVE/` into `ARCHIVES/`; classify the duplicate C2 workbook; declare current workstreams; generate indexes.
- **PRJ-0008:** retain qualification evidence, complete or explicitly dispose of the two canary tasks, then complete/archive the project through typed transactions.
- **PRJ-0002:** keep the two anomaly inputs as evidence, create the accepted remediation phase/tasks through typed transactions when execution begins, and expose unresolved intake in generated state.

## Acceptance invariants

1. Every active project has exactly one `ARCHIVES/` root and no active-zone archive folder.
2. Every head marked clean resolves to its provider path.
3. Every path linked from generated `STATE.md`, `HANDOFF.md` and `00-CURRENT.md` exists.
4. Each active zone has exactly one generated `00-CURRENT.md` and no parallel manual current index convention.
5. Completing a phase with unfinished attached tasks is rejected.
6. A newer verified materialization head retires older human retry obligations without another provider write attempt.
7. An exhausted obligation cannot generate unbounded attempts.
8. Terminal staged bytes are either cleaned or retained in explicit quarantine; no unexplained terminal object remains in staging.
9. Production health identifies the deployed code revision.
10. The fleet audit passes for all active projects, not only a synthetic canary.

## Explicit non-goals

- No new dashboard, service, database, worktree or automation.
- No semantic inference of “latest” from filenames.
- No mass renaming of historical archive content.
- No recursive content-quality audit of every archived document.
- No requirement for paid human notification features.
- No direct canonical Dropbox mutation.
- No project-specific hard-coded behavior for PRJ-0003 or PRJ-0007.
