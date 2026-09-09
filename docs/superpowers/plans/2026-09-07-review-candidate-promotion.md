# Governed binary REVIEW candidate promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit, idempotent and receipt-gated operation that promotes one committed binary REVIEW candidate into a new managed published document under `DELIVERABLES`.

**Architecture:** Extend the managed-document request union with `review_candidate.promote`. ProjectGuard delegates to `ManagedDocumentService`, which reloads immutable candidate terminal evidence, revalidates the provider object and bytes, rejects stale revisions/collisions, snapshots the provider bytes, writes an immutable published version and head, then returns a durable acceptance receipt. Candidate files remain in REVIEW.

**Tech Stack:** TypeScript, Zod, Cloudflare Workers/Durable Objects, provider-neutral persistence with the existing Dropbox evidence adapter, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-review-candidate-promotion-design.md`

## Global Constraints

- Branch only; no merge, deployment, environment activation or PRJ-0007 publication.
- ProjectGuard serialization and enforced MutationGate remain mandatory.
- `accepted: true` is required in the promotion request; REVIEW ingress receipts remain `accepted: false`, `published: false`.
- Promotion is create-only per logical path and preserves candidate evidence.
- The current provider id, object id, revision token, size, integrity hash, SHA-256 and supported signature must match immediately before copy.

---

### Task 1: Lock the request, receipt and version contracts

**Files:**
- Modify: `src/domain/managed-document-request.ts`
- Modify: `src/domain/managed-document.ts`
- Modify: `src/schema/managed-document.ts`
- Modify: `src/documents/service.ts`
- Test: `test/managed-document-request.spec.ts`

- [x] **Step 1: Write failing parser and version assertions**

Add a `review_candidate.promote` request with `candidate_request_id`, `logical_path`, `expected_project_revision` and literal `accepted: true`; assert a missing/false acceptance and unsafe target are rejected. Add a version assertion for `source_candidate_request_id` and a promotion receipt assertion.

- [x] **Step 2: Run the focused test and confirm RED**

Run `npm test -- test/managed-document-request.spec.ts` and confirm the new operation is rejected as an unknown discriminant before implementation.

- [x] **Step 3: Add the smallest production contract**

Extend the Zod union, version schemas, `DocumentVersionRecord`, `ManagedDocumentReceipt`, and `receiptFor` with the promotion fields while preserving all existing operations.

- [x] **Step 4: Run the focused test and confirm GREEN**

Run `npm test -- test/managed-document-request.spec.ts` and confirm all parser and version assertions pass.

- [x] **Step 5: Commit**

Run `git add src/domain/managed-document-request.ts src/domain/managed-document.ts src/schema/managed-document.ts src/documents/service.ts test/managed-document-request.spec.ts` and commit with `feat: define managed review candidate promotion contract`.

### Task 2: Add immutable candidate lookup and promotion evidence

**Files:**
- Modify: `src/artifacts/review-journal.ts`
- Modify: `src/persistence/layout.ts`
- Modify: `src/documents/repository.ts`
- Create: `src/documents/promotion-journal.ts`
- Test: `test/review-candidate-journal.spec.ts`

- [x] **Step 1: Write failing lookup and immutable-evidence tests**

Exercise lookup by project/candidate id, require a committed candidate receipt with a final observation, reject a missing/rejected/foreign terminal, and prove the promotion evidence is immutable on conflicting rewrite.

- [x] **Step 2: Run focused tests and confirm RED**

Run `npm test -- test/review-candidate-journal.spec.ts`; confirm the lookup API and promotion journal are absent.

- [x] **Step 3: Implement exact candidate lookup and promotion evidence**

Add a validated `terminalByRequestId` lookup, a safe promotion evidence path under the project document namespace, and create-only write/read helpers that compare canonical JSON on provider conflicts.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run `npm test -- test/review-candidate-journal.spec.ts` and verify immutable evidence and provider observation checks.

- [x] **Step 5: Commit**

Commit with `feat: persist immutable review candidate promotion evidence`.

### Task 3: Implement binary promotion in ManagedDocumentService

**Files:**
- Modify: `src/artifacts/review-bytes.ts`
- Modify: `src/documents/service.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Test: `test/review-candidate-promotion.spec.ts`

- [x] **Step 1: Write failing end-to-end promotion tests**

Create a project and a committed binary candidate, then assert explicit promotion creates one published work-product head, a `DELIVERABLES` provider object, an immutable provider payload and a receipt with `accepted: true`, `published: true` and the candidate id. Add tests for missing acceptance, stale revision, provider revision/hash/size changes, target collision, exact replay after SQL receipt loss, and candidate retention.

- [x] **Step 2: Run the focused suite and confirm RED**

Run `npm test -- test/review-candidate-promotion.spec.ts`; confirm the operation is currently rejected as an unsupported managed-document request.

- [x] **Step 3: Implement the promotion flow**

Reload candidate terminal evidence, verify its current observation and bytes through the review-byte validator at the visible candidate path, derive the document id, enforce revision/collision rules, copy and snapshot the provider object, write the published version and promotion evidence, then write the managed head. Repair exact provider-copy replays from matching destination evidence and never overwrite a different target.

- [x] **Step 4: Run the focused suite and confirm GREEN**

Run `npm test -- test/review-candidate-promotion.spec.ts test/managed-document-faults.spec.ts` and confirm all promotion and existing crash-recovery tests pass.

- [x] **Step 5: Commit**

Commit with `feat: promote validated review candidates into managed deliverables`.

### Task 4: Document the governed operation and run verification

**Files:**
- Modify: `docs/binary-artifact-ingress.md`
- Modify: `docs/managed-documents.md`
- Test: `test/review-candidate-promotion.spec.ts`

- [x] **Step 1: Add the operator contract**

Document the exact request shape, acceptance requirement, target collision behavior, replay semantics, evidence checks and the explicit prohibition on bulk/automatic PRJ-0007 publication.

- [x] **Step 2: Run targeted verification**

Run `npm test -- test/managed-document-request.spec.ts test/review-candidate-journal.spec.ts test/review-candidate-promotion.spec.ts test/managed-document-faults.spec.ts`.

- [x] **Step 3: Run the complete project checks**

Run the complete type, static-gate and Vitest checks, inspect the exit code and confirm no existing suite regressed. The repository's `check` script currently references the absent `scripts/check-index001-remediation.mjs`; the equivalent checked-in `check-index001-deployment-gates.mjs` gate was run directly.

- [x] **Step 4: Review the diff and branch state**

Run `git diff --check`, `git status --short --branch`, and inspect the final diff for accidental PRJ-0007 data or environment changes.

- [x] **Step 5: Commit documentation and verification evidence**

Commit with `docs: specify governed review candidate promotion`.
