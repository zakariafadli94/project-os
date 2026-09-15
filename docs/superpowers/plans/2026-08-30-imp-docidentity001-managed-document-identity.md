# IMP-DOCIDENTITY001 — Managed Document Identity Visibility and Stable Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Managed Document identity visible and trustworthy in human Markdown, preserve one `document_id` across lifecycle and governed rename, reserve historical logical paths, and recover interrupted renames without mass rewriting existing documents.

**Architecture:** Add a pure Managed Markdown identity normalizer, durable per-project path claims, and a monotone staged `reader -> stamping -> rename -> steady` runtime policy. Keep existing deterministic `project_id + first logical_path` allocation only for initial work-product creation; after allocation, resolve current/historical paths through durable claims and perform rename through an immutable provider-neutral intent plus bounded temporary reservation, append-only stage steps, deterministic rename versions, and a terminal record. Reconciliation becomes identity-aware and snapshots active rename intents before recovery so governed provider moves cannot be mistaken for external MutationGate events.

**Tech Stack:** TypeScript 5.9, Zod 4.4, Vitest 4.1, Cloudflare Workers/Durable Objects, provider-neutral persistence runtime with Dropbox production provider, existing ProjectGuard request ledger and Managed Document V1/V2 codecs.

**Spec:** `docs/superpowers/specs/2026-08-30-imp-docidentity001-managed-document-identity-design.md`

## Global Constraints

- Scope is work products only: `WORKING`, `REVIEW`, `DELIVERABLES`. Reference-document identity is unchanged.
- Existing `document_id` values never change. New work products keep current deterministic initial allocation from `project_id + first logical_path`; rename never recalculates identity.
- `logical_path` is mutable only through governed `document.rename`.
- Human Markdown controlled fields are exactly `project_id` and `document_id`; `version_id` is not injected.
- Identity frontmatter normalization applies only to Markdown work products whose `logical_path` ends in `.md` case-insensitively. Non-Markdown work products keep their bytes unchanged while still receiving stable path-claim/rename semantics.
- Controlled identity mismatch, duplicate controlled keys, ambiguous controlled scalar syntax, stale expected versions, conflicting path ownership, provider precondition mismatch, or unverifiable partial rename fail closed.
- The request `content_sha256` validates caller-submitted bytes. For Markdown at stage >= `stamping`, `DocumentVersionRecord.content_sha256` records final normalized bytes actually persisted and written. For non-Markdown text it remains the submitted/final byte hash because no identity block is injected.
- Permanent path claims are project-scoped and immutable once committed. A historical alias can never be assigned to a different document.
- Logical claim keys use safe-path validation + Unicode NFC normalization + Unicode-aware lowercasing. This key is not treated as a complete model of every Dropbox collation edge case; live rename preflight also checks all provider destination paths and fails closed on provider occupancy/conflict.
- A clean rename failure before provider effect must not permanently claim the attempted destination.
- Once any provider effect occurs, recovery converges the same rename request; it must not silently release the destination or allocate a second identity.
- Governed rename creates a deterministic new version for each active representation it moves, even when payload bytes are reused.
- Rename versions preserve each stage's real lineage: renamed `published` points to prior `published`, renamed `working` to prior `working`, renamed `review` to prior `review`. Recovery is extended to recognize a coherent same-request multi-tip rename bundle; history is not artificially linearized.
- External/manual provider rename never changes `head.logical_path` automatically.
- Legacy unstamped documents remain readable. Identity stamping is opportunistic on governed Markdown text-producing writes and governed rename; no bulk rewrite and no write-on-read.
- Existing V1/V2 Managed Document records remain readable; new provider-bearing rename evidence uses provider-neutral schema 2.0; path claims may use independent schema 1.0.
- MutationGate remains `enforce`; active governed rename evidence must be recognized before strict-zone external mutation classification.
- Rollout never regresses another project to an earlier stage. Canary rollout uses a global baseline stage plus an optional canary stage that must be >= the baseline.
- GitHub Actions remain GitHub-hosted only. No self-hosted runner may be introduced.
- Production rollout uses a brand-new isolated probe project and exact-commit evidence; PRJ-0003 is not a canary.
- `src/render/frontmatter.ts` is not reused for collaborative Managed Documents.

---

## File map

New focused units:

- `src/documents/identity-frontmatter.ts` — inspect and minimally normalize controlled Markdown identity without broad YAML reserialization.
- `src/documents/path-key.ts` — logical claim-key normalization/key derivation for work products.
- `src/domain/managed-document-identity.ts` — strict path-claim/rename domain types, active pointer snapshot, deterministic rename-version IDs, and rename receipt.
- `src/schema/managed-document-rename.ts` — strict provider-neutral schema-2.0 rename intent/stage evidence codecs.
- `src/documents/path-claim-repository.ts` — immutable permanent claim lookup/write and current-path resolution.
- `src/documents/rename-repository.ts` — immutable rename intent/step/terminal records plus bounded active marker and destination reservation.
- `src/documents/rename-service.ts` — preflight, deterministic execution, recovery, version creation, head transition, and internal-change recognition.
- `src/documents/identity-rollout.ts` — monotone baseline/canary runtime policy.

