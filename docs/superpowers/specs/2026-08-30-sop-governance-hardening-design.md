# Project OS — SOP Governance Hardening Design

Status: design approved in conversation; implementation not yet authorized
Date: 2026-08-30
Project: PRJ-0002 — Project OS
Scope: project-creation authorization, synthetic-project typing, cross-project referrals, crash-safe INPUT intake, intake observability

## 1. Problem statement

Project OS currently expresses several governance rules in its SOPs and operating contract without enforcing them strongly enough at runtime. Two field incidents exposed the gap:

1. A cross-project referral from PRJ-0003 to PRJ-0002 was correctly delivered to `INPUTS/` but remained there for hours instead of being ingested into `REFERENCES/UNCLASSIFIED/`.
2. `PRJ-0006 — IMP-SCHEMA001 Production Probe` was created as a real canonical project through `project.create` without explicit user authorization. The transaction was technically valid and committed, but the runtime had no independent proof of human approval.

The incidents are related at the governance layer: Project OS can validate persistence mechanics while still failing to prove that the higher-level SOP transition was authorized or completed.

This design makes those transitions explicit, auditable, fail-closed, and recoverable.

## 2. Goals

The change MUST:

- require an independent, one-shot authorization before any new canonical project is allocated;
- distinguish real projects from synthetic probes and stress tests;
- make synthetic status explicit in human-readable project views;
- standardize cross-project referrals without turning them into target-project truth;
- remove fake lifecycle fields from referral Markdown;
- make INPUT ingestion crash-safe and idempotent;
- provide a direct periodic INPUT sweep independent of Dropbox change cursors;
- surface stale or failed INPUT intake instead of allowing silent backlog;
- preserve all historical projects, referrals, receipts, IDs, and evidence;
- keep archived projects out of intake processing;
- keep PRJ-0003 isolated from PRJ-0002 governance work unless explicitly targeted by a referral.

## 3. Non-goals

This package does NOT:

- delete or rewrite PRJ-0004, PRJ-0005, or PRJ-0006 history;
- retroactively invent missing human authorization for historical projects;
- bulk-rewrite legacy referrals;
- make referrals automatically create tasks, decisions, research, constraints, or deliverables;
- replace Managed Documents;
- implement IMP-DOCIDENTITY001;
- merge or deploy PR #93;
- introduce destructive project deletion.

## 4. Accepted architecture

The approved design consists of four parts:

1. two-act project creation authorization;
2. typed cross-project referrals;
3. crash-safe INPUT intake plus watchdog;
4. enforcement-first rollout and incident repair.

## 5. Project creation authorization

### 5.1 Principle

A valid `project.create` JSON is not proof of human authorization.

Project allocation MUST therefore require a separate authorization object created through a distinct operator capability that generic transaction writers cannot manufacture.

The required flow is:

`user approval -> project-create authorization -> authorization receipt -> project.create -> RegistryGuard allocation`

The authorization record/receipt is operational governance evidence. Issuing it MUST NOT advance a project business revision because the project does not yet exist.

### 5.2 Authorization object

Introduce a durable authorization record with at least:

- `schema_version`;
- `authorization_id`;
- `name`;
- `slug`;
- `aliases`;
- `objective`;
- `project_kind`;
- optional `parent_project_id` or `improvement_package_id` for synthetic projects;
- `issued_at`;
- `expires_at`;
- `consumed_at` when used;
- `allocated_project_id` after allocation when applicable.

The record MUST be immutable after issue except for one-way consumption/allocation metadata.

### 5.3 Authorization issuance

Authorization issuance MUST NOT use the generic transaction inbox.

It MUST require a dedicated authenticated operator surface or equivalent capability that represents an explicit interactive approval event.

Generic transaction/referral/artifact/document writers MUST NOT possess this issuance capability.

If the runtime cannot obtain such an independent capability, automated project creation MUST fail closed rather than simulate consent.

### 5.4 Compatibility shape for `project.create`

Historical `project.create` transactions MUST remain readable exactly as historical evidence.

The existing transaction family may therefore accept the following fields as optional for legacy parsing:

- `authorization_id`;
- `project_kind`;
- optional synthetic parent/package binding.

