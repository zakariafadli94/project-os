# IMP-DOCIDENTITY001 — Managed Document identity visibility design

Date: 2026-08-30
Project: PRJ-0002 — Project OS
Status: founder-approved design

## Problem

Project OS already owns a stable `document_id` in the Managed Documents ledger, but Markdown files materialized in `WORKING/`, `REVIEW/` and `DELIVERABLES/` do not reliably expose it. A human opening the file therefore cannot identify the logical document without consulting hidden `.project-os/` state.

The field observation came from PRJ-0003 and was accepted for implementation in PRJ-0002. This improvement is intentionally separate from the later REVIEW active-head / supersession lifecycle problem.

## Goals

1. Every Project-OS-authored Markdown work product exposes `project_id` and its authoritative `document_id` in YAML frontmatter.
2. The visible `document_id` remains identical through WORKING → REVIEW → DELIVERABLES and across immutable versions.
3. The ledger remains authoritative. A forged or mismatching visible `document_id` is never silently adopted.
4. Immutable payload evidence and recorded SHA-256 describe the exact enriched bytes Project OS materializes and can later restore.
5. Legacy artifact publication into `DELIVERABLES/` follows the same visible identity rule.
6. Existing historical documents are not mass-rewritten.

## Non-goals

- No REVIEW queue cleanup or supersession primitive in this change.
- No batch backfill of historical documents.
- No general YAML parser or canonical-projection frontmatter redesign.
- No new rename endpoint in this change.
- No identity frontmatter injection into binary/reference files.

## Identity contract

`document_id` remains a Project OS logical identity, not a provider identity and not a business-task identity.

- `project_id`: owning project.
- `document_id`: stable logical Managed Document identity.
- `version_id`: immutable version identity.
- `task_id` / `decision_id`: optional business relationships, never substitutes for `document_id`.
- provider object/file ID: persistence evidence only.

For compatibility, initial work-product identity may continue to be deterministically allocated from `project_id + initial logical_path`. Once the head exists, the stored `document_id` is authoritative and must not be recomputed as the meaning of identity. A future governed rename operation must update `logical_path` while preserving the existing `document_id`.

This preserves every existing `DOC-…` value while establishing path-independence after creation.

## Markdown enrichment

A dedicated Managed Documents helper enriches Markdown content before durable payload storage and provider materialization.

For Markdown work products, the visible representation must contain:

```yaml
---
project_id: PRJ-0003
document_id: DOC-08B3524AC1CB4D6AE7079816
...
---
```

Rules:

1. If no YAML frontmatter exists, prepend minimal frontmatter containing `project_id` and `document_id`.
2. If frontmatter exists and either field is absent, inject the missing authoritative field without removing unrelated metadata.
3. If `project_id` or `document_id` exists with the authoritative value, preserve it and do not duplicate it.
4. If either visible identity field conflicts with the authoritative ledger/request context, fail closed with a managed-document identity conflict.
5. Non-Markdown content is returned unchanged.
6. Re-enrichment is idempotent.

The helper is deliberately scoped to simple top-level YAML key detection/insertion. It does not reinterpret arbitrary YAML values or reorder user metadata beyond the required inserted identity lines.

## Hash and immutable payload semantics

Incoming request integrity and stored visible-content integrity are distinct checkpoints:

1. validate `request.content_sha256` against the bytes supplied by the caller;
2. resolve the authoritative `document_id`;
3. enrich Markdown with authoritative identity;
4. compute SHA-256 of the enriched content;
5. store the enriched content as the immutable text payload;
6. write the same enriched content to the visible provider path;
7. record the enriched-content SHA-256 in the `DocumentVersionRecord`.

This prevents recovery from restoring pre-enrichment bytes and avoids a hash/content mismatch. Request-idempotency still binds to the caller request payload through the existing request intent layer.

## Lifecycle

### WORKING create/update

`writeWorking` resolves the authoritative `document_id`, enriches Markdown, hashes/stores the enriched bytes, and materializes those exact bytes.

### REVIEW

Promotion moves the already-enriched file, so `document_id` stays unchanged. A direct review rewrite validates/injects the same authoritative identity before creating the next review version.

### DELIVERABLES

Publication moves or conditionally copies the enriched review bytes. No identity mutation occurs during publication.

### Reopen

Reopening a published document preserves the same bytes and same head identity.

## External edits and reconciliation

For an already managed Markdown work product, reconciliation validates visible identity before accepting an external edit as a new immutable version.

- matching `project_id` + `document_id`: accept normal external-edit flow;
- mismatching visible identity: mark/fail as conflict; never adopt the forged ID;
- missing identity on a historical pre-feature managed document: do not globally rewrite it merely because the feature was deployed. It may be enriched opportunistically on the next governed rewrite/republication; a separate explicit migration can be added later if needed.

New Project-OS-authored Markdown produced after this feature must always carry visible identity.

## Legacy artifact API

For managed Markdown artifacts routed to `DELIVERABLES/`:

1. resolve the same work-product `document_id` used by the Managed Documents ledger;
2. validate the caller content hash;
3. enrich the Markdown;
4. store/materialize the enriched bytes;
5. record the enriched SHA-256 in the managed version evidence.

Legacy references and non-Markdown artifacts remain byte-preserving.

## Failure modes

- `DOCUMENT_IDENTITY_MISMATCH`: visible `document_id` conflicts with authoritative identity.
- `PROJECT_IDENTITY_MISMATCH`: visible `project_id` conflicts with owning project.
- Existing provider CAS/stale-version conflicts remain unchanged.
- Identity validation must occur before accepting a mismatching external Markdown edit as a new logical version.

## Compatibility and migration

- Keep current `DOC-[A-F0-9]{24}` shape.
- Keep existing document IDs unchanged.
- Keep schema-compatible ledger records; no mass durable-state rewrite is required.
- Do not rewrite historical WORKING/REVIEW/DELIVERABLES merely on deployment.
- Newly governed writes become enriched immediately.

## Acceptance criteria

1. A new Markdown WORKING document contains its authoritative `project_id` and `document_id`.
2. Promotion to REVIEW retains exactly the same visible `document_id`.
3. Publication retains exactly the same visible `document_id`.
4. Successive versions retain the same `document_id` while receiving different `version_id` values.
5. Existing task/decision metadata remains intact alongside `document_id`.
6. A matching pre-existing identity is not duplicated.
7. A forged/mismatching `document_id` is rejected or reconciled as conflict rather than adopted.
8. A managed Markdown artifact published through the legacy artifact API exposes the authoritative `document_id`.
9. Non-Markdown/reference bytes are not changed by frontmatter enrichment.
10. No historical bulk rewrite is performed.

## Testing strategy

Use strict RED → GREEN TDD on an isolated branch.

- Unit tests for frontmatter enrichment/idempotency/mismatch/non-Markdown behavior.
- Lifecycle integration test proving one visible identity from WORKING through REVIEW and publication.
- Review rewrite test proving matching identity is preserved and recorded payload hash matches enriched bytes.
- Reconciliation test proving a forged visible `document_id` cannot become authoritative.
- Legacy artifact test proving managed Markdown publication exposes the ID.
- Existing Managed Documents, external-edit, bootstrap, persistence and legacy tests remain green.