Existing integration points:

- `src/domain/managed-document-request.ts` — add `document.rename` request with exact active-pointer snapshot.
- `src/domain/managed-document.ts` — reuse path/document/version validators.
- `src/documents/service.ts` — identity stamping, canonical hash ordering, path-claim enforcement, lifecycle claim adoption, and rename delegation.
- `src/documents/repository.ts` — payload/head/version helpers and narrowly-bounded coherent rename-bundle recovery; do not turn this already-large file into the rename state machine.
- `src/documents/reconciler.ts` — stamped/missing/mismatched identity behavior and claim-based path resolution.
- `src/documents/bootstrap.ts` — claim-first work-product resolution with legacy deterministic fallback.
- `src/documents/change-coordinator.ts` — snapshot/recover/partition governed rename changes before MutationGate/bootstrap/reconciliation.
- `src/documents/legacy-artifact.ts` — same Markdown identity normalization and canonical hash contract for published work products.
- `src/persistence/layout.ts` — bounded paths for path claims and rename records.
- `src/durable/project-guard-neutral.ts` — request routing, stage gating, active-rename recovery before document reads/writes, retry semantics, and service wiring.
- `src/durable/project-guard.ts` — resolve document-identity global baseline + optional canary stage for the bound project.
- `src/env.ts`, `wrangler.jsonc` — safe monotone rollout configuration.
- `package.json` — add rename fault suite to `test:persistence-high-risk` once the suite exists.
- `docs/managed-documents.md` — update after runtime behavior is implemented and validated.

Primary tests:

- create `test/managed-document-identity-frontmatter.spec.ts`
- create `test/managed-document-path-claims.spec.ts`
- create `test/managed-document-identity-rollout.spec.ts`
- create `test/managed-document-rename-repository.spec.ts`
- create `test/managed-document-rename.spec.ts`
- create `test/managed-document-rename-faults.spec.ts`
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
- modify `test/dropbox-paths.spec.ts`
- modify `test/mutation-gate-acceptance.spec.ts`

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
- Produces: `isManagedMarkdownPath(logicalPath: string): boolean` (`.md`, case-insensitive).
- Produces: `ManagedDocumentIdentityError` with `code` exactly `DOCUMENT_IDENTITY_MISMATCH` or `DOCUMENT_IDENTITY_AMBIGUOUS`.

- [ ] **Step 1: Write exact failing tests for a Markdown body with no frontmatter.**

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
- [ ] **Step 4: Add exact `.md` / `.MD` / `.markdown` / `.txt` path tests.** Only `.md` case-insensitive is in the stamping surface.
- [ ] **Step 5: Implement a line-oriented leading-frontmatter scanner.** Only top-level `project_id:` / `document_id:` lines are controlled. Do not invoke the generated-note renderer and do not parse/re-emit arbitrary YAML.
- [ ] **Step 6: Compute `content_sha256` from the final returned bytes with existing `sha256Text()`.**
- [ ] **Step 7: Run `npx vitest run test/managed-document-identity-frontmatter.spec.ts` and `npm run typecheck`.**
- [ ] **Step 8: Commit `feat(documents): normalize managed markdown identity`.**

### Task 2: Add Unicode-safe logical path keys and immutable path claims

**Files:**
- Create: `src/documents/path-key.ts`
- Create: `src/domain/managed-document-identity.ts`
- Create: `src/documents/path-claim-repository.ts`
- Create: `test/managed-document-path-claims.spec.ts`
- Modify: `test/dropbox-paths.spec.ts`
- Modify: `src/persistence/layout.ts`

**Interfaces:**
- Produces: `normalizeManagedLogicalPathKey(logicalPath: string): string` = safe managed relative path, then NFC normalize, then Unicode-aware `toLowerCase()` over the full relative path.
- Produces: `managedLogicalPathKey(logicalPath: string): Promise<string>` returning lowercase 64-hex SHA-256 of the normalized key material.
- Produces: `ManagedDocumentPathClaim { schema_version:"1.0"; project_id; normalized_logical_path; first_seen_logical_path; document_id; claimed_at; source:"initial_create"|"governed_rename"|"legacy_adoption" }`
- Produces: `PathClaimRepository.read(projectId, logicalPath)` / `claim(record)` / `resolveWorkProductDocumentId(projectId, logicalPath)`.
- Produces layout: `.project-os/projects/<PRJ>/documents/path-claims/<SHA256>.json`.

