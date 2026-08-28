# Operational Activation Contract — Design

Date: 2026-08-28
Status: approved for autonomous implementation
Base: `main` at `97bbb98ce5ba5430fd6a468c9983ff8d113c7993`

## Problem

Project OS can complete, merge, deploy and production-validate an improvement without proving that existing projects visibly expose it or that old/new ChatGPT conversations actually route work through it. IMP-ARTIFACT001 demonstrates the gap: Managed Documents are production-valid, but existing projects may still lack visible `INPUTS/`, `REFERENCES/`, `WORKING/`, and `REVIEW/` zones because adoption is lazy. The repository SOP describes the workflow while project-local `HANDOFF.md` does not surface a versioned current operating contract.

The separate ingress starvation defect discovered during this audit was fixed first as P0 in PR #68 / production commit `97bbb98ce5ba5430fd6a468c9983ff8d113c7993`; this activation package does not reopen transaction-ingress semantics.

## Goal

Make production capability activation observable and self-propagating to existing projects and conversations without requiring manual ChatGPT Project Instruction edits after every improvement.

Success means:

1. a chat that refreshes `HANDOFF.md` + `STATE.md` discovers the current operational contract;
2. existing active projects expose the Managed Document workspace zones;
3. sources route through `INPUTS -> REFERENCES`, drafts through `WORKING -> REVIEW -> DELIVERABLES`, while canonical facts still use typed transactions;
4. a projection/runtime upgrade activates this behavior on existing projects without changing their business revision;
5. no bulk rewrite of document history, fake document versions, or ProjectState/schema bump;
6. SCHEMA001 remains isolated and paused until this activation program is delivered.

## Chosen approach

### 1. Materialized `OPERATING.md`

Add `OPERATING.md` as a generated project-level projection output. It is an operational contract, not canonical business state. It carries an explicit `operating_contract_version` and defines:

- canonical decisions, constraints, tasks, plan/lifecycle and accepted research use typed Project OS transactions;
- files supplied for analysis/R&D enter through `INPUTS/` and are ingested to `REFERENCES/UNCLASSIFIED/` before optional classification;
- collaborative work products live in `WORKING/`;
- explicit review candidates live in `REVIEW/`;
- approved/published outputs live in `DELIVERABLES/` only through governed publication;
- generated projections (`STATE.md`, `HANDOFF.md`, `ROADMAP.md`, `TASKS/`, `DECISIONS/`, etc.) are not collaborative files and are not edited to create canonical truth;
- before editing a managed document, refresh its logical head/current version;
- receipt and MutationGate rules remain authoritative.

### 2. `HANDOFF.md` is the bootstrap pointer

Add a prominent `## Operating contract` section near the top containing:

- current contract version;
- `[[OPERATING|Current operating contract]]`;
- compact routing summary: sources -> INPUTS/REFERENCES; drafts -> WORKING/REVIEW; published -> DELIVERABLES; business facts -> typed transactions.

The compact rules are duplicated intentionally so an old chat loading only mandatory bootstrap context cannot miss the routing change. `OPERATING.md` is the expanded contract.

### 3. Projection version bump

Bump `CURRENT_PROJECTION_VERSION` from 1 to 2. This is a projection contract change, not a business-state change. Existing active projects rematerialize at the same canonical revision.

Projection version is monotonic. After any completed production projection-v2 materialization, production must not roll back to software whose current projection version is 1. Rollback builds must retain projection-v2 awareness.

### 4. Idempotent Managed Zone bootstrap

Expose a provider-neutral optional directory provisioning capability:

```ts
interface DirectoryProvisioningPort {
  ensureDirectory(path: string): Promise<void>;
}
```

Dropbox implements it with its folder-creation machinery. Existing directory = success; missing parents are created in order; a file collision fails closed.

During active-workspace materialization ensure:

```text
INPUTS/
REFERENCES/
REFERENCES/UNCLASSIFIED/
WORKING/
REVIEW/
DELIVERABLES/
```

No sentinel files are created. Archived projects are not provisioned in the active workspace.

### 5. No implicit migration

Bootstrap creates missing directories and generated operating projections only. It does not move existing `ARTIFACTS/`, `RESEARCH/`, `DELIVERABLES/`, or historical files. Existing managed-compatible content remains subject to IMP-ARTIFACT001 lazy adoption and strict final-zone provenance.

### 6. Activation audit vocabulary

Future user-visible workflow changes are assessed as:

- `IMPLEMENTED`
- `PRODUCTION DEPLOYED`
- `RUNTIME ACTIVE`
- `PROJECT ACTIVATED` when applicable
- `CHAT CONTRACT ACTIVE` when behavior changes
- `E2E VERIFIED`

Deployment alone is not evidence of adoption.

## Error handling

- Missing directory-provisioning capability: fail activation clearly; no sentinel workaround.
- Folder path occupied by a file: fail closed and surface the path.
- Projection-v2 materialization failure: canonical state stays authoritative and prior completed projection remains valid.
- `OPERATING.md` external edit: generated-projection conflict/recovery rules apply.
- Managed-zone external content: existing Managed Documents and MutationGate rules apply.

## Scope

In scope: `OPERATING.md`, HANDOFF bootstrap contract, projection v2, provider-neutral idempotent directory provisioning, Dropbox implementation/mocks/tests, active-project zone provisioning, SOP activation checklist, production validation on PRJ-0002, and read-only activation audit of completed packages.

Out of scope: ProjectState/schema redesign, SCHEMA001 V2 writer activation, alternate providers, historical content movement, canonical decision/plan semantic changes, weakening MutationGate, per-release manual ChatGPT Project Instruction edits, or SCHEMA001 merge/deploy.

## Verification

TDD must prove:

1. `renderHandoff` exposes contract version, OPERATING link and compact routing;
2. projection planner includes `OPERATING.md` and projection version 2 forces full regeneration from v1;
3. directory provisioning creates all managed zones idempotently and refuses file collisions;
4. archived project materialization does not provision active zones;
5. no sentinel/fake document records are produced;
6. existing materialization, Managed Documents, MutationGate, persistence high-risk and recovery suites stay green;
7. Wrangler dry-run succeeds;
8. production PRJ-0002 reaches projection v2 at unchanged canonical revision and exposes `OPERATING.md` plus managed zones;
9. E2E proves source intake and governed WORKING -> REVIEW -> DELIVERABLES behavior;
10. activation audit categorizes all already-completed packages by actual adoption status.

## Rollback

Before first completed production projection-v2 materialization, normal deployment rollback is permitted. After that frontier, rollback is only to software that still understands projection v2. No destructive folder cleanup is required.