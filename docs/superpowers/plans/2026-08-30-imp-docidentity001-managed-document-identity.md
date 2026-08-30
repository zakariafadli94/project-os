# IMP-DOCIDENTITY001 — Managed Document Identity Visibility and Stable Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Managed Document identity visible and trustworthy in human Markdown, preserve one `document_id` across lifecycle and governed rename, reserve historical logical paths, and recover interrupted renames without mass rewriting existing documents.

**Architecture:** Add a pure Managed Markdown identity normalizer, durable per-project path claims, and a staged `reader -> stamping -> rename -> steady` runtime policy. Keep existing deterministic `project_id + first logical_path` allocation only for initial work-product creation; after allocation, resolve current/historical paths through durable claims and perform rename through an immutable provider-neutral intent plus bounded temporary reservation, append-only stage steps, deterministic rename versions, and a terminal record. Reconciliation becomes identity-aware and consults active rename evidence before MutationGate/bootstrap/reconciliation so governed provider moves cannot be mistaken for external writes.

**Tech Stack:** TypeScript 5.9, Zod 4.4, Vitest 4.1, Cloudflare Workers/Durable Objects, provider-neutral persistence runtime with Dropbox production provider, existing ProjectGuard request ledger and Managed Document V1/V2 codecs.

**Spec:** `docs/superpowers/specs/2026-08-30-imp-docidentity001-managed-document-identity-design.md`

## Global Constraints

- Scope is work products only: `WORKING`, `REVIEW`, `DELIVERABLES`. Reference-document identity is unchanged.
- Existing `document_id` values never change. New work products keep current deterministic initial allocation from `project_id + first logical_path`; rename never recalculates identity.
- `logical_path` is mutable only through governed `document.rename`.
- Human Markdown controlled fields are exactly `project_id` and `document_id`; `version_id` is not injected.
- Controlled identity mismatch, duplicate controlled keys, ambiguous controlled scalar syntax, stale expected versions, conflicting path ownership, provider precondition mismatch, or unverifiable partial rename fail closed.
- The request `content_sha256` validates caller-submitted bytes. `DocumentVersionRecord.content_sha256` records final normalized bytes actually persisted and written.
- Permanent path claims are project-scoped and immutable once committed. A historical alias can never be assigned to a different document.
- A clean rename failure before provider effect must not permanently claim the attempted destination.
- Once any provider effect occurs, recovery converges the same rename request; it must not silently release the destination or allocate a second identity.
- Governed rename creates a deterministic new version for each active representation it moves, even when payload bytes are reused.
- External/manual provider rename never changes `head.logical_path` automatically.
- Legacy unstamped documents remain readable. Identity stamping is opportunistic on governed text-producing writes and governed rename; no bulk rewrite and no write-on-read.
- Existing V1/V2 Managed Document records remain readable; new provider-bearing rename evidence uses provider-neutral schema 2.0; path claims may use independent schema 1.0.
- MutationGate remains `enforce`; active governed rename evidence must be recognized before strict-zone external mutation classification.
- GitHub Actions remain GitHub-hosted only. No self-hosted runner may be introduced.
- Production rollout uses a brand-new isolated probe project and exact-commit evidence; PRJ-0003 is not a canary.
- `src/render/frontmatter.ts` is not reused for collaborative Managed Documents.

---

## File map

New focused units:

- `src/documents/identity-frontmatter.ts` — inspect and minimally normalize controlled Markdown identity without broad YAML reserialization.
- `src/documents/path-key.ts` — provider-equivalent logical-path normalization/key derivation for work-product claims.
- `src/domain/managed-document-identity.ts` — strict path-claim and rename-record domain schemas/types.
- `src/schema/managed-document-rename.ts` — strict provider-neutral schema-2.0 rename intent/stage evidence codecs.
- `src/documents/path-claim-repository.ts` — immutable permanent claim lookup/write and current-path resolution.
- `src/documents/rename-repository.ts` — immutable rename intent/step/terminal records plus bounded active marker and destination reservation.
- `src/documents/rename-service.ts` — preflight, deterministic execution, recovery, version creation, head transition, and internal-change recognition.
- `src/documents/identity-rollout.ts` — staged runtime policy and per-project canary resolution.

Existing integration points:

- `src/domain/managed-document-request.ts` — add `document.rename` request with exact active-pointer snapshot.
- `src/domain/managed-document.ts` — reuse path/document/version validators and expose deterministic rename-version helper only if it belongs in the domain layer.
- `src/documents/service.ts` — identity stamping, canonical hash ordering, path-claim enforcement, lifecycle claim adoption, and rename delegation.
- `src/documents/repository.ts` — payload/head/version helpers only; do not turn this already-large file into the rename state machine.
- `src/documents/reconciler.ts` — stamped/missing/mismatched identity behavior and claim-based path resolution.
- `src/documents/bootstrap.ts` — claim-first work-product resolution with legacy deterministic fallback.
- `src/documents/change-coordinator.ts` — recover/partition active governed rename changes before MutationGate/bootstrap/reconciliation.
- `src/documents/legacy-artifact.ts` — same Markdown identity normalization and canonical hash contract for published work products.
- `src/persistence/layout.ts` — bounded paths for path claims and rename records.
- `src/durable/project-guard-neutral.ts` — request routing, stage gating, retry semantics, and service wiring.
- `src/durable/project-guard.ts` — resolve document-identity rollout stage for the bound project/canary.
- `src/env.ts`, `wrangler.jsonc` — safe rollout configuration.
- `package.json` — add rename fault suite to `test:persistence-high-risk` once the suite exists.
- `docs/managed-documents.md` — update only after runtime behavior is implemented and validated.

Primary tests:

- new `test/managed-document-identity-frontmatter.spec.ts`
- new `test/managed-document-path-claims.spec.ts`
- new `test/managed-document-rename.spec.ts`
- new `test/managed-document-rename-faults.spec.ts`
- modify `test/managed-document-request.spec.ts`
- modify `test/managed-document.spec.ts`
- modify `test/document-lifecycle.spec.ts`
- modify `test/document-external-edits.spec.ts`
- modify `test/document-head-recovery.spec.ts`
- modify `test/document-bootstrap.spec.ts`
- modify `test/document-change-coordinator.spec.ts`
- modify `test/legacy-artifact-managed.spec.ts`
- modify `test/project-guard-document.spec.ts`
- modify `test/managed-document-acceptance.spec.ts`
- modify provider/path tests where Unicode/case path equivalence belongs.

---

### Task 1: Add a pure controlled-frontmatter normalizer

**Files:**
- Create: `src/documents/identity-frontmatter.ts`
- Create: `test/managed-document-identity-frontmatter.spec.ts`

**Interfaces:**
- Produces: `type ManagedMarkdownIdentityState = "legacy_unstamped" | "stamped"`
- Produces: `interface ManagedMarkdownIdentity { project_id: string; document_id: string }`
- Produces: `inspectManagedMarkdownIdentity(content: string): { state: ManagedMarkdownIdentityState; project_id?: string; document_id?: string }`
- Produces: `normalizeManagedMarkdownIdentity(content: string, expected: ManagedMarkdownIdentity): Promise<{ content: string; content_sha256: string; state: "stamped" }>`
- Produces: `ManagedDocumentIdentityError` with `code` exactly `DOCUMENT_IDENTITY_MISMATCH` or `DOCUMENT_IDENTITY_AMBIGUOUS`.

- [ ] **Step 1: Write exact failing tests for a body with no frontmatter.**

```ts
const normalized = await normalizeManagedMarkdownIdentity("# Plan\n", {
  project_id: "PRJ-0002",
  document_id: "DOC-AAAAAAAAAAAAAAAAAAAAAAAA"
});
expect(normalized.content).toBe(
  "---\nproject_id: PRJ-0002\ndocument_id: DOC-AAAAAAAAAAAAAAAAAAAAAAAA\n---\n\n# Plan\n"
);
```

- [ ] **Step 2: Add failing tests proving unrelated frontmatter bytes/comments/order are preserved and only missing controlled lines are inserted.** Use an input containing `task_id`, a YAML comment, and quoted text; assert the body and unrelated lines are byte-identical.
- [ ] **Step 3: Add failing tests that accept exact plain or JSON-double-quoted controlled scalar values and reject wrong values, duplicate top-level keys, indented/nested controlled keys used as substitutes, aliases/tags, block scalars, and unterminated frontmatter.**
- [ ] **Step 4: Implement a line-oriented leading-frontmatter scanner.** Only top-level `project_id:` / `document_id:` lines are controlled. Do not invoke the generated-note renderer and do not parse/re-emit arbitrary YAML.
- [ ] **Step 5: Compute `content_sha256` from the final returned bytes with existing `sha256Text()`.**
- [ ] **Step 6: Run `npx vitest run test/managed-document-identity-frontmatter.spec.ts` and `npm run typecheck`.**
- [ ] **Step 7: Commit `feat(documents): normalize managed markdown identity`.**

### Task 2: Add provider-equivalent path keys and immutable path claims

**Files:**
- Create: `src/documents/path-key.ts`
- Create: `src/domain/managed-document-identity.ts`
- Create: `src/documents/path-claim-repository.ts`
- Create: `test/managed-document-path-claims.spec.ts`
- Modify: `src/persistence/layout.ts`