- [ ] **Step 1: Write failing normalization vectors for composed/decomposed Unicode NFC (`é` vs `e + combining acute`) and case (`Report.md` vs `report.md`, `ÉTUDE.md` vs `étude.md`).** Do not describe `toLowerCase()` as full Unicode case folding.
- [ ] **Step 2: Add claim tests: first claim succeeds; same document retry is idempotent; different document fails; same logical path in another project succeeds independently.**
- [ ] **Step 3: Add a test that an existing historical alias claimed by `DOC-A...` causes `resolveWorkProductDocumentId()` to return that ID instead of recomputing `documentIdFor(projectId, logicalPath)`.**
- [ ] **Step 4: Implement the strict record parser and deterministic layout helper.** `claim()` uses `createText`; on provider conflict it rereads and accepts only semantic equivalence for the same project/key/document.
- [ ] **Step 5: Implement legacy fallback: no claim means `documentIdFor(projectId, logicalPath)`; claim presence is authoritative.**
- [ ] **Step 6: Add provider-path tests documenting that logical claim normalization is one guard, while live provider destination occupancy remains authoritative during rename preflight.** No code may assume claim-key equality proves a Dropbox target is physically free.
- [ ] **Step 7: Run `npx vitest run test/managed-document-path-claims.spec.ts test/managed-document.spec.ts test/dropbox-paths.spec.ts test/workspace-layout.spec.ts`.**
- [ ] **Step 8: Commit `feat(documents): add durable logical path claims`.**

### Task 3: Add monotone reader-first rollout policy and project-scoped canary resolution

**Files:**
- Create: `src/documents/identity-rollout.ts`
- Create: `test/managed-document-identity-rollout.spec.ts`
- Modify: `src/env.ts`
- Modify: `src/durable/project-guard.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Produces: `type DocumentIdentityStage = "reader" | "stamping" | "rename" | "steady"`
- Produces: `parseDocumentIdentityStage(value?: string): DocumentIdentityStage`, default `reader` for the global baseline.
- Produces: `assertDocumentIdentityStageAtLeast(actual, required): void` and `assertNoDocumentIdentityStageRegression(base, candidate): void` with ordering `reader < stamping < rename < steady`.
- Produces: `resolveDocumentIdentityStageForProject(baseStage, canaryStage, canaryProjectId, boundProjectId)`.
- Adds env names: `PROJECT_OS_DOCUMENT_IDENTITY_STAGE`, `PROJECT_OS_DOCUMENT_IDENTITY_CANARY_STAGE`, `PROJECT_OS_DOCUMENT_IDENTITY_CANARY_PROJECT_ID`.
- Exact rule: no canary fields -> every project gets `baseStage`; canary stage + project ID -> canary gets `canaryStage`, all others keep `baseStage`; `canaryStage < baseStage`, only one canary field, or invalid stage fails closed at construction.

- [ ] **Step 1: Write failing stage-order/default/invalid-stage tests and exact monotone canary tests.** Explicitly prove base=`stamping`, canary=`rename` leaves non-canary projects at `stamping`, never `reader`.
- [ ] **Step 2: Wire the bound `ProjectGuard` wrapper to resolve the effective stage once, then pass only the effective stage into the neutral guard.** MutationGate subclass inherits this effective policy.
- [ ] **Step 3: Thread the effective stage into Managed Document services/coordinator without changing behavior yet.**
- [ ] **Step 4: Set production `wrangler.jsonc` to `PROJECT_OS_DOCUMENT_IDENTITY_STAGE: "reader"` with no canary fields.** This is R0-safe merged code: readers may understand new evidence but no identity stamping or rename write is enabled.
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
- Consumes: `inspectManagedMarkdownIdentity()`, `isManagedMarkdownPath()`, `PathClaimRepository.resolveWorkProductDocumentId()`.
- Produces repository helper: `readVersionPayloadText(record): Promise<string | null>` only when the record proves a canonical text payload.
- Produces reconciler semantics: stamped governed Markdown requires matching visible controlled identity; legacy governed Markdown tolerates missing controlled fields; non-Markdown work products skip frontmatter inspection entirely.

- [ ] **Step 1: Add failing bootstrap tests proving a permanent path claim resolves a renamed work product to its original `document_id`; no-claim legacy bootstrap retains current deterministic behavior.**
- [ ] **Step 2: Add failing Markdown reconciliation tests for correct stamped identity, forged `document_id`, forged `project_id`, and removal of identity from a version whose canonical payload is stamped.**
- [ ] **Step 3: Add a non-Markdown regression test proving `notes.txt` is never interpreted as YAML identity metadata.**
- [ ] **Step 4: Add a failing manual-rename test: a visible Markdown file under a different logical path contains a known stamped `document_id`; reconciliation records conflict/evidence but does not mutate `head.logical_path` or create a claim.**
- [ ] **Step 5: Refactor work-product path lookup in bootstrap/reconciler from direct `documentIdFor(projectId, logicalPath)` to claim-first resolution.** Reference logic remains unchanged.
- [ ] **Step 6: Implement stamped-state authority by inspecting the current governed immutable payload; absence remains legacy only when that governed Markdown payload itself is unstamped.**
- [ ] **Step 7: For identity mismatch/manual move, snapshot provider evidence under a deterministic external version when possible, mark `reconciliation_status: "conflict"`, and preserve/restore the governed current representation under existing recovery rules. Never use the external frontmatter ID to rebind the head.**
- [ ] **Step 8: Run `npx vitest run test/document-bootstrap.spec.ts test/document-external-edits.spec.ts test/document-head-recovery.spec.ts test/managed-document-acceptance.spec.ts`.**
- [ ] **Step 9: Commit `feat(documents): add reader-first identity reconciliation`.**

### Task 5: Enable R1 Markdown identity stamping, canonical hashing, and opportunistic current-path claims

**Files:**
- Modify: `src/documents/service.ts`
- Modify: `src/documents/repository.ts`
- Modify: `test/document-lifecycle.spec.ts`
- Modify: `test/managed-document-faults.spec.ts`
- Modify: `test/dropbox-document-concurrency.spec.ts`

**Interfaces:**
- Consumes: `normalizeManagedMarkdownIdentity()`, `isManagedMarkdownPath()`, `PathClaimRepository`, effective `DocumentIdentityStage`.
- Produces service helper: `prepareGovernedText(projectId, documentId, logicalPath, submittedContent, submittedSha256)` that first validates submitted hash, then normalizes only Markdown when stage >= `stamping`, and returns final bytes/final SHA.
- Produces service helper: `ensureCurrentPathClaim(headOrIdentity, source)` invoked on successful/replayed governed mutations when stage >= `stamping`.

- [ ] **Step 1: Add a failing Markdown WORKING test proving caller hash validates original content while the version payload/hash and visible file match stamped final bytes.**

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
const visible = await runtime.objects.readText(
  workspaceManagedDocumentPath(state.project_id, state.slug, "working", "plan.md")
);
expect(visible).toContain(`document_id: ${receipt.document_id}`);
```