For every NEW project creation after enforcement cutover, RegistryGuard MUST require these fields. Missing fields are allowed only when reading/replaying an already-terminal historical transaction created before the enforcement frontier.

This avoids inventing `project_kind` for old projects while making it mandatory for new allocations.

### 5.5 Authorization matching

RegistryGuard MUST reject a new `project.create` unless a live, unconsumed authorization exists and matches the request exactly for all binding fields:

- name;
- slug;
- aliases after canonical normalization;
- objective;
- project_kind;
- synthetic parent/package binding when required.

Mismatch MUST return a terminal rejection such as `PROJECT_CREATE_AUTHORIZATION_MISMATCH`.

Missing authorization MUST return `PROJECT_CREATE_AUTHORIZATION_REQUIRED`.

Expired authorization MUST return `PROJECT_CREATE_AUTHORIZATION_EXPIRED`.

Consumed authorization replay MUST return `PROJECT_CREATE_AUTHORIZATION_CONSUMED` unless it is the exact idempotent replay of the already-bound committed request, in which case the original receipt is returned.

### 5.6 Atomic consumption

Authorization consumption and project-ID allocation MUST be serialized by RegistryGuard.

A committed project creation MUST consume the authorization exactly once.

A failure before allocation MUST leave the authorization reusable if no irreversible project identity was allocated.

After allocation, the authorization becomes permanently bound to the allocated project ID even if downstream completion requires recovery. It MUST NOT be released for another project.

The existing resumable RegistryGuard create flow remains responsible for finishing post-allocation recovery.

### 5.7 Project kinds

New projects MUST declare one of:

- `real`;
- `synthetic_probe`;
- `synthetic_stress_test`.

Synthetic projects MUST also carry an explicit parent or package reference when applicable.

Human project views MUST render synthetic projects as clearly fictitious/non-business. A user must not need to infer this from a name such as `Production Probe`.

Historical projects retain their current schema and history. Compatibility readers may expose `project_kind: unknown_legacy` where no durable kind exists, but MUST NOT rewrite history or silently classify a historical probe as real.

## 6. Cross-project referral contract

### 6.1 Principle

A referral is transport evidence, not target-project acceptance.

It MUST remain non-canonical until the target project performs its normal workflow.

### 6.2 Dedicated writer

Introduce a dedicated `referral.write` route separate from canonical business transactions.

It MUST:

1. remain bound to the source project/session;
2. resolve only the target identity/path required for delivery;
3. generate a standard referral envelope;
4. write only to target `INPUTS/`;
5. return a transport receipt;
6. never load target business context merely to deliver the referral.

The transport receipt is evidence of delivery to `INPUTS/`, not evidence of target ingestion or acceptance.

### 6.3 Referral envelope

New referrals MUST contain at least:

- `schema_version`;
- `referral_id`;
- `source_project_id`;
- `target_project_id`;
- `referral_type`;
- `title`;
- `created_at`;
- `source_refs`;
- `canonical: false`;
- body/content.

Allowed `referral_type` values:

- `anomaly`;
- `dependency`;
- `research`;
- `information`;
- `decision_request`;
- `improvement_request`;
- `deliverable_reference`.

The writer MUST reject unsupported referral types and source/target identity mismatches.

### 6.4 No lifecycle status in Markdown

New referral Markdown MUST NOT include mutable workflow fields such as `referral_status: incoming`.

The file is evidence. Operational intake status belongs to machine state.

This avoids stale human metadata that appears authoritative after the runtime state changes.

### 6.5 Provenance after ingestion

When a referral becomes a governed reference, the resulting reference ledger MUST retain its `referral_id` or an equivalent immutable provenance link.

The referral MUST still not create target-project canonical facts automatically.

### 6.6 Legacy compatibility

Existing referrals remain readable and ingestible without bulk rewrite.

Legacy free-form referral fields may be parsed as evidence but MUST NOT be treated as authoritative lifecycle state.

## 7. Crash-safe INPUT intake

### 7.1 Current weakness

The current ingestion sequence can perform provider effects before the final reference ledger is fully durable. It also relies primarily on provider change-feed visibility.