**Interfaces:**
- Produces: `normalizeManagedLogicalPathKey(logicalPath: string): string`
- Produces: `managedLogicalPathKey(logicalPath: string): Promise<string>` returning lowercase 64-hex SHA-256 of normalized key material.
- Produces: `ManagedDocumentPathClaim { schema_version:"1.0"; project_id; normalized_logical_path; first_seen_logical_path; document_id; claimed_at; source:"initial_create"|"governed_rename"|"legacy_adoption" }`
- Produces: `PathClaimRepository.read(projectId, logicalPath)` / `claim(record)` / `resolveWorkProductDocumentId(projectId, logicalPath)`.
- Produces layout: `.project-os/projects/<PRJ>/documents/path-claims/<SHA256>.json`.

- [ ] **Step 1: Write failing normalization vectors proving full Unicode NFC normalization plus Unicode case folding through JavaScript lowercase semantics, not ASCII-only lowercasing.** Include composed/decomposed `é` and `Report.md` / `report.md` equivalence.
- [ ] **Step 2: Add claim tests: first claim succeeds; same document retry is idempotent; different document fails; same logical path in another project succeeds independently.**
- [ ] **Step 3: Add a test that an existing historical alias claimed by `DOC-A...` causes `resolveWorkProductDocumentId()` to return that ID instead of recomputing `documentIdFor(projectId, logicalPath)`.**
- [ ] **Step 4: Implement the strict record parser and deterministic layout helper.** `claim()` uses `createText`; on provider conflict it rereads and accepts only byte/semantic equivalence for the same document.
- [ ] **Step 5: Implement legacy fallback: no claim means `documentIdFor(projectId, logicalPath)`; claim presence is authoritative.**
- [ ] **Step 6: Run `npx vitest run test/managed-document-path-claims.spec.ts test/managed-document.spec.ts test/workspace-layout.spec.ts`.**
- [ ] **Step 7: Commit `feat(documents): add durable logical path claims`.**

### Task 3: Add reader-first rollout policy and project-scoped canary resolution

