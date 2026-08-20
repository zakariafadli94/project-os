# Project OS V1 — Design Specification

Date: 2026-08-20
Status: proposed for implementation

## 1. Goal

Build a robust, reusable project operating system for ChatGPT conversations where:

- one ChatGPT Project can manage many business/software projects;
- each conversation binds to one primary project;
- project context is pulled automatically when needed;
- durable changes are synchronized automatically without user commands such as PULL/PUSH;
- the canonical project state lives outside ChatGPT;
- Obsidian remains the human-readable workspace;
- a deterministic Project Guard prevents LLM drift from corrupting canonical state.

The user should work naturally in ChatGPT and should not need to write code or operate infrastructure in daily use.

## 2. Architecture

```text
ChatGPT Project: Project OS
        |
        | creates typed transaction files
        v
Dropbox / PROJECT_OS / TRANSACTIONS / incoming
        |
        | Dropbox change notification / webhook
        v
Cloudflare Worker
        |
        v
Project Durable Object (one logical instance per project_id)
        |
        | deterministic validation + serialization
        v
Dropbox canonical workspace
        |
        v
Obsidian Vault on Mac
```

GitHub (`zakariafadli94/project-os`) is the source repository for the Project Guard code and deployment configuration.

Cloudflare Workers Builds is the deployment path. The Worker is connected to the GitHub repository and production deploys are triggered from pushes to `main`.

## 3. Core invariants

1. ChatGPT never directly edits canonical project state files.
2. Every durable mutation is expressed as a typed transaction.
3. Only the Project Guard may logically commit canonical state mutations.
4. Every transaction has a unique idempotency key / transaction ID.
5. Every project has a monotonic revision number.
6. Every committed mutation produces an immutable event.
7. Generated Markdown views can be rebuilt from structured canonical state and events.
8. A transaction is successful only after a committed receipt exists.
9. Destructive deletion is not supported in V1; archival is used instead.
10. One conversation has one primary bound project; one project may be used by many conversations.

## 4. Project routing and session behavior

### Existing project

When the user refers to an existing project, ChatGPT resolves it against the project registry using exact name, aliases, and project ID. It then reads the minimum context required for the task, starting from `HANDOFF.md` and `STATE.md`.

### New project

When the user clearly starts a new project, ChatGPT may gather context progressively. Once the initiative is sufficiently real to persist, it emits `project.create`. Project Guard allocates the project ID, canonical slug, folder, manifest, initial state, registry entry, and receipt.

### Ambiguous project

If multiple projects plausibly match, ChatGPT must ask the user which project is intended. It must not guess silently.

### Old conversation resumed

Conversation history is treated as potentially stale. Before a durable write, ChatGPT refreshes the relevant canonical project revision and state.

## 5. Canonical Dropbox layout

```text
PROJECT_OS/
├── SYSTEM/
│   ├── PROJECT_REGISTRY.json
│   ├── PROJECT_INDEX.md
│   └── SOP.md
├── PROJECTS/
│   └── PRJ-xxxx-<slug>/
│       ├── PROJECT.md
│       ├── STATE.md
│       ├── PLAN.md
│       ├── HANDOFF.md
│       ├── DECISIONS/
│       ├── RESEARCH/
│       ├── DELIVERABLES/
│       └── .system/
│           ├── manifest.json
│           ├── events/
│           └── snapshots/
├── TRANSACTIONS/
│   ├── incoming/
│   ├── committed/
│   ├── rejected/
│   └── conflicts/
└── RECEIPTS/
```

`PROJECT_REGISTRY.json`, project manifests, events, and structured records are machine authority. Markdown files are human-readable materialized views.

## 6. Project manifest

Each project has `.system/manifest.json` containing at minimum:

```json
{
  "schema_version": "1.0",
  "project_id": "PRJ-0001",
  "slug": "example-project",
  "revision": 0,
  "status": "active",
  "last_event_id": null,
  "updated_at": "2026-08-20T00:00:00Z"
}
```

The revision is incremented only after a transaction commits successfully.

## 7. Transaction contract

Every transaction uses a strict JSON schema.

Minimum envelope:

```json
{
  "schema_version": "1.0",
  "transaction_id": "TXN-<unique-id>",
  "project_id": "PRJ-0001",
  "base_revision": 12,
  "operation": "task.complete",
  "created_at": "2026-08-20T00:00:00Z",
  "payload": {}
}
```

Forbidden generic operations include:

- `edit_file`
- `replace_file`
- `delete_file`
- `execute_shell`
- arbitrary filesystem writes

ChatGPT expresses business intent, not file patches.

## 8. Allowed V1 operations

V1 intentionally keeps the operation surface small.

### Project
- `project.create`
- `project.pause`
- `project.resume`
- `project.complete`
- `project.archive`