The new design introduces an intake journal and a direct sweep safety net.

### 7.2 Intake identity and state machine

Each observed provider revision in `INPUTS/` has one durable intake record.

The intake identity MUST be deterministic from the bound project and immutable provider revision evidence, for example a hash over:

`project_id + provider_id + object_id + revision_token`

This prevents incremental processing and direct sweep from creating two intake workflows for the same provider revision.

The state machine is:

`observed -> processing -> ingested | duplicate | failed`

`ingested` and `duplicate` are terminal.

`failed` MUST carry `retryable: true|false`:

- retryable failures are automatically retried by later cycles;
- non-retryable failures remain visible for operator resolution and MUST preserve source bytes/evidence.

Machine state MUST include at least:

- `intake_id`;
- project ID;
- provider object identity and revision evidence;
- logical input path;
- `first_seen_at`;
- `last_attempt_at`;
- `attempt_count`;
- current state;
- retryability when failed;
- step/effect evidence;
- last error when present;
- resulting document/version/reference path after success.

### 7.3 Safe ordering

The ingestion sequence MUST be:

1. validate project is active/non-archived;
2. establish durable intake intent bound to exact provider revision evidence;
3. snapshot provider input;
4. establish destination plan;
5. copy to `REFERENCES/UNCLASSIFIED/`;
6. verify destination bytes/provider evidence;
7. write immutable reference version;
8. write/update reference head and indexes;
9. verify governed reference is readable and coherent;
10. re-read source metadata and verify it still matches the intake's bound provider revision;
11. delete original `INPUTS/` object only if that exact source revision is still current;
12. mark intake terminal `ingested` or `duplicate`.

The system MUST prefer a temporary duplicate over loss of source provenance.

If the source changed during processing, the completed old revision MUST NOT delete the newer source revision. The newer revision becomes a separate intake record on the next observation/sweep.

### 7.4 Recovery

Every step MUST be idempotent and resumable.

On retry, the engine MUST inspect durable step evidence and current provider state rather than restart blindly.

If destination exists with matching evidence, resume.

If destination exists with contradictory evidence, fail closed and preserve both objects.

If source has already disappeared but the governed destination and ledger are proven complete, finish the journal as terminal success.

If source disappeared and governed completion cannot be proven, remain failed/non-terminal for operator investigation; never fabricate successful ingestion.

### 7.5 Duplicate handling

An INPUT may be deleted as a duplicate only after Project OS proves that the matching reference fingerprint still points to a current, readable governed reference with matching provider evidence.

Before deletion, source metadata MUST still match the intake-bound revision.

A stale fingerprint is not sufficient proof.

## 8. Direct INPUT sweep and watchdog

### 8.1 Cron safety net

Project OS currently runs scheduled maintenance every five minutes.

Each cycle MUST directly enumerate `INPUTS/` for every active project, independent of the managed-document change cursor.

The sweep feeds discovered files into the same intake engine used by incremental change processing.

This guarantees eventual discovery even when webhook/change-feed/cursor processing misses an event.

### 8.2 Archived projects

Archived projects MUST be skipped by both incremental intake and direct sweep.

### 8.3 Stale threshold

An input not terminal 15 minutes after `first_seen_at`, equivalent to three normal cron cycles, MUST be surfaced as stale.

Stale is an operational health classification, not a new content lifecycle embedded in the input file.

A stale intake remains eligible for retry if its failure is retryable.

### 8.4 Health state

Expose enough health data to answer:

- number of pending INPUTs per project;
- age of oldest pending INPUT;
- count of stale INPUTs;
- count of failed intake records split by retryability;
- last successful intake time;
- last reconcile time;
- last direct sweep time;
- last error summary.

The runtime SHOULD expose this through an authenticated admin/health surface and structured logs.

The watchdog MUST not mutate project business state merely because an input is stale.

## 9. Interaction with MutationGate

`INPUTS/` and `REFERENCES/` remain non-final zones for MutationGate purposes.

MutationGate MUST NOT turn a referral or other source file into an external final-zone candidate.

The intake journal is independent of artifact MutationGate intent/resolution records.

## 10. SOP changes

The portable SOP MUST be updated so that the method does not depend on undocumented runtime behavior.