**Files:**
- Create: `src/documents/identity-rollout.ts`
- Create: `test/managed-document-identity-rollout.spec.ts`
- Modify: `src/env.ts`
- Modify: `src/durable/project-guard.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Produces: `type DocumentIdentityStage = "reader" | "stamping" | "rename" | "steady"`
- Produces: `parseDocumentIdentityStage(value?: string): DocumentIdentityStage`, default `reader`.
- Produces: `documentIdentityStageAtLeast(actual, required): boolean` with ordering `reader < stamping < rename < steady`.
- Produces: `resolveDocumentIdentityStageForProject(stage, canaryProjectId, boundProjectId)`; when a canary is set, only that project receives the configured stage and all other projects receive `reader`.
- Adds env names: `PROJECT_OS_DOCUMENT_IDENTITY_STAGE`, `PROJECT_OS_DOCUMENT_IDENTITY_CANARY_PROJECT_ID`.

- [ ] **Step 1: Write failing stage-order/default/invalid-stage tests and exact canary resolution tests.**
- [ ] **Step 2: Wire the bound `ProjectGuard` wrapper to resolve the effective stage once, then pass only the effective stage into the neutral guard.** MutationGate subclass inherits this effective policy.
- [ ] **Step 3: Thread the effective stage into Managed Document services/coordinator without changing behavior yet.**
- [ ] **Step 4: Set production `wrangler.jsonc` to `PROJECT_OS_DOCUMENT_IDENTITY_STAGE: "reader"` with no canary ID.** This is R0-safe merged code: readers may understand new evidence but no identity stamping or rename write is enabled.
- [ ] **Step 5: Run `npx vitest run test/managed-document-identity-rollout.spec.ts test/project-guard-document.spec.ts` and `npm run check`.**
- [ ] **Step 6: Commit `feat(documents): add identity rollout stages`.**

### Task 4: Make bootstrap and reconciliation identity-aware in R0 without changing writes

**Files:**
- Modify: `src/documents/bootstrap.ts`
- Modify: `src/documents/reconciler.ts`
- Modify: `src/documents/repository.ts`
- Modify: `test/document-bootstrap.spec.ts`
- Modify: `test/document-external-edits.spec.ts`
- Modify: `test/document-head-recovery.spec.ts`
- Modify: `test/managed-document-acceptance.spec.ts`

**Interfaces:**
- Consumes: `inspectManagedMarkdownIdentity()`, `PathClaimRepository.resolveWorkProductDocumentId()`.
- Produces repository helper: `readVersionPayloadText(record): Promise<string | null>` for governed text evidence when the immutable payload is textual.
- Produces reconciler helper semantics: stamped governed version requires matching visible controlled identity; legacy governed version tolerates missing controlled fields.

- [ ] **Step 1: Add failing bootstrap tests proving a permanent path claim resolves a renamed work product to its original `document_id`; no-claim legacy bootstrap retains current deterministic behavior.**
- [ ] **Step 2: Add failing reconciliation tests for correct stamped identity, forged `document_id`, forged `project_id`, and removal of identity from a version whose canonical payload is stamped.**
- [ ] **Step 3: Add a failing manual-rename test: a visible file under a different logical path contains a known stamped `document_id`; reconciliation records conflict/evidence but does not mutate `head.logical_path` or create a claim.**
- [ ] **Step 4: Refactor work-product path lookup in bootstrap/reconciler from direct `documentIdFor(projectId, logicalPath)` to claim-first resolution.** Reference logic remains unchanged.
- [ ] **Step 5: Implement stamped-state authority by inspecting the current governed immutable payload; absence remains legacy only when that governed payload itself is unstamped.**
- [ ] **Step 6: For identity mismatch/manual move, snapshot provider evidence under a deterministic external version when possible, mark `reconciliation_status: "conflict"`, and preserve/restore the governed current representation under existing recovery rules. Never use the external frontmatter ID to rebind the head.**
- [ ] **Step 7: Run `npx vitest run test/document-bootstrap.spec.ts test/document-external-edits.spec.ts test/document-head-recovery.spec.ts test/managed-document-acceptance.spec.ts`.**
- [ ] **Step 8: Commit `feat(documents): add reader-first identity reconciliation`.**

### Task 5: Enable R1 identity stamping, canonical hashing, and opportunistic current-path claims

**Files:**
- Modify: `src/documents/service.ts`
- Modify: `src/documents/repository.ts`
- Modify: `test/document-lifecycle.spec.ts`
- Modify: `test/managed-document-faults.spec.ts`
- Modify: `test/dropbox-document-concurrency.spec.ts`

**Interfaces:**
- Consumes: `normalizeManagedMarkdownIdentity()`, `PathClaimRepository` and effective `DocumentIdentityStage`.
- Produces service helper: `prepareGovernedMarkdown(projectId, documentId, submittedContent, submittedSha256)` that first validates submitted hash, then normalizes when stage >= `stamping`, and returns final bytes/final SHA.
- Produces service helper: `ensureCurrentPathClaim(headOrIdentity, source)` invoked on successful/replayed governed mutations when stage >= `stamping`.

- [ ] **Step 1: Add a failing WORKING test proving caller hash validates the original content while the version payload/hash and visible file match the stamped final bytes.**

```ts
const submitted = "---\ntask_id: TASK-X\n---\n# Body\n";
const receipt = await service.writeWorking({
  request_id: "DOCREQ-STAMP-0001",
  project_id: state.project_id,
  logical_path: "plan.md",
  content: submitted,
  content_sha256: await sha256Text(submitted),
  created_at: "2026-08-30T00:00:00Z"
}, state);
const visible = await runtime.objects.readText(workspaceManagedDocumentPath(state.project_id, state.slug, "working", "plan.md"));
expect(visible).toContain(`document_id: ${receipt.document_id}`);
```

- [ ] **Step 2: Add failing lifecycle tests: stamped WORKING promotes/publishes/reopens without ID change; `review.write` preserves task metadata and the same ID; V2 versions change while logical identity does not.**
- [ ] **Step 3: Add failure tests for caller-supplied wrong controlled IDs and historical-alias `working.write`; return `DOCUMENT_IDENTITY_MISMATCH` / a dedicated `HISTORICAL_LOGICAL_PATH` conflict before provider mutation.**
- [ ] **Step 4: Refactor write paths so `storeTextPayload()` receives final canonical SHA/content. Do not overwrite the request's submitted hash semantics.**
- [ ] **Step 5: Ensure replay paths also repair a missing current-path claim idempotently before returning a committed receipt.** A crash after head/version but before claim must converge on retry.
- [ ] **Step 6: Establish a permanent claim for the current path on every successful governed work-product mutation at stage >= `stamping`, using `initial_create` for first creation and `legacy_adoption` for existing unclaimed heads.**
- [ ] **Step 7: Keep pure move-only lifecycle transitions from rewriting legacy unstamped bytes solely to stamp identity. If publication performs an actual text replacement, normalize the bytes before that replacement.**
- [ ] **Step 8: Run the focused lifecycle/fault/concurrency suites and `npm run check`.**
- [ ] **Step 9: Commit `feat(documents): stamp governed work product identity`.**

### Task 6: Apply the same identity contract to legacy Artifact API Markdown publications

**Files:**
- Modify: `src/documents/legacy-artifact.ts`
- Modify: `src/documents/legacy-artifact-provenance.ts` only if provenance helpers need final-content evidence
- Modify: `test/legacy-artifact-managed.spec.ts`
- Modify: `test/project-guard-artifact.spec.ts` only for end-to-end receipt regression

**Interfaces:**
- Consumes: identity normalizer, path claims, effective stage.
- Preserves: artifact request `content_sha256` means caller-submitted bytes; Managed Document version `content_sha256` means final normalized bytes.

- [ ] **Step 1: Add a failing new-published-`.md` test proving visible frontmatter `document_id` equals the head and final payload hash equals visible bytes.**
- [ ] **Step 2: Add replacement test proving the same logical published document retains one `document_id` and a new version while preserving unrelated frontmatter.**
- [ ] **Step 3: Add failure test proving a caller-supplied conflicting `document_id` cannot override ledger identity.**
- [ ] **Step 4: Refactor published Markdown flow to determine the work-product `document_id` before payload storage, normalize final bytes, store final canonical payload, then write provider content.**
- [ ] **Step 5: Keep non-`.md` artifact behavior byte-for-byte unchanged and keep reference routes out of scope.**
- [ ] **Step 6: Ensure the current path claim is established after successful managed publication/replay.**
- [ ] **Step 7: Run `npx vitest run test/legacy-artifact-managed.spec.ts test/project-guard-artifact.spec.ts`.**
- [ ] **Step 8: Commit `feat(documents): stamp legacy managed markdown artifacts`.**

### Task 7: Add the governed rename request contract and stage gate

**Files:**
- Modify: `src/domain/managed-document-request.ts`
- Create or modify: `src/domain/managed-document-identity.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: `test/managed-document-request.spec.ts`
- Modify: `test/project-guard-document.spec.ts`