- [ ] **Step 2: Add a non-Markdown WORKING test proving `plan.txt` visible/payload bytes and SHA remain exactly the caller-submitted bytes while a path claim is still established.**
- [ ] **Step 3: Add failing lifecycle tests: stamped WORKING promotes/publishes/reopens without ID change; `review.write` preserves task metadata and the same ID; V2 versions change while logical identity does not.**
- [ ] **Step 4: Add failure tests for caller-supplied wrong controlled IDs and historical-alias `working.write`; return `DOCUMENT_IDENTITY_MISMATCH` / `HISTORICAL_LOGICAL_PATH` before provider mutation.**
- [ ] **Step 5: Refactor text write paths so `storeTextPayload()` receives final canonical SHA/content. Do not overwrite the request's submitted-hash semantics.**
- [ ] **Step 6: Ensure replay paths also repair a missing current-path claim idempotently before returning a committed receipt.** A crash after head/version but before claim must converge on retry.
- [ ] **Step 7: Establish a permanent claim for the current path on every successful governed work-product mutation at stage >= `stamping`, using `initial_create` for first creation and `legacy_adoption` for existing unclaimed heads.**
- [ ] **Step 8: Keep pure move-only lifecycle transitions from rewriting legacy unstamped bytes solely to stamp identity. If publication performs an actual Markdown text replacement, normalize the bytes before that replacement.**
- [ ] **Step 9: Run the focused lifecycle/fault/concurrency suites and `npm run check`.**
- [ ] **Step 10: Commit `feat(documents): stamp governed markdown identity`.**

### Task 6: Apply the same identity contract to legacy Artifact API Markdown publications

**Files:**
- Modify: `src/documents/legacy-artifact.ts`
- Modify: `src/documents/legacy-artifact-provenance.ts`
- Modify: `test/legacy-artifact-managed.spec.ts`
- Modify: `test/project-guard-artifact.spec.ts`

**Interfaces:**
- Consumes: identity normalizer, Markdown path predicate, path claims, effective stage.
- Preserves: artifact request `content_sha256` means caller-submitted bytes; Managed Document version `content_sha256` means final normalized bytes for Markdown at stage >= `stamping`.

- [ ] **Step 1: Add a failing new-published-`.md` test proving visible frontmatter `document_id` equals the head and final payload hash equals visible bytes.**
- [ ] **Step 2: Add replacement test proving the same logical published document retains one `document_id` and a new version while preserving unrelated frontmatter.**
- [ ] **Step 3: Add failure test proving caller-supplied conflicting `document_id` cannot override ledger identity.**
- [ ] **Step 4: Refactor published Markdown flow to determine the work-product `document_id` before payload storage, normalize final bytes, store final canonical payload, then write provider content.**
- [ ] **Step 5: Keep non-`.md` artifact behavior byte-for-byte unchanged and keep reference routes out of scope.**
- [ ] **Step 6: Ensure the current path claim is established after successful managed publication/replay.**
- [ ] **Step 7: Run `npx vitest run test/legacy-artifact-managed.spec.ts test/project-guard-artifact.spec.ts`.**
- [ ] **Step 8: Commit `feat(documents): stamp legacy managed markdown artifacts`.**

### Task 7: Add the governed rename request, receipt, exact-pointer contract, and stage gate

