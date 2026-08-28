# Operational Activation Contract — Design

Date: 2026-08-28
Status: written spec ready for user review
Base: `main` at `a461f4ccc71de8f5fc0310381f3d2829d1466f2b`

## Problem

Project OS currently treats an improvement package as complete after implementation, exact-head verification, production deployment, health validation, and canonical closure. That proves the runtime exists, but it does not prove that existing projects visibly expose the capability or that old/new ChatGPT conversations actually route work through it.

IMP-ARTIFACT001 demonstrates the gap. Managed Documents are deployed and production-valid, but existing PRJ-0002 still lacks visible `INPUTS/`, `REFERENCES/`, `WORKING/`, and `REVIEW/` zones because adoption is lazy. The repository SOP already describes the managed-document workflow, while the project-local `HANDOFF.md` loaded by chats does not surface the active operating contract.

A second symptom is ingress orchestration: the runtime already supports immediate governed routes, but conversations may still behave as if Dropbox `incoming` + cron were the normal interactive path. That ingress symptom is tracked by the activation audit but is not coupled into the first Managed Documents activation change unless tests prove the same root cause.

## Goal

Make production capability activation observable and self-propagating to existing projects and conversations without making correctness depend on manually editing ChatGPT Project Instructions after every improvement.

Success means:

1. a chat that refreshes `HANDOFF.md` + `STATE.md` discovers the current operational contract;
2. existing active projects expose the Managed Document workspace zones;
3. sources route through `INPUTS -> REFERENCES`, drafts through `WORKING -> REVIEW -> DELIVERABLES`, while canonical facts still use typed transactions;
4. a projection/runtime upgrade can activate this behavior on existing projects without changing their business revision;
5. no bulk rewrite of document history, no fake document versions, and no ProjectState/schema bump are required;
6. SCHEMA001 remains isolated and paused from production cutover.

## Chosen approach

### 1. Materialized `OPERATING.md`

Add `OPERATING.md` as a generated project-level projection output. It is a concise operational contract, not canonical business state. It defines the current routing rules that chats and humans must follow.

Initial contract:

- canonical decisions, constraints, tasks, plan/lifecycle and accepted research use typed Project OS transactions;
- files supplied for analysis/R&D enter through `INPUTS/` and are ingested to `REFERENCES/UNCLASSIFIED/` before optional classification;
- collaborative work products live in `WORKING/`;
- explicit review candidates live in `REVIEW/`;
- approved/published outputs live in `DELIVERABLES/` only through governed document/artifact publication;
- generated projections (`STATE.md`, `HANDOFF.md`, `ROADMAP.md`, `TASKS/`, `DECISIONS/`, etc.) are not collaborative files and must not be directly edited to create canonical truth;
- before editing a managed document, refresh its logical head/current version;
- receipt and MutationGate rules remain authoritative.

The contract has an explicit `operating_contract_version` so future behavior changes are visible and testable.

### 2. `HANDOFF.md` becomes the bootstrap pointer

`HANDOFF.md` is already part of mandatory session bootstrap. Add a prominent `## Operating contract` section near the top with:

- the current contract version;
- a required link to `[[OPERATING|Current operating contract]]`;
- a compact routing summary (`sources -> INPUTS/REFERENCES`, `drafts -> WORKING/REVIEW`, `published -> DELIVERABLES`, `business facts -> typed transactions`).

The compact rules are intentionally present in `HANDOFF.md` itself so a chat cannot miss the new routing merely because it has not yet opened the linked detail file. `OPERATING.md` remains the authoritative expanded contract.

This uses the existing context-load path rather than requiring every ChatGPT Project Instruction to be manually rewritten after future improvements.

Old chats remain safe because Project OS already requires fresh `HANDOFF`/canonical state before significant durable work.

### 3. Projection version bump

Bump `CURRENT_PROJECTION_VERSION` from 1 to 2.

Reason: this is a projection contract change, not a business-state change. The materialization coordinator already rematerializes when the completed head projection version differs from the runtime projection version. This causes existing active projects to receive the new `HANDOFF.md` + `OPERATING.md` without inventing a canonical revision.

No ProjectState schema change is involved.

Projection version is monotonic. Once any production project has a completed projection-v2 materialization, production software must not be rolled back to a build whose current projection version is 1. Any rollback build after that frontier must retain projection-v2 read/write awareness even if it disables the new activation behavior.

### 4. Idempotent Managed Zone bootstrap

Expose a provider-neutral optional directory-provisioning capability:

```ts
interface DirectoryProvisioningPort {
  ensureDirectory(path: string): Promise<void>;
}
```

Dropbox implements it using the folder-creation logic already present internally in `DropboxClient`. It must be idempotent: existing folder is success; missing parents are created in order; a file collision fails closed.

During active-workspace materialization, ensure these directories exist:

```text
INPUTS/
REFERENCES/
REFERENCES/UNCLASSIFIED/
WORKING/
REVIEW/
DELIVERABLES/
```

No sentinel files are created, so the document reconciler cannot accidentally ingest/bootstrap fake documents.

Archived projects are not reactivated or provisioned in the active workspace.

### 5. No implicit migration of existing content

Bootstrap only creates missing directories and the generated operating contract. It does not move existing `ARTIFACTS/`, `RESEARCH/`, `DELIVERABLES/`, or other historical files.

Existing managed-compatible files continue to use IMP-ARTIFACT001 lazy adoption rules when first encountered. Strict final-zone provenance rules remain enforced by MutationGate.

### 6. Activation audit vocabulary

Add a small operational checklist to the SOP/roadmap for future packages:

- `IMPLEMENTED`
- `PRODUCTION DEPLOYED`
- `RUNTIME ACTIVE`
- `PROJECT ACTIVATED` (when applicable)
- `CHAT CONTRACT ACTIVE` (when behavior changes)
- `E2E VERIFIED`

Package closure may still remain package-specific, but any user-visible workflow change must explicitly prove the final two states rather than assuming deployment implies adoption.

## Data flow after rollout

```text
Chat starts/resumes
  -> read HANDOFF.md + STATE.md
  -> HANDOFF contains compact routing rules and operating contract version
  -> chat loads OPERATING.md for the expanded current contract

User provides source file
  -> INPUTS/
  -> reconciler snapshots evidence
  -> REFERENCES/UNCLASSIFIED/
  -> optional explicit classification

User/AI develops work product
  -> governed document create/update in WORKING/
  -> submit review -> REVIEW/
  -> explicit publish/approval -> DELIVERABLES/

Accepted business fact
  -> typed canonical transaction
  -> receipt gate
  -> projection/materialization
```

## Error handling

- Missing directory-provisioning capability: fail activation clearly; do not create sentinel files or bypass provider boundary.
- Folder path occupied by a file: fail closed and surface the conflicting path.
- Projection v2 materialization failure: canonical business state remains authoritative; previous completed projection head remains valid until v2 completes.
- `OPERATING.md` externally edited: treat as a generated projection; preserve unexpected bytes through existing projection recovery behavior and restore governed content.
- Managed zone external content: existing Managed Documents and MutationGate rules apply; directory bootstrap itself creates no document identity.

## Scope boundaries

In scope:

- `OPERATING.md` renderer/projection;
- `HANDOFF.md` activation pointer and compact routing contract;
- projection version 2;
- provider-neutral idempotent directory provisioning;
- Dropbox implementation and mocks/tests;
- active-project managed-zone provisioning;
- SOP/roadmap activation checklist;
- E2E validation on PRJ-0002 after deployment;
- read-only activation audit of the other already-completed improvement packages.

Out of scope:

- ProjectState/schema redesign;
- SCHEMA001 V2 writer activation;
- alternate persistence providers;
- moving/reclassifying historical files;
- changing canonical decision/plan semantics;
- changing MutationGate `enforce`;
- editing ChatGPT Project Instructions on every release;
- merging/deploying SCHEMA001;
- changing transaction ingress behavior unless the separate activation audit proves and scopes that defect independently.

## Verification plan

TDD must cover at minimum:

1. `renderHandoff` exposes the contract version, `OPERATING.md` link and compact routing summary;
2. projection planner includes `OPERATING.md` and projection version 2 forces a full regeneration from a v1 baseline;
3. directory provisioning creates all six managed zones idempotently and refuses file collisions;
4. archived project materialization does not provision active managed zones;
5. no sentinel/fake managed-document records are produced;
6. existing materialization, managed-document, MutationGate, persistence high-risk and recovery suites remain green;
7. Wrangler dry-run succeeds;
8. after production deployment, PRJ-0002 materialization head reaches projection version 2 at its unchanged canonical revision and the six zones plus `OPERATING.md` are present;
9. E2E smoke: a source enters `INPUTS` and lands in `REFERENCES/UNCLASSIFIED`; a governed work product progresses `WORKING -> REVIEW -> DELIVERABLES` without direct final-zone bypass;
10. activation audit records which completed packages are always-on, lazy/project-scoped, chat-contract-dependent, or still require a separate activation fix.

## Rollback

Before the first completed production projection-v2 materialization, normal deployment rollback is permitted.

After the projection-v2 frontier is crossed, rollback is allowed only to software that still understands projection version 2. It may disable new behavior if necessary, but it must not advertise `CURRENT_PROJECTION_VERSION = 1` or attempt a down-projection.

This frontier is safe because:

- no canonical business schema changed;
- no existing document history is rewritten;
- new folders are harmless provider structure;
- projection v2 records are derived evidence and canonical state remains unchanged;
- rollback software that retains v2 awareness can continue to read the completed projection head and preserve the workspace without destructive cleanup.

No destructive folder cleanup is required during rollback.