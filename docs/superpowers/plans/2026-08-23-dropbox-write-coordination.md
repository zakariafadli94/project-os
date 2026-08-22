# Dropbox Write Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Project OS absorb transient Dropbox contention and serialize project business-artifact mutations through ProjectGuard without weakening real business conflict detection.

**Architecture:** Keep canonical transactions unchanged. Add a per-project `/artifact` write path to ProjectGuard using its existing serialization queue and durable idempotency receipts, and add deterministic transient retry/backoff to the Dropbox client. Artifact writes are restricted to `WORKSPACE/.../ARTIFACTS` and use content hashes to distinguish replay from real conflict.

**Tech Stack:** TypeScript, Cloudflare Workers Durable Objects/SQLite, Vitest, Dropbox HTTP API.

**Spec:** `docs/superpowers/specs/2026-08-23-dropbox-write-coordination-design.md`

## Global Constraints

- Canonical transaction semantics and `base_revision` rules do not change.
- Artifact writes may target only the project's `ARTIFACTS/` subtree.
- Exact replays are idempotent; same request id with different request data is rejected.
- Semantic conflicts remain visible and are never auto-overwritten.
- Transient retry is bounded to five attempts.
- Different project Durable Objects must remain independently parallel.

---

### Task 1: Deterministic Dropbox transient retry

**Files:**
- Modify: `src/dropbox/client.ts`
- Create: `src/dropbox/retry.ts`
- Test: `test/dropbox-retry.spec.ts`

**Interfaces:**
- Produces: `isTransientDropboxFailure(status: number, body: string): boolean`
- Produces: `retryDropboxWrite<T>(operation, options): Promise<T>` with injectable `sleep` and `random`.

- [ ] **Step 1: Write failing tests** for 429, 503, `too_many_write_operations`, retry exhaustion, and non-retry of semantic 409 conflict.
- [ ] **Step 2: Run `npx vitest run test/dropbox-retry.spec.ts`** and verify RED.
- [ ] **Step 3: Implement retry helper** with attempts 1..5 and bounded exponential delays plus jitter; no retry for ordinary path conflict.
- [ ] **Step 4: Wrap `upload`, `move`, and parent-folder creation calls** while preserving current `not_found` parent-recovery behavior.
- [ ] **Step 5: Run targeted tests then `npm run check`** and verify GREEN.

### Task 2: Artifact request validation and paths

**Files:**
- Modify: `src/dropbox/layout.ts`
- Create: `src/domain/artifact-write.ts`
- Test: `test/artifact-write.spec.ts`

**Interfaces:**
- Produces: `parseArtifactWriteRequest(input: unknown): ArtifactWriteRequest`
- Produces: `workspaceArtifactPath(projectId, slug, relativePath): string`

- [ ] **Step 1: Write failing validation tests** for valid nested paths, traversal, absolute paths, empty content hash, unsupported mode, mismatched project id shape.
- [ ] **Step 2: Run targeted tests** and verify RED.
- [ ] **Step 3: Implement parser and safe `ARTIFACTS/` path builder** without permitting generated canonical files.
- [ ] **Step 4: Run targeted tests** and verify GREEN.

### Task 3: Idempotent artifact repository writes

**Files:**
- Modify: `src/dropbox/repository.ts`
- Test: `test/artifact-repository.spec.ts`

**Interfaces:**
- Consumes: `workspaceArtifactPath(...)`
- Produces: `ProjectRepository.writeArtifact(state, request): Promise<"written" | "idempotent">`
- Throws explicit repository conflict when `mode=create` finds different existing content.

- [ ] **Step 1: Write failing tests** for create-new, create-same replay, create-different conflict, replace-same, replace-different.
- [ ] **Step 2: Run targeted tests** and verify RED.
- [ ] **Step 3: Implement minimal content-aware write logic** using `download` before upload.
- [ ] **Step 4: Run targeted tests** and verify GREEN.

### Task 4: ProjectGuard single-writer artifact endpoint

**Files:**
- Modify: `src/durable/project-guard.ts`
- Test: `test/project-guard-artifact.spec.ts`

**Interfaces:**
- Adds `POST /artifact`.
- Stores `artifact_requests(request_id PRIMARY KEY, request_json, receipt_json)` in Durable Object SQL.
- Returns `ArtifactWriteReceipt` with `committed | conflict | rejected`.

- [ ] **Step 1: Write failing tests** for commit, exact replay, request-id mismatch rejection, content conflict, project-binding mismatch, and ordering with a transaction submitted concurrently to the same ProjectGuard.
- [ ] **Step 2: Run targeted tests** and verify RED.
- [ ] **Step 3: Add durable artifact receipt table and endpoint** inside the existing `serialize()` queue.
- [ ] **Step 4: Ensure repository semantic conflict maps to `status=conflict`** while transient infrastructure exhaustion propagates as infrastructure failure rather than fake business conflict.
- [ ] **Step 5: Run targeted tests** and verify GREEN.

### Task 5: Parallelism and stress harness

**Files:**
- Create: `test/write-coordination-stress.spec.ts`
- Possibly modify: `test/helpers/mock-dropbox.ts` only to add deterministic contention simulation.

**Interfaces:**
- Uses two ProjectGuard Durable Object names to prove per-project rather than global serialization.

- [ ] **Step 1: Add deterministic same-project contention test** mixing transactions and artifact requests.
- [ ] **Step 2: Add two-project parallelism test** proving independent queues can overlap.
- [ ] **Step 3: Add 50-operation mixed sequence** with injected transient failures and assert no duplicate artifact receipts/files and correct final revisions.
- [ ] **Step 4: Run stress test repeatedly** and verify stable GREEN.

### Task 6: Operating contract and final verification

**Files:**
- Modify: `README.md` or existing operator/SOP documentation location discovered in repo.
- Test: existing full suite.

**Interfaces:**
- Documents that direct Project OS workspace artifact mutations must use `/artifact`; direct Dropbox reads remain allowed.

- [ ] **Step 1: Document mutation rule and retry semantics** without exposing secrets or requiring manual sleeps.
- [ ] **Step 2: Run `npm run check`** and require success.
- [ ] **Step 3: Run `npx wrangler deploy --dry-run`** and require success.
- [ ] **Step 4: Review diff for scope creep and semantic-conflict preservation.**
- [ ] **Step 5: Open PR with RED/GREEN evidence, request final review, and merge only after all checks pass.**

## Self-review

- Spec coverage: retry, idempotence, single-writer, same-project serialization, different-project parallelism, stress, and observability contract are all represented.
- Placeholder scan: no deferred implementation placeholders remain.
- Type consistency: request/receipt names and `/artifact` endpoint match the design spec.
