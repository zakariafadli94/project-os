# Dropbox Write Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Project OS absorb transient Dropbox contention and serialize project business-artifact mutations through ProjectGuard without weakening real business conflict detection.

**Architecture:** Keep canonical transactions unchanged. Add a per-project `/artifact` write path to ProjectGuard using its existing serialization queue and durable idempotency receipts, add deterministic transient retry/backoff to the Dropbox transport, and bridge the actual ChatGPT workflow through `.project-os/artifacts/incoming`. Artifact writes are restricted to `WORKSPACE/.../ARTIFACTS` and use content hashes to distinguish replay from real conflict.

**Tech Stack:** TypeScript, Cloudflare Workers Durable Objects/SQLite, Vitest, Dropbox HTTP API.

**Spec:** `docs/superpowers/specs/2026-08-23-dropbox-write-coordination-design.md`

## Global Constraints

- Canonical transaction semantics and `base_revision` rules do not change.
- Artifact writes may target only the project's `ARTIFACTS/` subtree.
- Exact replays are idempotent; same request id with different request data is rejected.
- Semantic conflicts remain visible and are never auto-overwritten.
- Transient retry is bounded to five attempts.
- Different project Durable Objects must remain independently parallel.
- Normal Dropbox-backed ChatGPT operation uses artifact request messages; ProjectGuard remains the only writer of final business artifacts.

---

### Task 1: Deterministic Dropbox transient retry

**Files:**
- Create: `src/dropbox/retry.ts`
- Create: `src/dropbox/resilient-transport.ts`
- Test: `test/dropbox-retry.spec.ts`
- Test: `test/resilient-dropbox-transport.spec.ts`

- [x] **Step 1: Write failing tests** for 429, 503, `too_many_write_operations`, retry exhaustion, and non-retry of semantic 409 conflict.
- [x] **Step 2: Implement bounded retry** with exponential delay + jitter and deterministic test hooks.
- [x] **Step 3: Wrap internal ProjectRepository and inbox archival writes** without weakening semantic conflict handling.

### Task 2: Artifact request validation and paths

**Files:**
- Modify: `src/dropbox/layout.ts`
- Create: `src/domain/artifact-write.ts`
- Test: `test/artifact-write.spec.ts`

- [x] **Step 1: Add strict artifact request validation** for request ID, project ID, SHA-256, mode and safe relative paths.
- [x] **Step 2: Add safe `ARTIFACTS/` path builder** preventing traversal into generated/canonical files.

### Task 3: Idempotent artifact repository writes and receipts

**Files:**
- Modify: `src/dropbox/repository.ts`
- Test: `test/artifact-repository.spec.ts`

- [x] **Step 1: Cover create-new, create-same replay, create-different conflict, replace-same, replace-different.**
- [x] **Step 2: Implement content-aware idempotent writes.**
- [x] **Step 3: Add immutable artifact receipt publication.**
- [x] **Step 4: Recover races by verifying target content after Dropbox conflict.**

### Task 4: ProjectGuard single-writer artifact endpoint

**Files:**
- Modify: `src/durable/project-guard.ts`
- Test: `test/project-guard-artifact.spec.ts`

- [x] **Step 1: Add `POST /artifact` inside the existing `serialize()` queue.**
- [x] **Step 2: Store durable idempotency receipts keyed by request ID.**
- [x] **Step 3: Recompute SHA-256 server-side and reject mismatches.**
- [x] **Step 4: Preserve real content conflicts as `status=conflict`.**
- [x] **Step 5: Write Dropbox artifact receipt before durable acknowledgment.**

### Task 5: Artifact inbox and direct ingress

**Files:**
- Modify: `src/index.ts`
- Modify: `src/dropbox/layout.ts`
- Test: `test/index.spec.ts`
- Test: `test/admin-process-inbox.spec.ts`

- [x] **Step 1: Add `.project-os/artifacts/incoming` and terminal request paths.**
- [x] **Step 2: Process canonical transaction inbox before artifact inbox.**
- [x] **Step 3: Route inbox requests through ProjectGuard and archive source messages by terminal status.**
- [x] **Step 4: Add authenticated `POST /v1/artifacts` using the same route.**
- [x] **Step 5: Keep failed infrastructure messages recoverable for later retry.**

### Task 6: Parallelism and stress harness

**Files:**
- Create: `test/write-coordination-stress.spec.ts`
- Modify: `test/helpers/mock-dropbox.ts`

- [x] **Step 1: Add deterministic transient contention injection.**
- [x] **Step 2: Add 50-operation mixed same-project sequence with exact replays.**
- [x] **Step 3: Add two-project parallelism test.**
- [x] **Step 4: Verify no duplicate artifact effects and correct canonical revisions.**

### Task 7: Operating contract and final verification

**Files:**
- Modify: `README.md`
- Modify: design + plan docs.
- Test: existing full suite.

- [x] **Step 1: Document artifact inbox, receipts, direct ingress and mutation rule.**
- [ ] **Step 2: Run `npm run check` on final head and require success.**
- [ ] **Step 3: Run `npx wrangler deploy --dry-run` and require success.**
- [ ] **Step 4: Review diff for scope creep, idempotency and semantic-conflict preservation.**
- [ ] **Step 5: Update PR with RED/GREEN evidence and merge only after all checks pass.**
- [ ] **Step 6: Run a controlled production artifact-inbox probe after deployment.**
- [ ] **Step 7: Record accepted decision/research in PRJ-0002 through receipt-gated canonical transactions.**

## Self-review

- Spec coverage: retry, idempotence, single-writer, inbox integration, same-project serialization, different-project parallelism, stress, receipt gate and observability are represented.
- Placeholder scan: no deferred implementation placeholders remain.
- Type consistency: request/receipt names, `/artifact`, `/v1/artifacts`, and artifact inbox paths match the design spec.
