# Operational Activation Contract — Implementation Plan

Date: 2026-08-28
Branch: `feat/operational-activation-delivery`
Base production commit: `97bbb98ce5ba5430fd6a468c9983ff8d113c7993`
Design: `docs/superpowers/specs/2026-08-28-operational-activation-contract-design.md`

## Constraints

- TDD: observe RED before production code for each behavior.
- No ProjectState/schema changes.
- No SCHEMA001 writer activation or merge.
- No historical file moves or bulk document adoption.
- No sentinel files for empty managed zones.
- Preserve MutationGate `enforce` and current canonical write semantics.
- Projection v2 is monotonic; once crossed in production, rollback binaries must retain v2 awareness.

## Task 1 — Operating contract renderer

Files:
- add `src/render/operating.ts`
- modify `src/render/handoff.ts`
- modify `test/render.spec.ts`

RED:
- assert `renderOperating` exists and contains `operating_contract_version: 1`, managed-document routing and canonical transaction rules.
- assert HANDOFF contains version, `[[OPERATING|Current operating contract]]`, and compact routing summary.

GREEN:
- implement deterministic managed Markdown renderer.

## Task 2 — Projection v2

Files:
- modify `src/domain/materialization.ts`
- modify `src/materialization/planner.ts`
- modify `test/materialization-planner.spec.ts`

RED:
- initial v2 plan includes `global:OPERATING -> OPERATING.md`.
- current runtime projection version is 2.
- v1 baseline to v2 rematerializes all outputs at unchanged business revision.

GREEN:
- add OPERATING descriptor and bump `CURRENT_PROJECTION_VERSION` to 2.

## Task 3 — Directory provisioning provider capability

Files:
- modify `src/persistence/provider/contract.ts`
- modify `src/persistence/provider/capabilities.ts`
- modify `src/persistence/providers/dropbox/client.ts`
- modify `src/persistence/providers/dropbox/adapter.ts`
- modify Dropbox provider tests.

RED:
- `ensureDirectory` creates missing nested directories idempotently.
- existing folder is success.
- file collision fails closed.
- runtime exposes capability through the provider boundary.

GREEN:
- expose `DirectoryProvisioningPort`.
- add `DropboxTransport.ensureDirectory` and `DropboxClient.ensureDirectory` using existing create-folder parent recovery.
- distinguish folder-exists from file/unknown conflict.

## Task 4 — Active workspace managed-zone bootstrap

Files:
- modify `src/materialization/writer.ts`
- modify `src/materialization/coordinator.ts`
- add/modify coordinator/writer tests.

Managed zones:
- `INPUTS`
- `REFERENCES`
- `REFERENCES/UNCLASSIFIED`
- `WORKING`
- `REVIEW`
- `DELIVERABLES`

RED:
- active materialization provisions all zones before projection outputs.
- repeated materialization is idempotent.
- archived materialization does not provision active zones.
- missing capability fails clearly.
- provisioning creates no projected output/document ledger entry.

GREEN:
- add writer directory-provisioning method backed by provider capability.
- coordinator invokes it only for non-archived active workspace.

## Task 5 — Activation vocabulary / SOP documentation

Files:
- update current Project OS SOP/documentation in repository.
- add activation checklist vocabulary: IMPLEMENTED, PRODUCTION DEPLOYED, RUNTIME ACTIVE, PROJECT ACTIVATED, CHAT CONTRACT ACTIVE, E2E VERIFIED.

Verification:
- documentation explicitly separates deployment from adoption.

## Task 6 — Full verification and PR

Run through CI:
- `npm run check`
- `npm run test:persistence-high-risk`
- `npx wrangler deploy --dry-run`

Self-review:
- no schema changes.
- no historical managed-doc rewrite.
- no direct canonical writes.
- no sentinel files.
- archive behavior unchanged except explicit no-provision rule.
- P0 inbox priority remains green.

Open draft PR and keep production blocked until all gates green.

## Task 7 — Production rollout and PRJ-0002 proof

After merge/deploy:
- verify exact deployed SHA and health.
- verify PRJ-0002 canonical revision is unchanged by projection upgrade.
- verify materialization head reaches projection version 2.
- verify `OPERATING.md` and HANDOFF contract are present.
- verify `INPUTS/`, `REFERENCES/UNCLASSIFIED/`, `WORKING/`, `REVIEW/`, `DELIVERABLES/` exist.
- verify old generated projections remain present.

## Task 8 — Activation audit

Audit already-completed improvement packages against:
- IMPLEMENTED
- PRODUCTION DEPLOYED
- RUNTIME ACTIVE
- PROJECT ACTIVATED
- CHAT CONTRACT ACTIVE
- E2E VERIFIED

Only create follow-up fixes for concrete activation gaps; do not expand feature scope.

## Task 9 — Delivery gate

Delivery is complete only when:
- P0 inbox proof remains valid;
- activation code is merged/deployed and exact SHA proven;
- PRJ-0002 is projection v2 at unchanged business revision;
- managed zones + OPERATING/HANDOFF are observable;
- activation audit is complete and critical gaps closed;
- canonical Project OS closure evidence is committed through Project Guard.

Only then resume IMP-SCHEMA001 PR #67 from its existing draft state.