**Interfaces:**
- Adds exact request:

```ts
{
  operation: "document.rename";
  request_id: string;
  project_id: string;
  document_id: string;
  new_logical_path: string;
  expected_versions: {
    working?: string;
    review?: string;
    published?: string;
  };
  created_at: string;
}
```

- Produces: `ActiveWorkProductVersions` with exact optional keys `working`, `review`, `published`.
- Produces: `renameVersionIdFor(requestId, stage: "working"|"review"|"published"): Promise<string>` using SHA-256 of `${requestId}\nrename:${stage}` and `VER-REQ-<24 uppercase hex>`.

- [ ] **Step 1: Add parser tests for valid rename, invalid path, malformed IDs, extra unknown expected-version keys, and malformed version IDs.**
- [ ] **Step 2: Add deterministic rename-version vectors for all three stages and prove retries return identical IDs.**
- [ ] **Step 3: Add ProjectGuard test: at `reader` or `stamping`, `document.rename` returns a durable rejected receipt with `DOCUMENT_RENAME_DISABLED` and performs no provider mutation.**
- [ ] **Step 4: Add exact expected-pointer helper comparing the supplied set to the head set, including absence: omitted `published` is stale when the head has one, and supplied `review` is stale when the head does not.**
- [ ] **Step 5: Wire the switch case to a rename service interface but keep execution disabled until stage >= `rename`.**
- [ ] **Step 6: Run `npx vitest run test/managed-document-request.spec.ts test/project-guard-document.spec.ts`.**
- [ ] **Step 7: Commit `feat(documents): add governed rename request contract`.**

### Task 8: Add durable rename intent, reservation, step and terminal repository

**Files:**
- Create: `src/schema/managed-document-rename.ts`
- Create: `src/documents/rename-repository.ts`
- Create: `test/managed-document-rename-repository.spec.ts`
- Modify: `src/persistence/layout.ts`
- Consume existing: `src/schema/provider-evidence.ts`

**Interfaces:**
- Produces provider-neutral `ManagedDocumentRenameIntentV2` with `schema_version:"2.0"`, immutable from/to paths, exact expected pointers, and per-stage frozen `ProviderObservation`.
- Produces immutable `ManagedDocumentRenameStepV2` per stage, containing deterministic new version ID and destination provider evidence.
- Produces immutable terminal record `{ schema_version:"1.0"; request_id; project_id; document_id; status:"committed"|"aborted"; completed_at; code? }`.
- Produces bounded active marker `.project-os/projects/<PRJ>/documents/renames/active/<DOCREQ>.json`.
- Produces bounded destination reservation head `.project-os/projects/<PRJ>/documents/renames/reservations/<PATH_SHA>.json` containing the current reserving request/document; a terminal intent makes an old reservation inactive and replaceable.
- Produces intent/step/terminal paths under `.project-os/projects/<PRJ>/documents/renames/intents/<DOCREQ>/...`.