The SOP MUST state:

- every canonical new project requires explicit user authorization before creation;
- synthetic projects must be explicitly typed and visibly fictitious/non-business;
- cross-project referral delivery uses the dedicated referral contract and does not imply rebinding or acceptance;
- `INPUTS/` is a transient intake zone;
- accepted intake route is `INPUTS/ -> REFERENCES/UNCLASSIFIED/ -> REFERENCES/`;
- INPUT intake is monitored and stale backlog is an operational defect;
- no target task/decision/research/deliverable is created solely because a referral exists.

## 11. Historical incident handling

### 11.1 PRJ-0006

PRJ-0006 was created without explicit user authorization and was later explicitly authorized for archival by the user.

Its archive transaction `TXN-PRJ0006-ARCHIVE-20260830-071900-A1F2` committed from revision 1 to revision 2 as `EVT-000002`.

No historical probe evidence should be deleted or rewritten.

### 11.2 Current PRJ-0003 -> PRJ-0002 referral

The current DOCIDENTITY referral remains in PRJ-0002 `INPUTS/` until the corrected intake path is available.

It MUST NOT be manually moved merely to make the workspace look clean.

After the corrected intake engine is deployed, the referral should be processed through that governed path and linked as provenance to the existing DOCIDENTITY work without rewriting the task's historical creation events.

### 11.3 DOCIDENTITY package

PR #93 and runtime implementation of IMP-DOCIDENTITY001 remain frozen until this governance hardening package has passed implementation and production validation gates.

## 12. Compatibility and migration

The package MUST be reader-first and non-destructive.

- Historical projects without `project_kind` remain readable as legacy/unknown rather than silently classified.
- Historical `project.create` receipts remain valid historical evidence.
- No authorization is retroactively invented.
- Historical referrals remain readable.
- No bulk relocation or rewrite of existing references.
- Existing Managed Document IDs and versions remain unchanged.
- Existing registry IDs remain unchanged.
- Project lifecycle semantics remain unchanged; archive stays terminal.

## 13. Rollout

### R0 — Reader and observability readiness

- add compatibility readers for project kind/referral/intake state;
- add authenticated intake health surfaces;
- no new creation gate enforced yet;
- no historical rewrite.

### R1 — Referral writer and synthetic typing

- enable standard `referral.write` for new referrals;
- accept new project-kind/authorization fields without yet enforcing the authorization frontier;
- render newly typed synthetic projects clearly in human views.

### R2 — Project creation authorization enforcement

- enable dedicated authorization issuance capability;
- establish an explicit enforcement frontier timestamp/version so historical replays remain compatible;
- RegistryGuard rejects new unauthorized `project.create`;
- verify replay, expiry, mismatch, concurrent allocation, and recovery behavior.

### R3 — Crash-safe intake

- enable intake journal;
- route incremental INPUT changes through it;
- enable direct five-minute INPUT sweep;
- expose 15-minute stale health signal.

### R4 — Incident repair and steady state

- allow the existing DOCIDENTITY referral to be ingested through the corrected pipeline;
- verify provenance and ledger state;
- verify active portfolio has no unauthorized synthetic project;
- only then unfreeze IMP-DOCIDENTITY001 for revalidation.

## 14. Invariants

### INV-GOV-001
No new canonical project ID may be allocated after the enforcement frontier without a matching, live, unconsumed project-create authorization.

### INV-GOV-002
A project-create authorization is single-use and cannot authorize a different project payload.

### INV-GOV-003
Generic transaction/referral/artifact/document writers cannot issue project-create authorization.

### INV-GOV-004
Every newly created project after the enforcement frontier has an explicit project kind.

### INV-GOV-005
Every newly created synthetic project is visibly marked fictitious/non-business in human projections.

### INV-REF-001
Every new cross-project referral emitted by the standard writer has a stable referral ID and standard referral type.

### INV-REF-002
A referral never implicitly creates target-project canonical business state.

### INV-REF-003
Referral lifecycle status is machine state, not mutable Markdown metadata.

### INV-INTAKE-001
An INPUT is not deleted until a coherent governed reference or verified duplicate exists.