### Decisions
- `decision.accept`
- `decision.supersede`

### Tasks
- `task.create`
- `task.start`
- `task.complete`
- `task.block`

### Plan
- `plan.phase.create`
- `plan.phase.update`
- `plan.phase.complete`

### Context / knowledge
- `constraint.add`
- `research.add`

### Deliverables
- `deliverable.add`
- `deliverable.complete`

Additional operations require a schema/version change and tests before deployment.

## 9. Operation risk classes

### L0 — additive, low-risk
Examples: `research.add`, `constraint.add`.

May be accepted with stale base revision when the operation is demonstrably commutative and all preconditions still hold.

### L1 — operational state
Examples: task and deliverable transitions.

Require target existence and valid state transition. Compatible stale revisions may be accepted only by deterministic rules.

### L2 — direction-changing
Examples: decisions, plan changes, project completion/archive.

Require current revision compatibility and stronger preconditions. Project Guard never asks an LLM to merge conflicting L2 mutations.

## 10. Concurrency and Durable Objects

Each `project_id` maps deterministically to one Durable Object identity.

The Durable Object is the serialization boundary for that project. It maintains project mutation coordination and persistent structured state using the SQLite-backed Durable Object storage model.

Multiple ChatGPT conversations may submit transactions concurrently. The Guard processes each project’s mutations in order and applies revision checks before commit.

Cloudflare Durable Objects are chosen specifically because they provide stateful coordination with a globally unique, single-threaded object instance and persistent storage.

## 11. Idempotency

Before applying a transaction, the Guard checks whether `transaction_id` was previously processed.

If already committed, it returns/recreates the existing successful receipt without applying the mutation again.

If previously rejected/conflicted, it returns the existing terminal outcome unless a new transaction ID is submitted.

Retries therefore do not duplicate state changes.

## 12. Conflict rules

Project Guard never performs semantic LLM conflict resolution.

Examples:

- two additive research notes: can both commit;
- two independent task completions: can both commit if task state allows it;
- contradictory accepted pricing decisions: conflict;
- competing plan direction changes from stale bases: conflict.

Conflict output is persisted under `TRANSACTIONS/conflicts/` and represented by a receipt with `status: conflict`.

The user resolves true direction conflicts in ChatGPT, which emits a new transaction.

## 13. Atomic commit behavior

A mutation follows this logical sequence:

1. Validate JSON schema.
2. Validate operation-specific payload.
3. Resolve project / create project if appropriate.
4. Enter per-project serialization boundary.
5. Check idempotency.
6. Check revision and preconditions.
7. Compute new structured state in memory/storage.
8. Create immutable event.
9. Render affected Markdown views.
10. Write canonical Dropbox changes.
11. Persist new revision and terminal transaction result.
12. Write receipt.

If a required write fails before finalization, the transaction must not be reported as committed. Recovery logic must be retry-safe.

V1 does not claim cross-provider distributed transactions are mathematically atomic; instead it uses idempotency, per-project serialization, explicit commit receipts, immutable events, and rebuildable views to make retries and recovery deterministic.

## 14. Events

Every committed transaction creates one immutable event record, for example:

```json
{
  "event_id": "EVT-000013",
  "project_id": "PRJ-0001",
  "revision": 13,
  "transaction_id": "TXN-...",
  "type": "decision.accepted",
  "timestamp": "2026-08-20T00:00:00Z",
  "payload": {}
}
```

Old events are never edited or deleted in V1.

## 15. Receipts

A transaction receipt is the only proof ChatGPT may use to claim persistence.

Example:

```json
{
  "transaction_id": "TXN-...",
  "status": "committed",
  "project_id": "PRJ-0001",
  "previous_revision": 12,
  "new_revision": 13,
  "event_id": "EVT-000013",
  "committed_at": "2026-08-20T00:00:00Z"
}
```

Other terminal statuses:

- `rejected`
- `conflict`

No receipt or a non-committed receipt means ChatGPT must not say the state was saved.

## 16. Markdown rendering

Human-facing files are deterministic renderings from structured project state.

### `PROJECT.md`
Stable identity, objectives, scope, success criteria, stakeholders and durable constraints.

### `STATE.md`
Current phase, active work, completed work, blockers, immediate next actions, current revision.

### `PLAN.md`
Validated phases, milestones, dependencies and progress.

### `HANDOFF.md`
Compact context for a fresh ChatGPT conversation: objective, current state, recent durable changes, important decisions, blockers, next work and relevant deeper files.

### `DECISIONS/DEC-xxxx.md`
One durable decision per file. Superseded decisions remain preserved and linked.

Generated files carry a notice that machine-managed sections must not be manually edited unless the eventual human-edit workflow explicitly supports it.

## 17. Dropbox responsibilities

