# IMP-ARTIFACT001 Managed Document Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a crash-safe managed-document lifecycle and immutable version ledger so Project OS can safely coordinate human/AI edits across INPUTS, REFERENCES, WORKING, REVIEW, and DELIVERABLES without silent overwrite or user workflow complexity.

**Architecture:** Keep project-state projections separate from managed documents. Add Dropbox metadata/revision/CAS/change-feed primitives, an immutable document-version repository with repairable heads, lifecycle operations for work/reference documents, and an external-change reconciler driven by Dropbox cursors. Legacy `/v1/artifacts` remains compatible and gains version evidence.

**Tech Stack:** TypeScript, Cloudflare Workers/Durable Objects SQLite, Dropbox HTTP API, Zod, Vitest, Wrangler.

**Spec:** `docs/superpowers/specs/2026-08-24-imp-artifact001-managed-document-governance-design.md`

## Global Constraints

- Production continuity mode remains `stable`.
- Existing natural-language/chat workflow remains unchanged.
- No direct PC filesystem access.
- Existing `/v1/artifacts` requests and artifact routes remain compatible.
- Managed-document history is project-isolated and reconstructible from immutable Dropbox evidence.
- `DELIVERABLES` external edits never auto-publish.
- System projection edits never become canonical state implicitly.
- Conditional managed-document replacement uses Dropbox revision CAS, not blind overwrite.
- Arbitrary external/binary Dropbox files must be snapshot-capable without UTF-8 decoding.
- New reference taxonomy is project-specific; runtime uses `REFERENCES/UNCLASSIFIED` rather than guessing semantic categories.

---

### Task 1: Managed-document domain model and safe paths

**Files:**
- Create: `src/domain/managed-document.ts`
- Modify: `src/dropbox/layout.ts`
- Test: `test/managed-document.spec.ts`
- Test: `test/dropbox-paths.spec.ts`

**Interfaces:**
- Produces `ManagedDocumentZone`, `ManagedDocumentKind`, `DocumentVersionRecord`, `ManagedDocumentHead`, `ManagedDocumentRequest`, `ManagedDocumentReceipt`, parsers, deterministic `documentIdFor()` and `externalVersionIdFor()` helpers.
- Produces machine path helpers for document versions/heads/payloads/recovery and visible zone roots.

- [ ] Write RED tests that accept safe reference collection paths and lifecycle requests, reject traversal/reserved roots, validate immutable records/head pointer combinations, and prove deterministic IDs.
- [ ] Run `npx vitest run test/managed-document.spec.ts test/dropbox-paths.spec.ts` and confirm RED.
- [ ] Implement strict Zod schemas. Keep existing `ArtifactWriteRequest` unchanged in this task.
- [ ] Add visible paths `INPUTS`, `REFERENCES`, `WORKING`, `REVIEW`, `DELIVERABLES` and hidden machine paths under `.project-os/projects/<id>/documents/`.
- [ ] Run focused tests GREEN.
- [ ] Commit `feat: define managed document lifecycle model`.

### Task 2: Dropbox metadata, conditional write, server-side copy, and change cursor

**Files:**
- Modify: `src/dropbox/client.ts`
- Modify: `src/dropbox/resilient-transport.ts`
- Modify: `test/helpers/mock-dropbox.ts`
- Test: `test/dropbox-document-concurrency.spec.ts`
- Test: `test/resilient-dropbox-transport.spec.ts`

**Interfaces:**
- Produce `DropboxFileMetadata { id, path, rev, content_hash, size, server_modified? }`.
- Extend transport with `getMetadata(path)`, `uploadConditional(path, content, expectedRev)`, `copy(from,to)`, and cursor-aware `listFolderChanges(root,cursor?)`.
- `uploadConditional` must map to Dropbox `mode:{".tag":"update","update":"<rev>"}` with `strict_conflict:true` and return resulting metadata.

- [ ] Write RED tests for metadata extraction, successful CAS, rev mismatch conflict, strict add, server-side copy of binary-opaque content, initial recursive cursor, incremental continue, and reset error propagation.
- [ ] Run focused tests and confirm RED.
- [ ] Implement Dropbox API calls and metadata parsing without changing existing `upload/download` behavior.
- [ ] Extend resilient wrapper so transient metadata/copy/change-feed calls retry and permanent 409 CAS conflicts do not retry.
- [ ] Upgrade mock Dropbox to track per-file rev/content hash/size and a simple change journal/cursor.
- [ ] Run focused tests GREEN plus `test/dropbox-read-resilience.spec.ts`.
- [ ] Commit `feat: add Dropbox CAS and change metadata primitives`.

### Task 3: Immutable document ledger repository

**Files:**
- Create: `src/documents/repository.ts`
- Create: `src/documents/hash.ts`
- Test: `test/document-ledger.spec.ts`