**Files:**
- Modify: `src/domain/managed-document-request.ts`
- Modify: `src/domain/managed-document-identity.ts`
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
- Produces dedicated committed response:

```ts
interface ManagedDocumentRenameReceipt {
  request_id: string;
  project_id: string;
  document_id: string;
  status: "committed";
  from_logical_path: string;
  logical_path: string;
  version_ids: ActiveWorkProductVersions;
}
```

- `ManagedDocumentOperationReceipt` becomes the union of existing single-stage receipt, rename receipt, and existing terminal rejected/conflict receipt.

- [ ] **Step 1: Add parser tests for valid rename, invalid path, malformed IDs, extra unknown expected-version keys, and malformed version IDs.**
- [ ] **Step 2: Add deterministic rename-version vectors for all three stages and prove retries return identical IDs.**
- [ ] **Step 3: Add receipt parser/serialization tests proving a multi-stage rename returns every new active version ID rather than pretending there is one `stage/version_id`.**
- [ ] **Step 4: Add ProjectGuard test: below effective stage `rename`, `document.rename` returns a durable rejected receipt with `DOCUMENT_RENAME_DISABLED` and performs no provider mutation.**
- [ ] **Step 5: Add exact expected-pointer helper comparing supplied set to head set, including absence: omitted `published` is stale when head has one, and supplied `review` is stale when head does not.**
- [ ] **Step 6: Wire the switch case to a rename service interface but keep execution disabled until effective stage >= `rename`.**
- [ ] **Step 7: Run `npx vitest run test/managed-document-request.spec.ts test/project-guard-document.spec.ts`.**
- [ ] **Step 8: Commit `feat(documents): add governed rename request contract`.**

### Task 8: Add durable rename intent, reservation, step and terminal repository

**Files:**
- Create: `src/schema/managed-document-rename.ts`
- Create: `src/documents/rename-repository.ts`
- Create: `test/managed-document-rename-repository.spec.ts`
- Modify: `src/persistence/layout.ts`
- Consume: `src/schema/provider-evidence.ts`

**Interfaces:**
- Produces provider-neutral `ManagedDocumentRenameIntentV2` with `schema_version:"2.0"`, immutable from/to paths, exact expected pointers, and per-stage frozen `ProviderObservation`.
- Produces immutable `ManagedDocumentRenameStepV2` per stage, containing deterministic new version ID and destination provider evidence.
- Produces immutable terminal record `{ schema_version:"1.0"; request_id; project_id; document_id; status:"committed"|"aborted"; completed_at; code? }`.
- Produces bounded active marker `.project-os/projects/<PRJ>/documents/renames/active/<DOCREQ>.json`.
- Produces bounded destination reservation head `.project-os/projects/<PRJ>/documents/renames/reservations/<PATH_SHA>.json` containing current reserving request/document; a terminal intent makes an old reservation inactive and replaceable.
- Produces intent/step/terminal paths under `.project-os/projects/<PRJ>/documents/renames/intents/<DOCREQ>/...`.

- [ ] **Step 1: Write strict codec tests proving rename intent is schema 2.0 and every active stage carries complete provider-neutral evidence; partial provider evidence fails closed.**
- [ ] **Step 2: Add reservation tests: first live reservation succeeds, same request is idempotent, another live request/document is blocked, aborted/committed old reservation may be replaced only after terminal proof.**
- [ ] **Step 3: Add active-index tests proving `listActiveIntents(projectId)` lists only active markers, tolerates a terminal intent left with stale marker, and cleans such stale temporary indexes without altering immutable intent/history.**
- [ ] **Step 4: Implement immutable create/read helpers with conflict-equivalence checks. Keep permanent path claims in `PathClaimRepository`, not in rename repository.**
- [ ] **Step 5: Run `npx vitest run test/managed-document-rename-repository.spec.ts test/schema/provider-evidence.spec.ts`.**
- [ ] **Step 6: Commit `feat(documents): add durable rename journal`.**

### Task 9: Implement deterministic crash-safe rename execution and coherent history recovery

**Files:**
- Create: `src/documents/rename-service.ts`
- Modify: `src/documents/service.ts`
- Modify: `src/documents/repository.ts`
- Create: `test/managed-document-rename.spec.ts`
- Modify: `test/document-head-recovery.spec.ts`
- Modify: `test/dropbox-document-concurrency.spec.ts`
- Modify: `test/project-guard-document.spec.ts`

**Interfaces:**
- Produces: `rename(request, state): Promise<ManagedDocumentRenameReceipt>`.
- Produces: `recoverActive(state): Promise<{ recovered:number; aborted:number }>`.
- Produces: `snapshotActiveIntents(projectId)` / `matchesInternalRenameChange(snapshot, change)` support used by coordinator.
- Consumes: `PathClaimRepository`, `ManagedDocumentRenameRepository`, Markdown identity normalizer, runtime provider preconditions, deterministic rename version IDs.

