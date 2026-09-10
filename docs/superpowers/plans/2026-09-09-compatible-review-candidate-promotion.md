# Compatible Review-Candidate Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Port the user-visible capability of draft PR #147 to the permanent-convergence branch without merging its obsolete runtime: an explicitly accepted binary review candidate becomes one governed managed deliverable, with immutable evidence and the normal ProjectGuard admission and receipt gate.

**Architecture:** `review_candidate.promote` is a new strict variant of `ManagedDocumentRequest`, never a `Transaction` shortcut. The existing `/v1/documents` route and ProjectGuard continue to decode an `AdmissionEnvelope`, verify its current signed mutation context before obtaining a writable capability, and commit a normal managed-document request receipt. The service reloads the immutable review-candidate terminal, re-observes its provider evidence immediately before copying, writes its deliverable through the existing provider runtime, then commits an immutable payload, document version, promotion journal and head. The source REVIEW candidate is retained.

**Tech Stack:** TypeScript, Zod 4, Cloudflare Workers/Durable Objects already bound by `wrangler.jsonc`, existing provider capability ports, Web Crypto, Vitest. No dependency, Durable Object, canonical Dropbox direct-write path, deployment, PR merge, or PRJ-0003 mutation is added.

**Design:** `docs/superpowers/specs/2026-09-09-compatible-promotion-fallback-integration-design.md`.

## Boundary and non-goals

- Do not merge, rebase, cherry-pick, or otherwise apply `origin/fix/review-candidate-promotion`; it predates and deletes active convergence and admission work.
- Do not use `working.write`, `publish`, an artifact receipt, or an untyped Worker route as a surrogate for explicit acceptance.
- Do not overwrite an existing target, remove the candidate, recreate missing evidence, or manufacture a successful receipt after ambiguous provider work.
- Preserve existing operation schemas and readable-route contracts. The new operation is additive.
- Work only against synthetic fixtures. No test injects a provider fault into PRJ-0003.

## Task 1: Specify the accepted-promotion request and terminal receipt (red first)

**Files:**
- Modify: `src/domain/managed-document-request.ts`
- Modify: `src/documents/service.ts`
- Modify: `test/managed-document-request.spec.ts`
- Create: `test/review-candidate-promotion.spec.ts`

- [ ] Write failing parser tests for a minimal valid `review_candidate.promote` request and for each missing safety field. The accepted request must have exactly `operation`, a fresh `DOCREQ-*` `request_id`, `PRJ-*` `project_id`, committed `ART-*` `candidate_request_id`, safe `logical_path`, a non-negative integer `expected_project_revision`, literal `accepted: true`, and `created_at`. Assert that surplus fields, `accepted: false`, unsafe logical paths, invalid candidate ids, and fractional/negative revisions fail parsing.
- [ ] Add `reviewCandidatePromotionSchema` to the existing discriminated union in `src/domain/managed-document-request.ts`. Export the inferred operation type through the existing `ManagedDocumentRequest`; do not relax any existing request schema.
- [ ] Add `ManagedReviewCandidatePromotionRequest` and the optional promotion fields (`candidate_request_id`, `accepted`, `published`) to `ManagedDocumentReceipt` in `src/documents/service.ts`. Keep the result status committed-only at this layer; ProjectGuard remains responsible for terminal conflict/rejection receipts.
- [ ] Add a red route-level test that creates a strict project, obtains a real signed context through `GET /v1/projects/<project_id>/mutation-context`, posts the enveloped operation to `/v1/documents`, and proves that a missing, stale, forged, or project-mismatched context is rejected before any provider copy can occur.
- [ ] Run: `"/Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ./node_modules/vitest/vitest.mjs run test/managed-document-request.spec.ts test/review-candidate-promotion.spec.ts`. Confirm the new behavior is red before implementing the parser and dispatch.

## Task 2: Make candidate evidence addressable and re-verifiable (red first)

**Files:**
- Modify: `src/artifacts/review-journal.ts`
- Modify: `src/artifacts/review-bytes.ts`
- Modify: `test/review-candidate-journal.spec.ts`
- Modify: `test/review-candidate-byte-verification.spec.ts`