**Interfaces:**
- `DocumentLedgerRepository` methods:
  - `readHead(projectId, documentId)`
  - `readVersion(projectId, documentId, versionId)`
  - `writeVersion(record)` immutable/safe-add
  - `writeHead(head)` only after referenced versions exist
  - `storeTextPayload(projectId, sha256, content)` content-addressed/idempotent
  - `snapshotProviderFile(projectId, documentId, versionId, sourcePath, metadata)` server-side immutable copy
  - `restoreHeadFromVersions(projectId, documentId)`
  - `quarantineExternalFile(...)`
- Head is repairable; immutable versions/payloads are durable evidence.

- [ ] RED: immutable version conflict with different content fails; same content replay is idempotent; head cannot reference missing version; SHA-256 text payload dedupes; provider snapshot uses copy and never decodes binary; head rebuild chooses the latest valid causal version rather than lexicographic filename.
- [ ] Implement repository using existing safe-add semantics/patterns but isolated from `ProjectRepository`.
- [ ] GREEN focused suite.
- [ ] Commit `feat: add immutable managed document ledger`.

### Task 4: Work-product lifecycle service

**Files:**
- Create: `src/documents/service.ts`
- Modify: `src/domain/artifact-write.ts`
- Modify: `src/dropbox/repository.ts`
- Test: `test/document-lifecycle.spec.ts`
- Extend: `test/artifact-repository.spec.ts`
- Extend: `test/artifact-routing.spec.ts`

**Interfaces:**
- `ManagedDocumentService` methods:
  - `writeWorking(request,state)`
  - `promoteToReview(request,state)`
  - `publish(request,state)`
  - `reopenPublished(request,state)`
  - `classifyReference(request,state)`
  - `legacyArtifactWrite(artifact,state)`
- Every write returns `ManagedDocumentReceipt` including `document_id`, `version_id`, stage, provider rev when known, status.
- Optional `expected_version_id` enforces logical stale-write protection.

- [ ] RED: create WORKING V1, update V2, stale expected version conflicts, same request replay idempotent.
- [ ] RED: promote V2 to REVIEW without publishing; edit review candidate; publish only current review; reopen published to WORKING without changing published pointer.
- [ ] RED: publication version evidence exists before published head advances.
- [ ] RED: legacy artifact create/replace still succeeds, route governance still applies, and direct governed `DELIVERABLES` writes create `source=legacy_artifact_api` published ledger evidence.
- [ ] Implement lifecycle with strict add/CAS. Never blind-overwrite managed collaborative files.
- [ ] Preserve existing `ArtifactWriteReceipt` fields; add optional managed-document metadata fields only so old callers remain compatible.
- [ ] GREEN focused suites.
- [ ] Commit `feat: add managed document lifecycle service`.

### Task 5: External edit and INPUTS reconciliation

**Files:**
- Create: `src/documents/reconciler.ts`
- Modify: `src/materialization/writer.ts`
- Test: `test/document-external-edits.spec.ts`
- Extend: `test/materialization-writer.spec.ts`

**Interfaces:**
- `ManagedDocumentReconciler.reconcileChanges(state, changes)` handles filtered Dropbox changes.
- `ManagedDocumentReconciler.bootstrap(state, entries, cursor)` records baseline provider metadata without misclassifying existing Project OS files as human edits.
- Projection writer receives an optional `onUnexpectedManagedContent` recovery hook before fail/repair.

- [ ] RED: external WORKING modification snapshots bytes and advances working version.
- [ ] RED: next AI update based on old version conflicts; update based on captured human version succeeds.
- [ ] RED: external REVIEW modification advances candidate only.
- [ ] RED: external REFERENCE modification becomes a new reference version.
- [ ] RED: INPUTS file moves to `REFERENCES/UNCLASSIFIED`, input becomes empty, version evidence records `input_ingest`.
- [ ] RED: duplicate input same fingerprint is idempotent.
- [ ] RED: external DELIVERABLE edit moves safely to free WORKING path then restores published bytes; published pointer unchanged.
- [ ] RED: if WORKING already contains a different draft, external DELIVERABLE edit is quarantined under hidden conflict evidence, published file restored, existing draft untouched.
- [ ] RED: external system projection edit is quarantined hidden then canonical content can be rematerialized; edited bytes are not lost.
- [ ] Implement via provider metadata and server-side copy/move. Do not download arbitrary binary content.
- [ ] GREEN focused suites.
- [ ] Commit `feat: reconcile human Dropbox edits safely`.

### Task 6: Durable change cursor and ProjectGuard/Worker routing