Dropbox provides:

- the canonical synchronized filesystem visible to ChatGPT and Obsidian;
- transaction ingress files;
- canonical Markdown views;
- receipts and conflict/rejection files;
- synchronization to the user’s Mac.

Project Guard uses a dedicated Dropbox application credential with the smallest practical scope. Secrets are stored in Cloudflare, never committed to GitHub and never pasted into ChatGPT conversations.

## 18. Cloudflare deployment

Repository: `zakariafadli94/project-os`

Runtime:

- Cloudflare Worker for webhook/API endpoints and routing;
- SQLite-backed Durable Object class for per-project coordination and state;
- Workers Builds connected to GitHub;
- `main` is the production branch;
- deploy command defaults to Wrangler deployment unless configuration requires otherwise.

Cloudflare’s current Workers Git integration supports automatic deployment from GitHub pushes. Workers using Durable Objects do not receive normal preview URLs, so correctness relies primarily on automated tests plus staged deployment/version checks rather than preview-URL testing.

The design targets Cloudflare Workers Free where practical. SQLite-backed Durable Objects are available on the Free plan. Free-tier limits are treated as operational limits, not as contractual guarantees; deployment docs should describe how to detect quota errors.

## 19. GitHub workflow

V1 development workflow:

1. changes are authored in GitHub repository;
2. tests run before production promotion;
3. production code lands on `main` only after tests pass;
4. Cloudflare Workers Builds deploys `main` automatically once connected.

The repository contains no Dropbox secrets or Cloudflare secrets.

## 20. Security model

- Dropbox credentials live only in Cloudflare secrets.
- Webhook verification is required.
- Incoming transaction schema is closed: unknown fields/operations are rejected where practical.
- Path construction never accepts arbitrary user-provided filesystem paths.
- Project IDs/slugs are normalized by the Guard.
- No shell execution.
- No arbitrary URL fetching from transactions.
- No physical delete operation in V1.
- Sensitive credentials must never be written into Obsidian project files, transaction payloads, event logs or receipts.

## 21. Failure and recovery model

### Duplicate delivery
Idempotency returns the existing terminal result.

### Invalid transaction
Move/record as rejected and emit rejected receipt.

### Stale transaction
Apply only if deterministic compatibility rules explicitly allow it; otherwise conflict.

### Dropbox write failure
Do not claim committed. Retry safely using the same transaction ID.

### Worker restart
Durable state and transaction ledger permit retry.

### Corrupted generated Markdown
Rebuild materialized views from structured state/events.

### Old ChatGPT conversation
Refresh canonical state before durable mutations.

## 22. Testing requirements

Implementation must be test-driven for core state transitions.

Minimum automated tests:

- valid project creation;
- duplicate project detection;
- duplicate transaction idempotency;
- invalid schema rejection;
- forbidden operation rejection;
- missing project rejection;
- monotonic revision increments;
- valid task state transitions;
- invalid task transitions rejected;
- stale compatible additive mutation;
- stale incompatible L2 conflict;
- decision supersession preserves history;
- generated `STATE.md` rebuild;
- generated `HANDOFF.md` rebuild;
- Dropbox write retry does not double-commit;
- receipt is emitted only after successful logical commit;
- webhook authenticity validation;
- path traversal attempts rejected.

## 23. V1 non-goals

Explicitly excluded from V1:

- Temporal;
- autonomous background agents;
- vector database / embeddings;
- custom web dashboard;
- multi-user RBAC;
- arbitrary human edits to machine-managed Markdown with two-way reconciliation;
- arbitrary code execution;
- project deletion;
- complex semantic auto-merge;
- API-based LLM inference inside Project Guard.

## 24. Definition of done

V1 is ready for a pilot when all of the following are true:

1. GitHub repository contains tested Worker/Durable Object code.
2. Cloudflare is connected to GitHub and `main` deploys successfully.
3. Dropbox app credentials are configured as Cloudflare secrets.
4. Dropbox webhook reaches the Worker and is verified.
5. `project.create` can create a complete canonical project workspace.
6. At least one decision and one task transition commit end-to-end.
7. Receipts are returned/persisted correctly.
8. Duplicate transaction replay is harmless.
9. Concurrent/conflicting transaction tests behave deterministically.
10. Obsidian sees the resulting Markdown through Dropbox sync.
11. A new ChatGPT conversation can recover project context from `HANDOFF.md` + `STATE.md` without relying on old conversation memory.

## 25. Implementation principle

Use LLM intelligence only to understand user intent and formulate typed operations.

Use deterministic software to validate, serialize, persist, version, render and recover project state.

The system is designed under the assumption that the LLM will eventually make a mistake; the Project Guard must make that mistake rejectable, isolated or recoverable rather than destructive.