- [ ] Add failing tests which seed an immutable candidate terminal and prove `ReviewCandidateJournal.terminalByRequestId(projectId, requestId)` rejects a cross-project id, a non-candidate artifact record, a mismatched terminal record, and every terminal state except committed REVIEW with `accepted: false` and `published: false`.
- [ ] Implement `terminalByRequestId` as a strict parser/binding check over the existing immutable terminal record. It must read through the existing provider runtime, not a Dropbox-specific client, and retain `MutationIntentConflictError` semantics for contradictory immutable records.
- [ ] Add a failing test where frozen candidate evidence was valid at candidate commit time but object id, provider revision token, byte size, integrity value, SHA-256, or magic signature changes before promotion. The promotion path must fail closed and create no deliverable/head/version/promotion record.
- [ ] Factor `verifyReviewBytesAtPath(runtime, request, path)` from the existing byte verifier. It must keep the 10 MiB bound, provider identity/integrity validation, SHA-256 validation, and media-signature validation; `verifyReviewBytes` remains a compatibility wrapper for the candidate source path.
- [ ] Give evidence drift a stable typed error (`ReviewCandidateEvidenceChangedError`) so ProjectGuard maps it to a durable rejected or conflict terminal with an explicit code rather than an unhandled 500. Do not log the binary, plaintext document content, signed context, or a provider URL.
- [ ] Run the two targeted review tests and confirm that the newly added drift cases fail before the helper/journal implementation, then pass afterward.

## Task 3: Add an immutable promotion evidence journal (red first)

**Files:**
- Create: `src/documents/promotion-journal.ts`
- Modify: `src/persistence/layout.ts`
- Create: `test/managed-document-promotion-journal.spec.ts`

- [ ] Write failing tests for a deterministic `machineDocumentPromotionPath(projectId, requestId)` that is machine-managed, project-bound, does not overlap documents, candidate terminals, transaction receipts, or convergence journals, and rejects malformed ids.
- [ ] Define and Zod-parse `ManagedDocumentPromotionRecord`: schema version, promotion request id, project id, candidate request id, deterministic document/version ids, logical/destination paths, `accepted: true`, `published: true`, source and destination provider observations, and timestamp. Parse evidence with the existing provider-evidence schema.
- [ ] Implement immutable create-or-equal semantics in `ManagedDocumentPromotionJournal.write`. On provider conflict, re-read and accept only byte-for-byte equivalent canonical pretty JSON; otherwise throw an immutable conflict. `read` must validate the project/request bindings after parsing.
- [ ] Add red tests for replaying the exact record, replaying a different destination or evidence under the same request id, malformed persisted JSON, and a record bound to another project. No overwrite API may be used.
- [ ] Run: `"/Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ./node_modules/vitest/vitest.mjs run test/managed-document-promotion-journal.spec.ts`.

## Task 4: Implement governed promotion in the managed-document service (red first)

**Files:**
- Modify: `src/documents/service.ts`
- Modify: `src/documents/repository.ts` only if a missing existing ledger primitive is demonstrated by a red test
- Modify: `src/domain/managed-document.ts` only if a missing stage/evidence field is demonstrated by a red test
- Modify: `test/review-candidate-promotion.spec.ts`
- Modify: `test/managed-document-lifecycle.spec.ts`

- [ ] Add tests for the complete success path: seed a committed REVIEW candidate with immutable terminal, source bytes and current provider evidence; promote it using a fresh document request and matching project revision; assert a visible deliverable, immutable provider payload, published document version, managed head, promotion journal, and committed document receipt. Assert the REVIEW candidate, its terminal receipt and source bytes still exist unchanged.
- [ ] Before any writable provider call, implement `ManagedDocumentService.promoteReviewCandidate(request, state)` to: assert project mutability; assert `state.revision === expected_project_revision`; derive `documentId`; load an exact replay version/promotion record; load candidate terminal; require committed unaccepted/unpublished REVIEW evidence; re-observe the source at its frozen path; compare identity, object id, revision, size, integrity, content SHA and signature; and reject collision with any existing managed logical target or inconsistent head.
- [ ] Copy only after the checks above. Use the provider runtime’s conditional/capability-safe primitive, not direct Dropbox APIs. Read or write the immutable provider payload with the existing managed-document ledger convention; construct the version with stage `published`, the existing allowed `source: "project_os"`, `source_candidate_request_id`, and a provider observation tied to the actual destination metadata.
- [ ] Persist in receipt-gated order: immutable payload and visible provider object, version record, immutable promotion record, then managed head. On an exact replay, compare all deterministic identifiers/evidence and return the original committed result. On an ambiguous partial effect, re-observe provider state and repair only if it exactly matches the candidate content and intended destination; otherwise return a durable non-committed terminal without advancing the head.
- [ ] Add failure tests: stale project revision, candidate rejected/conflicted/missing, candidate already accepted/published, candidate evidence drift, destination object collision, existing managed logical collision, wrong source bytes, provider conditional-write conflict, duplicate exact replay, and same request id with modified payload. Each must prove no unintended head advance and no candidate deletion.
- [ ] Preserve all existing working/review/publish/reopen/reference lifecycle tests. Run the promotion and lifecycle suites after the service implementation.