- [ ] **Step 1: Write strict codec tests proving rename intent is schema 2.0 and every active stage carries complete provider-neutral evidence; partial provider evidence fails closed.**
- [ ] **Step 2: Add reservation tests: first live reservation succeeds, same request is idempotent, another live request/document is blocked, aborted/committed old reservation may be replaced only after terminal proof.**
- [ ] **Step 3: Add active-index tests proving `listActiveIntents(projectId)` lists only active markers, tolerates a terminal intent left with stale marker, and cleans such stale temporary indexes without altering immutable intent/history.**
- [ ] **Step 4: Implement immutable create/read helpers with conflict-equivalence checks. Keep permanent path claims in `PathClaimRepository`, not in rename repository.**
- [ ] **Step 5: Run `npx vitest run test/managed-document-rename-repository.spec.ts test/schema/provider-evidence.spec.ts`.**
- [ ] **Step 6: Commit `feat(documents): add durable rename journal`.**

### Task 9: Implement deterministic crash-safe rename execution and recovery

**Files:**
- Create: `src/documents/rename-service.ts`
- Modify: `src/documents/service.ts`
- Modify: `src/documents/repository.ts` only for narrowly-scoped helper reuse
- Create: `test/managed-document-rename.spec.ts`
- Modify: `test/document-head-recovery.spec.ts`
- Modify: `test/dropbox-document-concurrency.spec.ts`

**Interfaces:**
- Produces: `rename(request, state): Promise<ManagedDocumentReceipt>`.
- Produces: `recoverActive(state): Promise<{ recovered:number; aborted:number }>`.
- Produces: `isInternalRenameChange(state, change): Promise<boolean>` for exact live intent/step evidence.
- Consumes: `PathClaimRepository`, `ManagedDocumentRenameRepository`, identity normalizer, runtime provider preconditions, deterministic rename version IDs.

- [ ] **Step 1: Add failing preflight tests for project/status binding, stale exact pointer set, path claim owned by another document, live reservation owned by another request, occupied destination provider path, and provider revision mismatch. Assert no intent/reservation/provider effect for failures discovered before journal preparation.**
- [ ] **Step 2: Add WORKING-only, published-only, published+reopened-WORKING, and published+REVIEW rename tests. Assert every active representation moves to the same new logical path and gets its own deterministic rename version.**
- [ ] **Step 3: Preserve single-tip causal recovery by linearizing rename versions.** For a published+working/review head, use the pre-rename active draft/review tip as the causal parent of the rename-published version, then use rename-published as the parent of the rename-working/review version. For published-only or draft-only heads, the rename version points to that current stage. Add recovery tests proving `restoreHeadFromVersions()` reconstructs the same published plus working/review pointers and new `logical_path`.
- [ ] **Step 4: Implement preflight order exactly: load head -> exact pointer check -> validate/normalize destination -> permanent claim conflict check -> live reservation conflict check -> verify every active provider observation -> persist immutable intent -> write active marker/reservation -> begin provider effects.**
- [ ] **Step 5: For each active stage in deterministic order `published`, then `working`, then `review` when present, detect already-completed source/destination state before moving.** Because working and review are mutually exclusive in a valid head, at most two active work-product stage representations move in normal reopened/review cases.
- [ ] **Step 6: For already-stamped Markdown, move provider object, capture destination evidence, reuse existing immutable text payload, and write the deterministic rename version. For legacy unstamped Markdown, move, read destination text, normalize identity, conditional-write stamped bytes against the moved revision, store a new canonical text payload/hash, then write the deterministic rename version.**
- [ ] **Step 7: Persist an immutable stage step only after provider destination evidence and version record are durable. Retry checks step/version/evidence before issuing another provider mutation.**
- [ ] **Step 8: After all active stages: claim the destination permanently with source `governed_rename`; update the head with the same `document_id`, new `logical_path`, renamed active pointers and provider observations; write terminal committed; clean active marker/reservation index.** A crash after permanent claim but before head must resume because the live intent owns that claim/document.
- [ ] **Step 9: Implement pre-provider abort only when no provider step has occurred. Write terminal `aborted`, clean temporary indexes, and do not create a permanent claim. Once any stage provider effect exists, propagate a retryable/non-terminal error without writing a terminal ProjectGuard document receipt so the same request ID can resume.**
- [ ] **Step 10: Add `A.md -> B.md -> A.md` test proving the same document may explicitly return to its historical alias while a second document can never use either claim.**
- [ ] **Step 11: Run `npx vitest run test/managed-document-rename.spec.ts test/document-head-recovery.spec.ts test/dropbox-document-concurrency.spec.ts` and `npm run typecheck`.**
- [ ] **Step 12: Commit `feat(documents): implement crash safe governed rename`.**

### Task 10: Recover active renames before MutationGate and reconcile external changes correctly