- [ ] **Step 1: Add failing preflight tests for project/status binding, stale exact pointer set, path claim owned by another document, live reservation owned by another request, occupied destination provider path, and provider revision mismatch. Assert no intent/reservation/provider effect for failures discovered before journal preparation.** Check every active destination zone with `getMetadata`; any occupied target not proven to be the same source object for an intentional provider-equivalent case-only move fails closed.
- [ ] **Step 2: Add WORKING-only, published-only, published+reopened-WORKING, and published+REVIEW rename tests. Assert every active representation moves to the same new logical path and gets its own deterministic rename version.**
- [ ] **Step 3: Preserve real stage ancestry.** Rename-published has prior published as parent; rename-working has prior working as parent; rename-review has prior review as parent. Do not linearize unrelated content lineage merely to satisfy the old single-tip recovery algorithm.
- [ ] **Step 4: Extend `restoreHeadFromVersions()` narrowly for a coherent rename bundle.** When there are exactly two tips, accept them only if both are `source:"project_os"`, share the same rename `request_id`, share the same new `logical_path`, contain exactly `published + working` or `published + review`, and their deterministic version IDs match `renameVersionIdFor(request_id, stage)`. Reconstruct both pointers. Any other multi-tip state continues to fail closed. Single-tip behavior remains unchanged.
- [ ] **Step 5: Add partial-bundle recovery test.** If only one rename-stage version is durable while the old other-stage tip remains, generic head reconstruction must fail closed rather than manufacture a state. The active rename journal is responsible for finishing the bundle first.
- [ ] **Step 6: Implement preflight order exactly: load head -> exact pointer check -> validate/normalize destination -> permanent claim conflict check -> live reservation conflict check -> verify every active source provider observation -> verify every active destination physically free/allowable -> persist immutable intent -> write active marker/reservation -> begin provider effects.**
- [ ] **Step 7: For each active stage in deterministic order `published`, then `working`, then `review` when present, detect already-completed source/destination state before moving.** Working and review are mutually exclusive in a valid head, so at most two active work-product representations move in normal reopened/review cases.
- [ ] **Step 8: For stamped Markdown or any non-Markdown work product, move provider object, capture destination evidence, reuse existing immutable payload, and write deterministic rename version. For legacy unstamped Markdown, move, read destination text, normalize identity, conditional-write stamped bytes against moved revision, store new canonical text payload/hash, then write deterministic rename version.**
- [ ] **Step 9: Persist an immutable stage step only after provider destination evidence and version record are durable. Retry checks step/version/evidence before another provider mutation.**
- [ ] **Step 10: After all active stages: claim destination permanently with source `governed_rename`; update head with same `document_id`, new `logical_path`, renamed active pointers/provider observations; write terminal committed; clean active marker/reservation.** Crash after permanent claim but before head must resume because claim belongs to same document and live intent.
- [ ] **Step 11: Implement pre-provider abort only when no provider effect/step exists.** Write terminal `aborted`, clean temporary indexes, do not create permanent claim. Once any provider effect exists, propagate retryable/non-terminal error without writing a terminal ProjectGuard document receipt so same request can resume.
- [ ] **Step 12: If terminal committed exists but ProjectGuard managed-request receipt is missing, reconstruct `ManagedDocumentRenameReceipt` deterministically from intent + stage steps + current head and return it; do not repeat provider effects.**
- [ ] **Step 13: At effective stage >= `rename`, ProjectGuard recovers active rename intents before handling any `/document` mutation or document-status read that could otherwise call ordinary head restoration.** This guarantees a deleted head during an in-flight rename is repaired by rename recovery before generic version-tip recovery.
- [ ] **Step 14: Add `A.md -> B.md -> A.md` test proving same document may explicitly return to historical alias while second document can never use either claim.**
- [ ] **Step 15: Run `npx vitest run test/managed-document-rename.spec.ts test/document-head-recovery.spec.ts test/dropbox-document-concurrency.spec.ts test/project-guard-document.spec.ts` and `npm run typecheck`.**
- [ ] **Step 16: Commit `feat(documents): implement crash safe governed rename`.**

### Task 10: Recover/snapshot active renames before MutationGate and classify provider changes safely

