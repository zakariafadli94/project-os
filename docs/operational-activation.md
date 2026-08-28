# Project OS — Operational Activation

## Purpose

A Project OS improvement is not considered adopted merely because its code was merged or deployed. User-visible workflow changes require evidence that the runtime exposes the capability to existing projects and that chats discover the current operating contract from project-local bootstrap context.

This document defines the activation and verification contract used after the projection-v2 Operational Activation rollout.

## Activation vocabulary

Use these states independently. Do not collapse them into a generic "done" status.

- `IMPLEMENTED`: the capability exists in tested source code.
- `PRODUCTION DEPLOYED`: the exact implementation commit is deployed to the production runtime.
- `RUNTIME ACTIVE`: production configuration/execution paths actually enable the capability.
- `PROJECT ACTIVATED`: an applicable existing project exposes the required project-local structures or generated views.
- `CHAT CONTRACT ACTIVE`: a chat that refreshes mandatory project bootstrap context can discover how to use the capability without relying on an old conversation or hidden memory.
- `E2E VERIFIED`: a representative production workflow has exercised the capability through its governed path and the resulting evidence has been checked.

Deployment alone is never proof of project or chat adoption.

## Chat bootstrap contract

For meaningful work in a bound project, start with fresh:

```text
HANDOFF.md
STATE.md
```

When `HANDOFF.md` exposes an operating contract, load the referenced `OPERATING.md` whenever routing, files, publication, durable mutation or workflow behavior is relevant.

Old chats are not exempt. Their prior instructions and document copies are stale working context until refreshed against the current project bootstrap.

For a project materialized with projection v2 or later, the project-local `HANDOFF.md` + linked `OPERATING.md` are the current operational routing contract. If an older generic SOP sentence conflicts with that project-local contract — for example legacy wording that managed folders are exposed only lazily — the current project-local contract governs. Canonical business-state authority and typed mutation rules are unchanged by this precedence rule.

The compact routing contract is:

```text
sources / supplied files
  -> INPUTS/
  -> REFERENCES/UNCLASSIFIED/
  -> REFERENCES/<explicit collection> when classified

collaborative drafts
  -> WORKING/
  -> REVIEW/
  -> DELIVERABLES/ only through governed publication

canonical business facts
  -> typed Project OS transaction
  -> committed receipt gate
```

Generated project projections such as `STATE.md`, `HANDOFF.md`, `ROADMAP.md`, `TASKS/`, `DECISIONS/`, `CONSTRAINTS/` and `RESEARCH/` remain generated/canonical-derived views; editing them never creates canonical truth.

## Managed-zone activation

Projection-v2 runtime ensures the visible workspace skeleton for every non-archived project:

```text
INPUTS/
REFERENCES/
REFERENCES/UNCLASSIFIED/
WORKING/
REVIEW/
DELIVERABLES/
```

Folder skeleton activation is **eager**. Historical content adoption remains **lazy** and governed by the Managed Documents ledger and MutationGate.

Therefore activation does not:

- move historical `ARTIFACTS/`, `RESEARCH/`, `DELIVERABLES/` or other content;
- invent document versions;
- create sentinel files;
- convert path presence into approval/publication;
- change the canonical business revision merely to expose the new projection contract.

Archived projects are not provisioned back into an active workspace.

## Projection frontier

`CURRENT_PROJECTION_VERSION = 2` introduces `OPERATING.md`, the HANDOFF bootstrap block and managed-zone activation.

Existing projects rematerialize at their current canonical business revision. A projection-version change is not a business transaction.

After the first successful production projection-v2 generation, production must not roll back to software that understands only projection v1. Any rollback build must retain projection-v2 awareness.

## Activation checklist for a user-visible improvement

For each completed package, record or verify as applicable:

1. implementation commit / merged PR;
2. exact production deployment commit;
3. production health/configuration showing the relevant path enabled;
4. project-local activation evidence for existing projects when the feature has a project surface;
5. chat-contract evidence when the feature changes how chats route or perform work;
6. governed end-to-end proof for the representative user workflow;
7. rollback/recovery constraints introduced by activation.

A package can legitimately be runtime-active but conditional or invisible in normal operation. Examples include recovery, rollback and provider retry. Such packages do not require fake visible activity; their activation evidence is the enabled production path plus a controlled proof/fault test.

A test-only package such as deterministic fault injection is not expected to run in production runtime behavior.

## Managed Documents distinction

The earlier Managed Documents rollout intentionally used lazy content adoption and did not bulk-rewrite existing projects. Projection-v2 changes only the visible **workspace skeleton and operating-contract exposure**.

The durable document rules remain:

- `INPUTS` ingestion snapshots source bytes before moving them to `REFERENCES/UNCLASSIFIED`;
- `REFERENCES` edits become new reference versions;
- `WORKING` and `REVIEW` use logical head/version and provider CAS protection;
- `DELIVERABLES` requires governed publication/provenance;
- unknown strict final-zone files are MutationGate candidates, never implicit publications.

See `docs/managed-documents.md` and `docs/mutation-gate.md` for the detailed lifecycle.

## Delivery gate before resuming IMP-SCHEMA001

The activation program is deliverable only when all of the following are true:

- the inbox-priority P0 is production-proven;
- Operational Activation code has full CI, persistence high-risk and Wrangler dry-run evidence;
- the exact merge commit is production deployed and health-checked;
- PRJ-0002 has a completed projection-v2 generation at its pre-activation canonical revision;
- PRJ-0002 exposes `OPERATING.md`, the HANDOFF operating-contract bootstrap and all managed zones;
- the completed-package activation audit is recorded and no critical adoption gap remains;
- representative Managed Documents routing is E2E verified through governed paths;
- durable Project OS closure evidence is persisted through the normal receipt gate.

Only after this gate may execution return to IMP-SCHEMA001 / PR #67.