**Files:**
- Modify: `src/durable/project-guard.ts`
- Modify: `src/index.ts`
- Modify: `src/env.ts` only if a new bounded concurrency setting is required
- Test: `test/project-guard-document.spec.ts`
- Test: `test/document-change-reconcile.spec.ts`
- Extend: `test/index.spec.ts`

**Interfaces:**
- ProjectGuard endpoints:
  - `POST /document` for managed lifecycle requests
  - `GET /document-status?document_id=...`
  - `POST /reconcile-documents` for scheduled/webhook change processing
- SQLite stores only hot cursor/baseline metadata; immutable Dropbox document records remain recoverable truth.
- Worker public/admin route `POST /v1/documents` routes to bound ProjectGuard.

- [ ] RED: public managed request requires auth and routes project-isolated.
- [ ] RED: cursor baseline persists across Durable Object calls and incremental change processing only evaluates changed paths.
- [ ] RED: cursor reset triggers bounded baseline rebuild without turning all known managed files into human edits.
- [ ] RED: Dropbox webhook schedules document reconciliation in addition to inbox processing; scheduled maintenance reports document reconcile summary.
- [ ] RED: archived projects do not accept new working/reference mutation and do not resurrect active workspaces.
- [ ] Implement with bounded concurrency and compact structured logs.
- [ ] GREEN focused suites plus inbox/materialization regressions.
- [ ] Commit `feat: wire managed document reconciliation`.

### Task 7: Lazy adoption and compatibility bootstrap

**Files:**
- Create: `src/documents/bootstrap.ts`
- Test: `test/document-bootstrap.spec.ts`
- Extend: `test/project-guard-artifact.spec.ts`

**Interfaces:**
- `bootstrapExistingManagedPath(state, visiblePath, metadata, inferredStage)` creates a baseline immutable version/head only when needed.
- Existing `DELIVERABLES` file adopts as initial published version; existing `WORKING/REVIEW/REFERENCES` adopts to corresponding stage.

- [ ] RED: pre-ledger deliverable becomes published baseline without rewriting its bytes.
- [ ] RED: pre-ledger working doc can receive a CAS update after bootstrap.
- [ ] RED: legacy artifact exact replay after bootstrap does not create duplicate version.
- [ ] Implement lazy bootstrap, never bulk rewrite existing projects.
- [ ] GREEN.
- [ ] Commit `feat: bootstrap existing documents into version ledger`.

### Task 8: Full acceptance/fault matrix

**Files:**
- Create: `test/managed-document-acceptance.spec.ts`
- Extend: `test/fault-injection-harness.spec.ts` if new endpoint matching is needed
- Extend: `test/write-coordination-stress.spec.ts`

**Interfaces:** none new; this is package acceptance.

- [ ] Add end-to-end acceptance test covering a section-by-section WORKING document, human edit, stale AI conflict, review, publish, reopen, second publish, and historical version retrieval.
- [ ] Add fault after provider CAS but before version/head/receipt; exact replay must recover same logical version.
- [ ] Add provider-rev race between observation and upload; human bytes survive and no published pointer advances incorrectly.
- [ ] Add arbitrary binary-opaque INPUTS/REFERENCE snapshot test proving no UTF-8 decode path is used.
- [ ] Add 50 mixed document/project operations stress test with no cross-project writes or duplicate versions.
- [ ] Run `npm run check` and require all suites GREEN.
- [ ] Run `npx wrangler deploy --dry-run` GREEN.
- [ ] Commit `test: prove managed document governance acceptance`.

### Task 9: Operational documentation, PR, production proof

**Files:**
- Create: `docs/managed-documents.md`
- Modify: `docs/project-os-sop.md`
- Modify: `docs/project-os-improvement-roadmap.md`
- Modify: `docs/deployment.md` only if new operational recovery/status steps are needed

**Interfaces:** document the exact runtime contract and recovery procedure.

- [ ] Document visible zone semantics in concise user/operator language.
- [ ] Document hidden ledger paths, CAS rules, cursor reset recovery, external-edit behavior, and legacy compatibility.
- [ ] Mark `IMP-MATERIAL001` complete and `IMP-ARTIFACT001` active/implemented pending production proof in roadmap documentation.
- [ ] Open PR `IMP-ARTIFACT001 — managed document governance`.
- [ ] Verify exact PR head CI: `npm run check`, all tests, Wrangler dry-run.
- [ ] Review diff for accidental secrets, direct-PC assumptions, unsafe blind overwrites, and path traversal.
- [ ] Merge exact green SHA.
- [ ] Verify production deployment exact merge SHA: credentials, project verification, Worker deploy, `/health`, deployment status.
- [ ] Perform read-only production smoke checks that continuity remains `stable` and no project business revision changes merely from document reconciliation.
- [ ] Only after production proof, prepare canonical Project OS evidence/task closure as a separate Dropbox mutation plan requiring fresh explicit confirmation.