### INV-INTAKE-002
Every intake step is resumable and idempotent.

### INV-INTAKE-003
A provider change cursor is not the sole discovery mechanism for INPUTS.

### INV-INTAKE-004
Every active project's INPUTS are directly swept at least once per scheduled maintenance cycle.

### INV-INTAKE-005
Inputs pending for 15 minutes or more after first observation are visible as stale operational health.

### INV-INTAKE-006
Archived projects are never processed by intake.

### INV-INTAKE-007
Completing ingestion of an older provider revision never deletes a newer source revision that appeared during processing.

## 15. Required tests

The implementation plan MUST include tests proving at minimum:

1. unauthorized new `project.create` is rejected after enforcement cutover;
2. historical pre-frontier project-create replay remains readable/idempotent;
3. expired authorization is rejected;
4. consumed authorization replay for a different request is rejected;
5. exact replay of the already-committed authorized request returns the original receipt;
6. payload mismatch is rejected;
7. concurrent project creation cannot double-consume one authorization;
8. pre-allocation failure preserves valid authorization where safe;
9. post-allocation recovery cannot reuse authorization for another project;
10. synthetic project rendering is explicitly fictitious/non-business;
11. legacy project without kind remains readable as legacy/unknown;
12. new referral writer emits exact required envelope;
13. unsupported referral type is rejected;
14. referral delivery does not load target business context;
15. referral delivery does not create task/decision/research/deliverable;
16. legacy referral remains ingestible;
17. normal incremental INPUT ingestion succeeds;
18. INPUT missed by change cursor is discovered by direct sweep;
19. incremental and sweep discovery of the same provider revision converge to one intake record;
20. crash after intake intent resumes safely;
21. crash after snapshot resumes safely;
22. crash after destination copy resumes safely;
23. crash after version write resumes safely;
24. crash after head/index write resumes safely;
25. crash after source deletion but before terminal journal update recovers to success;
26. contradictory destination evidence fails closed without deleting source;
27. duplicate source is deleted only after current reference proof;
28. stale fingerprint does not authorize deletion;
29. source revision changed during processing is not deleted by the older intake;
30. archived project sweep is skipped;
31. stale health appears 15 minutes after `first_seen_at`;
32. retryable stale intake continues retrying;
33. health clears after terminal intake;
34. current PRJ-0002 DOCIDENTITY referral can be ingested through the corrected path without rewriting existing task history;
35. no production validation step creates a new synthetic project without explicit user authorization.

## 16. Production proof constraints

Production validation MUST NOT create a new project implicitly.

If a new synthetic probe is required, the user must explicitly authorize that project through the newly implemented gate before creation.

Where possible, R0-R3 validation should use PRJ-0002 plus controlled provider fixtures or an already explicitly authorized synthetic project.

No production proof may modify PRJ-0003 business state.

## 17. Failure behavior

The system MUST fail closed when it cannot prove:

- creation authorization;
- authorization/payload identity;
- governed reference completion;
- duplicate validity;
- safe provider destination state;
- exact source revision before deletion.

Fail-closed MUST preserve evidence and source bytes whenever possible.

Operational failures MUST be observable rather than silently swallowed.

## 18. Security and trust boundary

The central trust boundary is explicit:

- the LLM may propose a project;
- the LLM may construct a create request after approval;
- the LLM cannot manufacture the independent approval capability that RegistryGuard requires.

The same principle should be retained if the operator mechanism changes in the future.

## 19. Acceptance criteria

This package is complete only when:

- the SOP documents the new rules;
- RegistryGuard enforces independent authorization for new projects;
- project kind is explicit for all newly created projects after cutover;
- synthetic human views are unambiguous;
- new referrals use the standard writer and envelope;
- intake is journaled, resumable, directly swept, and health-monitored;
- the existing stuck referral is successfully ingested by the corrected pipeline;
- PRJ-0006 remains archived with history preserved;
- regression/high-risk tests are green;
- production evidence demonstrates the gates without unauthorized project creation;
- the accepted design/implementation evidence is recorded canonically in PRJ-0002 through normal receipt-gated transactions;
- only after all of the above may IMP-DOCIDENTITY001 be unfrozen for plan revalidation.