**Files:**
- Modify: `src/documents/change-coordinator.ts`
- Modify: `src/documents/reconciler.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: `test/document-change-coordinator.spec.ts`
- Modify: `test/document-external-edits.spec.ts`
- Modify: `test/mutation-gate-acceptance.spec.ts` or the smallest existing MutationGate suite that exercises final-zone change classification

**Interfaces:**
- `ManagedDocumentChangeCoordinator` consumes the effective identity stage and rename service/repository.
- Produces: recovery-before-classification ordering.
- Produces: partition `{ internalRenameChanges, externalChanges }` where only changes proven by a live governed rename intent/step are filtered from external MutationGate/bootstrap/reconciliation input.

- [ ] **Step 1: Add a failing strict-zone test where a governed rename moves `DELIVERABLES/A.md` to `DELIVERABLES/B.md`; the Dropbox change feed contains source deletion + destination appearance. Assert MutationGate creates no external mutation candidate for the governed destination.**
- [ ] **Step 2: Add a neighboring negative test: same destination appearance without matching live rename intent/evidence still reaches MutationGate and remains subject to `enforce`.**
- [ ] **Step 3: At start of reconciliation after obtaining the provider page but before MutationGate classification, call `recoverActive(state)` for stage >= `rename`.**
- [ ] **Step 4: Partition only exact intent-related provider changes using frozen source/destination paths and step/provider evidence. Pass all other entries unchanged to MutationGate, baseline bootstrap and reconciler.**
- [ ] **Step 5: Ensure cursor advancement still occurs after governed rename recovery and external processing; internal filtered changes count as ignored/internal in summary, not captured external mutations.**
- [ ] **Step 6: Add manual rename to historical alias test proving no live intent means conflict and no automatic logical-path update.**
- [ ] **Step 7: Run `npx vitest run test/document-change-coordinator.spec.ts test/document-external-edits.spec.ts test/mutation-gate-acceptance.spec.ts`.**
- [ ] **Step 8: Commit `feat(documents): reconcile governed rename effects before mutation gate`.**

### Task 11: Prove crash convergence at every rename boundary and promote the suite to high-risk CI

**Files:**
- Create: `test/managed-document-rename-faults.spec.ts`
- Modify: `test/helpers/persistence-runtime.ts` or existing fault wrapper only if a reusable operation hook is missing
- Modify: `package.json`
- Reuse patterns from: `test/managed-document-faults.spec.ts`, `test/mutation-gate-faults.spec.ts`, `test/fault-injection-harness.spec.ts`

**Interfaces:**
- Test fault labels exactly: `after_intent`, `after_first_provider_move`, `after_destination_evidence`, `after_first_rename_version`, `after_all_provider_moves`, `after_path_claim`, `after_head_update`.

- [ ] **Step 1: Build one deterministic fixture with a published+reopened-WORKING document so recovery must preserve two active representations and one stable identity.**
- [ ] **Step 2: For each fault label, inject one crash, recreate the service/runtime facade without relying on in-memory state, retry/recover the same request, and assert convergence to one `document_id`, one current `logical_path`, one published pointer, one working pointer, deterministic rename version IDs, one permanent destination claim, and no duplicate provider effects.**
- [ ] **Step 3: Add a pre-provider abort case where destination becomes invalid/occupied before any move; assert terminal aborted, temporary reservation inactive, no destination permanent claim, and another valid request can subsequently use that path.**
- [ ] **Step 4: Add crash-after-path-claim-before-head test proving the permanent claim does not strand the operation: the same live intent resumes and finalizes head/terminal.**
- [ ] **Step 5: Add crash-after-head-before-terminal test proving recovery writes terminal without creating second versions/provider moves.**
- [ ] **Step 6: Add `test/managed-document-rename-faults.spec.ts` to `test:persistence-high-risk`.**
- [ ] **Step 7: Run `npm run test:persistence-high-risk`, `npm run check`, and `npx wrangler deploy --dry-run`.**
- [ ] **Step 8: Commit `test(documents): prove rename crash convergence`.**

### Task 12: Document runtime contract and prepare exact R0/R1/R2/R3 rollout commits

**Files:**
- Modify: `docs/managed-documents.md`
- Create: `docs/imp-docidentity001-rollout.md`
- Modify: `wrangler.jsonc` in separate rollout commits after the implementation PR is green
- Modify deployment tests only if configuration parsing needs an explicit guard.

**Interfaces:**
- R0 global: `PROJECT_OS_DOCUMENT_IDENTITY_STAGE=reader`, no canary.
- R1 canary: stage `stamping`, canary = newly allocated isolated probe project.
- R1 global after proof: stage `stamping`, canary removed.
- R2 canary: stage `rename`, same new isolated probe project.
- R2 global after proof: stage `rename`, canary removed.
- R3 global steady state: stage `steady`, canary removed.

- [ ] **Step 1: Update `docs/managed-documents.md` with controlled frontmatter contract, submitted-vs-canonical hash semantics, path claims, historical aliases, `document.rename`, exact expected-pointer concurrency, external rename behavior, and recovery semantics.**
- [ ] **Step 2: Write `docs/imp-docidentity001-rollout.md` with exact gate order, required CI/deploy SHA checks, health endpoint check, probe steps, non-regression reads, and stop conditions. Explicitly state GitHub-hosted-only and no bulk rewrite.**
- [ ] **Step 3: Run `npm run check`, `npm run test:persistence-high-risk`, and `npx wrangler deploy --dry-run`; record the exact green implementation head in the PR.**
- [ ] **Step 4: Merge implementation code only with production config still at R0 `reader`.**
- [ ] **Step 5: R0 production gate: exact-commit GitHub-hosted deploy, `/health`, read-only reconciliation/non-regression on existing projects. Do not create the probe until R0 is green.**
- [ ] **Step 6: Create a brand-new isolated Project OS probe project through the normal typed `project.create` transaction and committed receipt. This is a canonical Dropbox mutation and requires the normal immediate explicit confirmation before submission.**
- [ ] **Step 7: R1 canary config commit sets stage `stamping` plus the new probe project ID; run CI, exact-commit deploy, then prove WORKING/REVIEW/DELIVERABLES identity and final-byte hash on the probe.**
- [ ] **Step 8: Promote R1 globally with a separate config-only commit only after canary proof; re-run read-only non-regression checks.**
- [ ] **Step 9: R2 canary config commit sets stage `rename` for the probe; prove `A.md -> B.md -> A.md`, historical alias rejection by another document, pre-provider abort release, forged identity conflict, and manual rename non-adoption.**
- [ ] **Step 10: Promote R2 globally with a separate config-only commit after proof and re-run non-regression.**
- [ ] **Step 11: R3 config-only commit sets stage `steady` globally; run full CI, exact-commit deploy, health, and final probe/non-regression checks.**
- [ ] **Step 12: Probe cleanup removes only synthetic human-visible source files when appropriate, preserves machine-managed evidence, and uses the normal Dropbox mutation confirmation/recovery rules.**
- [ ] **Step 13: Commit documentation as `docs(documents): document stable identity and rename rollout`; rollout config commits use gate-specific messages such as `IMP-DOCIDENTITY001 R1: enable stamping canary`.**

### Task 13: Canonical evidence and package closure

**Files / systems:**
- Read fresh PRJ-0002 `STATE.md` / canonical state before every mutation.
- GitHub authoritative sources: merged spec/plan PR, merged implementation PR, exact rollout commits, CI/deploy run IDs, production probe evidence.
- Dropbox canonical mutation only through typed Project OS transactions and committed receipts.

**Interfaces:**
- Canonical research/decision records reference exact authoritative GitHub commit/PR/run evidence.
- `TASK-IMPDOCIDENTITY001` completes only after R3 production proof.

- [ ] **Step 1: After the spec/plan is merged, prepare an accepted architecture/spec decision referencing the exact merged GitHub source; do not mutate Dropbox until the exact transaction plan is summarized and the user explicitly confirms that Dropbox mutation.**
- [ ] **Step 2: After each material rollout gate, record only validated production evidence needed for future recovery/audit; do not turn unproven recommendations into canonical facts.**
- [ ] **Step 3: Before final closure, refresh PRJ-0002 revision and verify there is no competing direction-changing canonical update.**
- [ ] **Step 4: Submit `task.complete` for `TASK-IMPDOCIDENTITY001` only after exact R3 CI/deploy/health/probe proof and obtain `receipt.status = committed`.**
- [ ] **Step 5: Refresh `STATE.md`, `HANDOFF.md`, and roadmap projection; verify the next remaining roadmap package is `IMP-INDEX001` and that no stale active DOCIDENTITY task remains.**

---

## Plan self-review checklist

Before implementation begins, the executor must confirm these mappings:

- Frontmatter visibility + hash ordering -> Tasks 1, 5, 6.
- Stable lifecycle ID + no task/document conflation -> Tasks 5, 6.
- Path claims, historical aliases, case/Unicode collision -> Task 2 and Task 9.
- Exact active-pointer rename concurrency -> Task 7 and Task 9.
- Temporary reservation and pre-provider abort release -> Tasks 8, 9, 11.
- Provider-neutral V2 rename evidence -> Task 8.
- New version per moved active representation + single-tip recovery -> Task 9.
- Forged/missing identity and external/manual rename behavior -> Tasks 4 and 10.
- In-flight rename before MutationGate -> Task 10.
- Legacy compatibility/no mass rewrite -> Tasks 4, 5, 6, 12.
- Crash matrix -> Task 11.
- Reader/stamping/rename/steady rollout + isolated probe -> Tasks 3 and 12.
- Canonical receipt-gated closure -> Task 13.

No implementation task changes ProjectState business schema, reference-document identity, projection-version semantics, MutationGate enforcement policy, or immutable historical Managed Document payloads.