**Files:**
- Modify: `src/documents/change-coordinator.ts`
- Modify: `src/documents/reconciler.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: `test/document-change-coordinator.spec.ts`
- Modify: `test/document-external-edits.spec.ts`
- Modify: `test/mutation-gate-acceptance.spec.ts`

**Interfaces:**
- `ManagedDocumentChangeCoordinator` consumes effective identity stage and rename service/repository.
- Produces ordering: provider page -> snapshot active rename intents -> recover active renames -> partition fetched page -> MutationGate/bootstrap/reconciler -> cursor advance.
- Produces partition `{ internalRenameChanges, externalChanges }`.
- Destination file events are internal only when exact provider evidence matches an immutable rename step (object/revision/hash/path).
- Source deletion events, which lack metadata, are internal only when their source path belongs to an intent that was active in the snapshot taken for that fetched provider page. A historical terminal intent alone can never suppress a later deletion.

- [ ] **Step 1: Add failing strict-zone test where governed rename moves `DELIVERABLES/A.md` to `DELIVERABLES/B.md`; change feed contains source deletion + destination appearance. Assert MutationGate creates no external candidate for those exact governed changes.**
- [ ] **Step 2: Add neighboring negative tests: same destination appearance with different revision/object evidence, or same source deletion after no intent was active at page snapshot, still reaches MutationGate `enforce`.**
- [ ] **Step 3: After fetching page and before recovery, snapshot active rename intents for the project. Then call `recoverActive(state)` at effective stage >= `rename`.**
- [ ] **Step 4: Partition the already-fetched page using the pre-recovery active snapshot plus immutable post-recovery step evidence.** This remains valid even if recovery just wrote terminal/cleaned active markers.
- [ ] **Step 5: Pass every non-matching entry unchanged to MutationGate, baseline bootstrap and reconciler.** Never filter based only on an old terminal intent or path name.
- [ ] **Step 6: Ensure cursor advancement occurs after governed recovery and external processing; internal rename changes count as internal/ignored summary, not external captures/candidates.**
- [ ] **Step 7: Add manual rename to historical alias test proving no active snapshot means conflict and no automatic logical-path update.**
- [ ] **Step 8: Run `npx vitest run test/document-change-coordinator.spec.ts test/document-external-edits.spec.ts test/mutation-gate-acceptance.spec.ts`.**
- [ ] **Step 9: Commit `feat(documents): reconcile governed rename effects before mutation gate`.**

### Task 11: Prove crash convergence at every rename boundary and promote the suite to high-risk CI

**Files:**
- Create: `test/managed-document-rename-faults.spec.ts`
- Modify: `package.json`
- Reuse unchanged: `test/helpers/mock-dropbox.ts` via `installDropboxMock({ faults })`
- Reuse patterns from: `test/managed-document-faults.spec.ts`, `test/mutation-gate-faults.spec.ts`, `test/fault-injection-harness.spec.ts`

**Interfaces:**
- Test boundaries exactly: `after_intent`, `after_first_provider_move`, `after_destination_evidence`, `after_first_rename_version`, `after_all_provider_moves`, `after_path_claim`, `after_head_update`.
- Do not add production-only fault switches. Inject failures through existing Dropbox mock endpoint/path/occurrence faults against the next durable/provider operation at each boundary.

- [ ] **Step 1: Build one deterministic fixture with published+reopened-WORKING so recovery must preserve two active representations and one stable identity.**
- [ ] **Step 2: For each boundary, target the next concrete Dropbox mock call (journal/version/head/path-claim upload, provider move, metadata/read as appropriate), force first attempt to escape without final request receipt, recreate/reacquire service/guard facade, then retry/recover same request.**
- [ ] **Step 3: Assert convergence to one `document_id`, one current `logical_path`, one published pointer, one working pointer, deterministic per-stage rename version IDs, one permanent destination claim, one committed rename terminal, and no duplicate provider effects.**
- [ ] **Step 4: Add pre-provider abort case where destination becomes invalid/occupied before any move; assert terminal aborted when journal exists, temporary reservation inactive, no destination permanent claim, and another valid request can subsequently use that path.**
- [ ] **Step 5: Add crash-after-path-claim-before-head test proving permanent claim does not strand operation: same live intent resumes and finalizes head/terminal.**
- [ ] **Step 6: Add crash-after-head-before-terminal/request-receipt test proving recovery writes/observes terminal and reconstructs receipt without second versions/provider moves.**
- [ ] **Step 7: Add `test/managed-document-rename-faults.spec.ts` to `test:persistence-high-risk`.**
- [ ] **Step 8: Run `npm run test:persistence-high-risk`, `npm run check`, and `npx wrangler deploy --dry-run`.**
- [ ] **Step 9: Commit `test(documents): prove rename crash convergence`.**

### Task 12: Document runtime contract and execute monotone R0/R1/R2/R3 rollout commits

**Files:**
- Modify: `docs/managed-documents.md`
- Create: `docs/imp-docidentity001-rollout.md`
- Modify: `wrangler.jsonc` in separate rollout commits after implementation PR is green

**Interfaces:**
- R0: base=`reader`, no canary.
- R1 canary: base=`reader`, canary stage=`stamping`, canary project=new isolated probe.
- R1 global: base=`stamping`, no canary.
- R2 canary: base=`stamping`, canary stage=`rename`, same probe.
- R2 global: base=`rename`, no canary.
- R3 global: base=`steady`, no canary.
- A canary stage lower than base is invalid; rollout can never downgrade non-canary projects.

- [ ] **Step 1: Update `docs/managed-documents.md` with Markdown-only controlled frontmatter contract, submitted-vs-canonical hash semantics, non-Markdown byte preservation, path claims, historical aliases, rename request/receipt, exact expected-pointer concurrency, external rename behavior, coherent rename-bundle recovery, and crash semantics.**
- [ ] **Step 2: Write `docs/imp-docidentity001-rollout.md` with exact gate order, env values above, required CI/deploy SHA checks, health endpoint check, probe steps, non-regression reads, and stop conditions. Explicitly state GitHub-hosted-only and no bulk rewrite.**
- [ ] **Step 3: Run `npm run check`, `npm run test:persistence-high-risk`, and `npx wrangler deploy --dry-run`; record exact green implementation head in PR.**
- [ ] **Step 4: Merge implementation code only with production base still R0 `reader` and no canary fields.**
- [ ] **Step 5: R0 production gate: exact-commit GitHub-hosted deploy, `/health`, read-only reconciliation/non-regression on existing projects. Do not create probe until R0 is green.**
- [ ] **Step 6: Create a brand-new isolated Project OS probe project through normal typed `project.create` transaction and committed receipt.** This is a canonical Dropbox mutation and requires normal immediate explicit confirmation before submission.
- [ ] **Step 7: R1 canary config commit sets base `reader`, canary `stamping`, canary project ID; run CI, exact-commit deploy, prove Markdown WORKING/REVIEW/DELIVERABLES identity and final-byte hash on probe.**
- [ ] **Step 8: Promote R1 globally with separate config-only commit setting base `stamping` and removing both canary fields; re-run read-only non-regression.**
- [ ] **Step 9: R2 canary config commit keeps base `stamping`, sets canary `rename` + probe ID; prove `A.md -> B.md -> A.md`, historical alias rejection by another document, pre-provider abort release, forged identity conflict, manual rename non-adoption, and no false MutationGate candidate for governed moves.**
- [ ] **Step 10: Promote R2 globally with separate config-only commit setting base `rename` and removing canary fields; re-run non-regression.**
- [ ] **Step 11: R3 config-only commit sets base `steady` globally; run full CI, exact-commit deploy, health, final probe and non-regression checks.**
- [ ] **Step 12: Probe cleanup removes only synthetic human-visible source files when appropriate, preserves machine-managed evidence, and uses normal Dropbox mutation confirmation/recovery rules.**
- [ ] **Step 13: Commit documentation as `docs(documents): document stable identity and rename rollout`; rollout config commits use gate-specific messages such as `IMP-DOCIDENTITY001 R1: enable stamping canary`.**

### Task 13: Canonical evidence and package closure

**Files / systems:**
- Read fresh PRJ-0002 `STATE.md` / canonical state before every mutation.
- GitHub authoritative sources: merged spec/plan PR, merged implementation PR, exact rollout commits, CI/deploy run IDs, production probe evidence.
- Dropbox canonical mutation only through typed Project OS transactions and committed receipts.

**Interfaces:**
- Canonical research/decision records reference exact authoritative GitHub commit/PR/run evidence.
- `TASK-IMPDOCIDENTITY001` completes only after R3 production proof.

- [ ] **Step 1: After spec/plan is merged, prepare accepted architecture/spec decision referencing exact merged GitHub source; do not mutate Dropbox until exact transaction plan is summarized and user explicitly confirms that Dropbox mutation.**
- [ ] **Step 2: After each material rollout gate, record only validated production evidence needed for future recovery/audit; do not turn unproven recommendations into canonical facts.**
- [ ] **Step 3: Before final closure, refresh PRJ-0002 revision and verify there is no competing direction-changing canonical update.**
- [ ] **Step 4: Submit `task.complete` for `TASK-IMPDOCIDENTITY001` only after exact R3 CI/deploy/health/probe proof and obtain `receipt.status = committed`.**
- [ ] **Step 5: Refresh `STATE.md`, `HANDOFF.md`, and roadmap projection; verify next remaining roadmap package is `IMP-INDEX001` and no stale active DOCIDENTITY task remains.**

---

## Plan self-review checklist

Before implementation begins, executor must confirm these mappings:

- Markdown frontmatter visibility + hash ordering + non-Markdown byte safety -> Tasks 1, 5, 6.
- Stable lifecycle ID + no task/document conflation -> Tasks 5, 6.
- Path claims, historical aliases, case/Unicode collision + live provider occupancy backstop -> Tasks 2, 9.
- Exact active-pointer rename concurrency + explicit multi-stage receipt -> Task 7 and Task 9.
- Temporary reservation and pre-provider abort release -> Tasks 8, 9, 11.
- Provider-neutral V2 rename evidence -> Task 8.
- New version per moved active representation + faithful coherent multi-tip recovery -> Task 9.
- Forged/missing identity and external/manual rename behavior -> Tasks 4, 10.
- Active-intent snapshot/recovery before MutationGate -> Task 10.
- Legacy compatibility/no mass rewrite -> Tasks 4, 5, 6, 12.
- Crash matrix + request-receipt recovery -> Task 11.
- Monotone reader/stamping/rename/steady rollout + isolated probe -> Tasks 3, 12.
- Canonical receipt-gated closure -> Task 13.

No implementation task changes ProjectState business schema, reference-document identity, projection-version semantics, MutationGate enforcement policy, or immutable historical Managed Document payloads.