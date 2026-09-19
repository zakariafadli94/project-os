# Autonomous Request Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` task by task. Steps use checkbox syntax for tracking.

**Goal:** Make a durable Project OS request finish automatically after a technical interruption, without a user-triggered status read, a new review, or a new request identifier.

**Architecture:** Persist the complete managed-document request in its immutable intent before effects start. ProjectGuard's existing per-project alarm scans bounded pending document intents and receipt finalizations, reuses the original request and admission, and records a terminal receipt only for an observed business conflict or rejection. Reads become pure: a new unified request-status view reports intent, receipt, execution, and recovery state without resuming work.

**Tech Stack:** TypeScript, Cloudflare Durable Objects/SQLite alarms, Dropbox provider persistence, Vitest.

## Global Constraints

- Dropbox remains canonical; no direct human-zone write bypasses.
- Reuse the existing ProjectGuard Durable Object, execution journals, and scheduled maintenance; add no service, queue, dependency, or secret.
- Replay only the exact persisted request identifier and payload; a payload mismatch remains rejected.
- Technical failures retry automatically and never require a new review or Founder acceptance.
- A genuine content/version conflict stays terminal and visible; it is not retried as if it were technical.
- Read endpoints perform no business effect, finalization, or retry.
- Recovery work is bounded per alarm and must not block a separate project.

## Review Focus

- A caller times out after immutable intent creation: the same request is automatically resumed, not resubmitted as a new request.
- A published effect exists but its finalization certificate is absent: the alarm certifies it; a status read only observes.
- A request identifier paired with different bytes remains rejected even when the original request is pending.
- A provider outage keeps the request pending and schedules a retry rather than producing a false rejection or starting a new review.
- A real provider/version conflict becomes a terminal conflict and does not loop indefinitely.

### Task 1: Persist full recoverable document intents

**Files:**
- Modify: `src/documents/request-ledger.ts`
- Modify: `test/managed-document-request.spec.ts`

- [x] Add a red test proving a stored intent exposes the exact original JSON only when its digest matches.
- [x] Run the focused test and confirm it fails because the intent has no payload.
- [x] Add the payload to the immutable intent record, preserve reads of legacy hash-only intents, and expose a parser-safe recovery read.
- [x] Re-run focused tests and commit the isolated change.

### Task 2: Make status observational and expose recovery truth

**Files:**
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: `src/index-neutral.ts`
- Modify: `src/control-tower/mcp.ts`
- Modify: `test/execution-guard.spec.ts`
- Modify: `test/control-tower-artifact.spec.ts`
- Modify: `test/index.spec.ts`

- [x] Add red tests proving execution-status does not finalize a pending execution and request-status distinguishes unknown, pending, committed, finalized, rejected, and conflict.
- [x] Implement a pure internal status response and authenticated public/control-tower forwarding.
- [x] Run focused tests and commit the isolated change.

### Task 3: Resume durable work autonomously

**Files:**
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: `test/project-guard-document.spec.ts`
- Modify: `test/execution-guard.spec.ts`

- [x] Add red tests proving the ProjectGuard alarm resumes a pending document request and finalizes an already-committed document/artifact without a status call.
- [x] Add bounded per-project alarm recovery: rehydrate persisted document intent, execute only the original request, handle terminal conflicts, retry technical failures, and schedule a follow-up while work remains.
- [x] Run focused tests and commit the isolated change.

### Task 4: Prove the integrated contract

**Files:**
- Modify: applicable test files only when an uncovered integration case needs a fixture.

- [x] Add regression coverage for timeout-after-intent, payload mismatch, no-status-side-effect, and independent project recovery.
- [x] Run targeted suites, TypeScript checking, the complete test suite, and a Cloudflare dry-run build.
- [x] Review the net diff for secrets, dependencies, direct canonical writes, and accidental workflow changes; commit only verified changes.
