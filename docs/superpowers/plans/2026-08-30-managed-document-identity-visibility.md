# IMP-DOCIDENTITY001 — Managed Document identity visibility implementation plan

> Execute on branch `imp/docidentity001-visible-managed-id` with strict TDD. Do not merge to `main` until tests are green and the founder reviews the result.

## Goal

Expose authoritative Managed Document identity in human-visible Markdown across WORKING → REVIEW → DELIVERABLES, detect identity forgery during governed writes/reconciliation, and bring legacy managed Markdown publication onto the same contract without rewriting historical documents in bulk.

## Task 1 — Add the Managed Markdown identity primitive

**Files**
- Create: `src/documents/identity-frontmatter.ts`
- Create: `test/managed-document-identity-frontmatter.spec.ts`

**RED**
1. Add tests for:
   - prepending `project_id` + `document_id` when frontmatter is absent;
   - injecting missing fields into existing frontmatter while preserving unrelated metadata;
   - idempotency when both authoritative values already exist;
   - rejecting mismatching `project_id`;
   - rejecting mismatching `document_id`;
   - leaving non-Markdown content byte-identical.
2. Commit tests only.
3. Verify GitHub Actions fails for the expected missing module/behavior.

**GREEN**
4. Implement a small dedicated helper and typed identity mismatch error.
5. Run/verify the targeted test and full CI.

## Task 2 — Enrich Project-OS-authored WORKING and REVIEW versions before hashing

**Files**
- Modify: `src/documents/service.ts`
- Modify: `test/document-lifecycle.spec.ts`
- Modify or add focused assertions in: `test/managed-document-acceptance.spec.ts`

**RED**
1. Add lifecycle tests proving:
   - new Markdown WORKING contains the receipt/head `document_id` and owning `project_id`;
   - immutable payload content and `content_sha256` describe the enriched visible bytes;
   - WORKING → REVIEW → DELIVERABLES preserves exactly one visible `document_id`;
   - review rewrites with matching identity remain idempotent and do not duplicate fields.
2. Verify expected CI failure against existing behavior.

**GREEN**
3. In `writeWorking` and `writeReview`:
   - first validate caller `content_sha256` against caller bytes;
   - resolve authoritative identity;
   - enrich Markdown;
   - compute enriched SHA-256;
   - store enriched payload and write enriched provider bytes;
   - record enriched SHA-256 in the immutable version.
4. Leave move-only lifecycle operations unchanged except for assertions demonstrating identity preservation.
5. Verify targeted and full CI.

## Task 3 — Reject forged identity during reconciliation

**Files**
- Modify: `src/documents/reconciler.ts`
- Modify: `test/document-external-edits.spec.ts`

**RED**
1. Add a test that externally edits an already managed Markdown WORKING/REVIEW file and forges `document_id`.
2. Assert reconciliation does not advance the authoritative head to an externally forged identity/version and reports/fails as a conflict according to the reconciler’s existing conflict semantics.
3. Verify the test fails against current behavior.

**GREEN**
4. Before accepting an external Markdown work-product edit as a new version, inspect visible frontmatter identity when present.
5. Reject a mismatching `project_id` or `document_id` using existing reconciliation conflict handling.
6. Permit a missing identity only for historical/pre-feature content; do not perform automatic bulk rewrite.
7. Verify external-edit/reconciliation suites and full CI.

## Task 4 — Enrich managed Markdown published by the legacy artifact API

**Files**
- Modify: `src/documents/legacy-artifact.ts`
- Modify: `test/legacy-artifact-managed.spec.ts`

**RED**
1. Add a test proving a Markdown artifact routed to `DELIVERABLES/` exposes the authoritative `project_id` and `document_id`.
2. Assert managed immutable payload/hash evidence describes enriched bytes.
3. Assert non-Markdown/reference artifact bytes remain unchanged.
4. Verify expected CI failure.

**GREEN**
5. For managed Markdown deliverables only, resolve identity then enrich/hash/store/write the enriched bytes.
6. Keep legacy reference/provider-file identity behavior unchanged.
7. Preserve request-content validation/idempotency semantics by comparing request payload separately from managed visible payload where necessary.
8. Verify legacy artifact tests and full CI.

## Task 5 — Documentation and regression verification

**Files**
- Modify: `docs/managed-documents.md`
- Modify only if needed by established public contract: `README.md`

1. Document visible identity, ledger authority, hash order, mismatch behavior, lazy historical enrichment, and rename semantics.
2. Explicitly state that initial deterministic allocation remains compatibility behavior while stored head identity is authoritative after creation; future rename must preserve `document_id`.
3. Run/verify the complete GitHub Actions test suite.
4. Inspect branch diff for unrelated changes.
5. Open a pull request for review; do not merge without explicit authorization.

## Required verification evidence

Before claiming implementation complete:

- RED evidence exists for each production behavior added.
- Full CI is green on the implementation branch/PR head.
- No existing document IDs were migrated or rewritten.
- Lifecycle test proves same `document_id` across WORKING/REVIEW/DELIVERABLES.
- Reconciliation test proves forged identity is not silently adopted.
- Legacy Markdown publication test proves visible identity.
- Non-Markdown/reference byte-preservation tests remain green.

## Canonical Project OS update after implementation

Only after code verification and review:

1. Refresh PRJ-0002 canonical `HANDOFF.md`, `STATE.md`, `OPERATING.md` and current revision.
2. Record only accepted/operationally real architecture and task outcome using supported typed Project OS transactions.
3. Include exact authoritative GitHub PR/commit evidence.
4. Treat persistence as complete only after corresponding receipt has `status = committed`.