## Task 5: Wire ProjectGuard and public ingress without bypassing admission (red first)

**Files:**
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: `src/index-neutral.ts` only if exhaustive operation dispatch requires it
- Modify: `src/durable/project-guard-subrequest-resilient.ts` if its specialized request path has a second dispatch switch
- Modify: `test/project-guard-managed-document.spec.ts`
- Modify: `test/mutation-context-transport.spec.ts`

- [ ] Add a failing strict-mode test proving the public `/v1/documents` and internal ProjectGuard route decode the same `AdmissionEnvelope<ManagedDocumentRequest>` and call `verifyEffectAdmission` before `ManagedDocumentService.promoteReviewCandidate` receives a writable provider operation.
- [ ] Add the `review_candidate.promote` arm to `executeManagedDocument`. Do not introduce a separate mutable endpoint, do not invoke the service before `managedDocumentRequests.ensureIntent`, and do not create a document receipt merely because signed admission failed.
- [ ] Map candidate-evidence, stale-revision, destination-collision, and recovery ambiguity errors to stable `ManagedDocumentOperationReceipt` conflict/rejection codes. Retain the existing exact idempotency and durable request-journal flow.
- [ ] Test public authorization, ProjectGuard project binding, missing/expired/forged/cross-project context, normal strict admission, and exact replay. Check no candidate promotion passes when strict admission is enabled and `MUTATION_CONTEXT_SIGNING_KEY` is absent.
- [ ] Run: `"/Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ./node_modules/vitest/vitest.mjs run test/project-guard-managed-document.spec.ts test/mutation-context-transport.spec.ts test/review-candidate-promotion.spec.ts`.

## Task 6: Regression, static gates, and implementation record

**Files:**
- Create: `docs/superpowers/evidence/2026-09-09-compatible-review-candidate-promotion-qualification.md`
- Modify: no canonical Dropbox file and no rollout configuration

- [ ] Add a source-policy test or extend the existing static gate so the promotion modules do not import a Dropbox provider implementation, call raw provider HTTP, expose a write route outside ProjectGuard, or use a generic overwrite primitive for immutable evidence.
- [ ] Run the focused managed-document, review-candidate, ProjectGuard/admission, fallback-transport regression, convergence and rollback suites selected by `rg "review_candidate|managed document|mutation context|rollback|convergence" test`.
- [ ] Generate Worker types if the local type command requires them, run TypeScript with the configured Node runtime, then remove only the generated type artifact through the repository’s normal patch workflow if it is untracked.
- [ ] Run the full test suite, all repository static gates, the persistence high-risk gate, and `wrangler deploy --dry-run` against the exact final SHA. A dry run must terminate before upload/deployment.
- [ ] Record commands, exact SHA, counts and outputs in the evidence document only after successful observed results. Record failures honestly; do not mark a production, canary, PR merge, or PRJ-0003 gate complete.
- [ ] Commit the compatible implementation and its qualification evidence as coherent commits after tests are green. Keep the working tree clean before moving to fallback execution.

## Verification command shape

Use the configured Node runtime because `node`, `npm` and `npx` are not on this host PATH:

```bash
RUNTIME_NODE="/Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
"$RUNTIME_NODE" ./node_modules/vitest/vitest.mjs run test/review-candidate-promotion.spec.ts
"$RUNTIME_NODE" ./node_modules/typescript/bin/tsc --noEmit
"$RUNTIME_NODE" ./node_modules/wrangler/bin/wrangler.js deploy --dry-run
```

Expected final behavior: promotion remains unavailable without a valid current admission envelope; a valid, explicit acceptance creates one receipt-gated published managed document from unchanged committed REVIEW evidence; all competing, stale, malformed, or ambiguous states fail closed and retain the source candidate.
