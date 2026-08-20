# Project OS V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a deterministic Cloudflare Project Guard that accepts typed project transactions, serializes them per project, persists immutable events and revisions, writes canonical Dropbox project files, and emits receipts that ChatGPT can trust.

**Architecture:** A Cloudflare Worker exposes webhook/API endpoints and routes each project mutation to a SQLite-backed Durable Object keyed by `project_id`. The Durable Object owns idempotency, revision checks, typed state transitions, event creation, and receipt state; a Dropbox adapter is the only external persistence boundary for canonical files. Human-facing Markdown is rendered deterministically from structured state.

**Tech Stack:** TypeScript, Cloudflare Workers, SQLite-backed Durable Objects, `wrangler.jsonc`, Vitest 4.1+, `@cloudflare/vitest-pool-workers`, Zod for runtime validation, Dropbox HTTP API, npm.

**Spec:** `docs/superpowers/specs/2026-08-20-project-os-v1-design.md`

## Global Constraints

- One ChatGPT conversation has one primary project binding; one project may be used by many conversations.
- ChatGPT never edits canonical project state directly.
- No generic file mutation operations (`edit_file`, `replace_file`, `delete_file`, `execute_shell`).
- Every durable mutation is a typed transaction with unique `transaction_id` and `base_revision`.
- Every project revision is monotonic and increments only after successful logical commit.
- Every committed mutation creates one immutable event.
- `STATE.md`, `PLAN.md`, `HANDOFF.md`, and `PROJECT_INDEX.md` are deterministic materialized views.
- A committed receipt is the only proof of persistence.
- V1 supports archive, never physical project deletion.
- Secrets never enter GitHub, Obsidian files, event logs, transaction payloads, or receipts.
- New Durable Object storage uses SQLite.
- `wrangler.jsonc` is the Worker configuration source of truth.

---

## File Map

```text
project-os/
├── package.json                         # npm scripts and dependency versions
├── tsconfig.json                        # TypeScript compiler settings
├── wrangler.jsonc                       # Worker + Durable Object binding/export
├── vitest.config.ts                     # Cloudflare Workers Vitest runtime config
├── src/
│   ├── index.ts                         # HTTP entrypoint and routing only
│   ├── env.ts                           # Env binding types
│   ├── durable/
│   │   └── project-guard.ts            # per-project single-writer state machine
│   ├── domain/
│   │   ├── transaction.ts              # transaction schema + operation union
│   │   ├── receipt.ts                  # receipt schema/types
│   │   ├── event.ts                    # immutable event schema/types
│   │   ├── project-state.ts            # structured canonical state types
│   │   └── transitions.ts              # deterministic operation handlers
│   ├── render/
│   │   ├── project.ts                  # PROJECT.md renderer
│   │   ├── state.ts                    # STATE.md renderer
│   │   ├── plan.ts                     # PLAN.md renderer
│   │   ├── handoff.ts                  # HANDOFF.md renderer
│   │   └── decision.ts                 # decision markdown renderer
│   ├── dropbox/
│   │   ├── client.ts                   # typed Dropbox API wrapper
│   │   ├── paths.ts                    # safe canonical path construction
│   │   └── repository.ts               # canonical workspace read/write methods
│   └── webhook/
│       └── dropbox.ts                  # Dropbox webhook challenge + authenticity logic
├── test/
│   ├── transaction.spec.ts
│   ├── transitions.spec.ts
│   ├── project-guard.spec.ts
│   ├── render.spec.ts
│   ├── dropbox-paths.spec.ts
│   └── webhook.spec.ts
└── docs/
    └── deployment.md                    # Cloudflare + Dropbox setup steps
```

---

### Task 1: Runtime scaffold and closed transaction schema

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.jsonc`
- Create: `vitest.config.ts`
- Create: `src/env.ts`
- Create: `src/domain/transaction.ts`
- Test: `test/transaction.spec.ts`

**Interfaces:**
- Consumes: none.
- Produces: `Transaction`, `Operation`, `parseTransaction(input: unknown): Transaction`, `Env`.

- [ ] **Step 1: Write the failing schema tests**

```ts
import { describe, expect, it } from "vitest";
import { parseTransaction } from "../src/domain/transaction";

describe("parseTransaction", () => {
  it("accepts a valid task.complete transaction", () => {
    const tx = parseTransaction({
      schema_version: "1.0",
      transaction_id: "TXN-01J00000000000000000000000",
      project_id: "PRJ-0001",
      base_revision: 4,
      operation: "task.complete",
      created_at: "2026-08-20T18:00:00.000Z",
      payload: { task_id: "TASK-0001" }
    });
    expect(tx.operation).toBe("task.complete");
  });

  it("rejects arbitrary file mutation operations", () => {
    expect(() => parseTransaction({
      schema_version: "1.0",
      transaction_id: "TXN-01J00000000000000000000001",
      project_id: "PRJ-0001",
      base_revision: 4,
      operation: "edit_file",
      created_at: "2026-08-20T18:00:00.000Z",
      payload: { path: "STATE.md", content: "bad" }
    })).toThrow();
  });

  it("rejects unknown envelope fields", () => {
    expect(() => parseTransaction({
      schema_version: "1.0",
      transaction_id: "TXN-01J00000000000000000000002",
      project_id: "PRJ-0001",
      base_revision: 4,
      operation: "research.add",
      created_at: "2026-08-20T18:00:00.000Z",
      payload: { title: "x", body: "y" },
      arbitrary_path: "../../secrets"
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/transaction.spec.ts`
Expected: FAIL because `src/domain/transaction.ts` does not exist.

- [ ] **Step 3: Add package/runtime configuration**

Use these package families:

```json
{
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.16.20",
    "typescript": "^5.9.0",
    "vitest": "^4.1.0",
    "wrangler": "^4.0.0"
  }
}
```

Use `wrangler.jsonc` with a Durable Object binding named `PROJECT_GUARD`, class `ProjectGuard`, and declarative SQLite class export:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "project-os-guard",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-20",
  "durable_objects": {
    "bindings": [
      { "name": "PROJECT_GUARD", "class_name": "ProjectGuard" }
    ]
  },
  "exports": {
    "ProjectGuard": {
      "type": "durable-object",
      "state": "created",
      "storage": "sqlite"
    }
  }
}
```

- [ ] **Step 4: Implement the closed discriminated transaction schema**

`src/domain/transaction.ts` must use `z.strictObject(...)` for the envelope and strict per-operation payload schemas. Define the exact V1 operation union:

```ts
export const operationValues = [
  "project.create", "project.pause", "project.resume", "project.complete", "project.archive",
  "decision.accept", "decision.supersede",
  "task.create", "task.start", "task.complete", "task.block",
  "plan.phase.create", "plan.phase.update", "plan.phase.complete",
  "constraint.add", "research.add",
  "deliverable.add", "deliverable.complete"
] as const;
```

For this task, fully implement payload schemas for `project.create`, `task.create`, `task.complete`, `research.add`; define the remaining operations with their exact required fields so no operation accepts arbitrary path/content keys.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -- test/transaction.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json wrangler.jsonc vitest.config.ts src/env.ts src/domain/transaction.ts test/transaction.spec.ts
git commit -m "feat: scaffold worker and transaction schema"
```

---

### Task 2: Structured project state and deterministic transitions

**Files:**
- Create: `src/domain/project-state.ts`
- Create: `src/domain/event.ts`
- Create: `src/domain/receipt.ts`
- Create: `src/domain/transitions.ts`
- Test: `test/transitions.spec.ts`

**Interfaces:**
- Consumes: `Transaction` from Task 1.
- Produces: `ProjectState`, `DomainEvent`, `Receipt`, `applyTransaction(state, tx): TransitionResult`.

- [ ] **Step 1: Write failing state-transition tests**

```ts
import { describe, expect, it } from "vitest";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";

it("creates a project at revision 1", () => {
  const result = applyTransaction(null, {
    schema_version: "1.0",
    transaction_id: "TXN-01J00000000000000000000010",
    project_id: "PRJ-0001",
    base_revision: 0,
    operation: "project.create",
    created_at: "2026-08-20T18:00:00.000Z",
    payload: { name: "Agency", slug: "agency", aliases: ["agence"], objective: "Launch agency" }
  });
  expect(result.kind).toBe("commit");
  if (result.kind === "commit") expect(result.state.revision).toBe(1);
});

it("rejects completing an unknown task", () => {
  const state = emptyProjectState("PRJ-0001", "Agency", "agency");
  const result = applyTransaction(state, {
    schema_version: "1.0",
    transaction_id: "TXN-01J00000000000000000000011",
    project_id: "PRJ-0001",
    base_revision: state.revision,
    operation: "task.complete",
    created_at: "2026-08-20T18:00:00.000Z",
    payload: { task_id: "TASK-404" }
  });
  expect(result.kind).toBe("rejected");
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- test/transitions.spec.ts`
Expected: FAIL because transition modules do not exist.

- [ ] **Step 3: Implement structured state**

`ProjectState` must contain only structured data: identity, status, revision, aliases, objective, constraints, tasks, plan phases, decisions, research references, deliverables, `last_event_id`, timestamps. Do not store Markdown inside state.

Task statuses: `pending | active | blocked | completed`.
Project statuses: `active | paused | completed | archived`.
Decision statuses: `accepted | superseded`.

- [ ] **Step 4: Implement deterministic transitions**

`applyTransaction` returns exactly one of:

```ts
type TransitionResult =
  | { kind: "commit"; state: ProjectState; event: DomainEvent }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "conflict"; code: string; message: string };
```

Rules to implement in this task:
- `project.create`: requires no existing state and `base_revision === 0`.
- `task.create`: creates unique task ID from payload and rejects duplicates.
- `task.start`: only `pending -> active` or `blocked -> active`.
- `task.complete`: only `pending|active|blocked -> completed`; completed is terminal in V1.
- `task.block`: only non-completed task and requires reason.
- `research.add`: additive and never mutates existing research records.
- every commit increments revision by exactly 1 and creates event revision equal to new state revision.

- [ ] **Step 5: Add stale-revision rules and tests**

Add tests proving:
- stale `research.add` is allowed when its unique research ID is absent;
- stale `decision.accept` returns `conflict`;
- stale `plan.phase.update` returns `conflict`;
- stale independent `task.complete` may commit only when target task current state still satisfies the exact transition precondition.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -- test/transitions.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/project-state.ts src/domain/event.ts src/domain/receipt.ts src/domain/transitions.ts test/transitions.spec.ts
git commit -m "feat: add deterministic project state transitions"
```

---

### Task 3: Safe path construction and deterministic Markdown rendering

**Files:**
- Create: `src/dropbox/paths.ts`
- Create: `src/render/project.ts`
- Create: `src/render/state.ts`
- Create: `src/render/plan.ts`
- Create: `src/render/handoff.ts`
- Create: `src/render/decision.ts`
- Test: `test/dropbox-paths.spec.ts`
- Test: `test/render.spec.ts`

**Interfaces:**
- Consumes: `ProjectState` and `DomainEvent`.
- Produces: `projectRoot(projectId, slug)`, `renderProject`, `renderState`, `renderPlan`, `renderHandoff`, `renderDecision`.

- [ ] **Step 1: Write path traversal tests**

```ts
import { expect, it } from "vitest";
import { projectRoot, assertSafeSlug } from "../src/dropbox/paths";

it("builds a canonical project path", () => {
  expect(projectRoot("PRJ-0001", "agency")).toBe("/PROJECT_OS/PROJECTS/PRJ-0001-agency");
});

it("rejects traversal and separators in slug", () => {
  expect(() => assertSafeSlug("../../secret")).toThrow();
  expect(() => assertSafeSlug("a/b")).toThrow();
});
```

- [ ] **Step 2: Write renderer snapshot-style assertions**

Assert that `renderState` includes revision, current phase, active work, blockers and next actions, and that generated files contain a machine-managed notice.

- [ ] **Step 3: Run tests to confirm failure**

Run: `npm test -- test/dropbox-paths.spec.ts test/render.spec.ts`
Expected: FAIL because files do not exist.

- [ ] **Step 4: Implement safe canonical paths**

Only permit slugs matching `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` and project IDs matching `/^PRJ-[0-9]{4,}$/`. Never accept a transaction-provided raw filesystem path.

- [ ] **Step 5: Implement pure Markdown renderers**

Each renderer must be a pure function from structured state to UTF-8 Markdown. Sort collections deterministically by stable ID. Include canonical links only from IDs/slugs already present in structured state.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -- test/dropbox-paths.spec.ts test/render.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/dropbox/paths.ts src/render test/dropbox-paths.spec.ts test/render.spec.ts
git commit -m "feat: add safe paths and markdown renderers"
```

---

### Task 4: Dropbox adapter with retry-safe repository writes

**Files:**
- Create: `src/dropbox/client.ts`
- Create: `src/dropbox/repository.ts`
- Test: `test/dropbox-repository.spec.ts`

**Interfaces:**
- Consumes: canonical paths and rendered Markdown.
- Produces: `DropboxClient`, `ProjectRepository.writeMaterializedProject(...)`, `writeReceipt(...)`, `writeTerminalTransaction(...)`.

- [ ] **Step 1: Write failing adapter tests with a fake transport**

Create an injectable `DropboxTransport` interface:

```ts
export interface DropboxTransport {
  upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void>;
  download(path: string): Promise<string | null>;
  move(from: string, to: string): Promise<void>;
}
```

Test that the repository:
- writes project views only beneath `/PROJECT_OS/`;
- writes event files in add-only mode;
- writes decision files in add-only mode;
- overwrites materialized views;
- does not generate duplicate event paths for one event ID.

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- test/dropbox-repository.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Dropbox HTTP transport**

Use `fetch` with Dropbox endpoints and bearer token from `Env.DROPBOX_ACCESS_TOKEN`; keep HTTP calls in `client.ts` only. Throw typed errors on non-2xx responses and preserve Dropbox request IDs in error metadata when available.

- [ ] **Step 4: Implement repository-level write ordering**

For a commit, repository methods write immutable/additive artifacts first, materialized views second, and receipt last. Receipt is never written before required canonical writes succeed.

- [ ] **Step 5: Add retry test**

Simulate a transport failure on a materialized view write, retry the same logical commit, and assert immutable event/decision creation is treated as already-existing rather than duplicated while receipt appears only after the successful retry.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -- test/dropbox-repository.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/dropbox/client.ts src/dropbox/repository.ts test/dropbox-repository.spec.ts
git commit -m "feat: add retry-safe Dropbox repository"
```

---

### Task 5: Durable Object single-writer, idempotency, revisions and receipts

**Files:**
- Create: `src/durable/project-guard.ts`
- Test: `test/project-guard.spec.ts`

**Interfaces:**
- Consumes: parsed `Transaction`, `applyTransaction`, `ProjectRepository`.
- Produces: `ProjectGuard extends DurableObject<Env>` and `processTransaction(tx): Promise<Receipt>` through its HTTP `fetch` handler.

- [ ] **Step 1: Write failing Durable Object tests**

Use `env.PROJECT_GUARD.idFromName(projectId)` and a stub to submit transactions. Test:
- project creation commits revision 1;
- replay of the same transaction ID returns the original receipt and leaves revision unchanged;
- two sequential valid task mutations increment revisions monotonically;
- stale L2 transaction returns conflict receipt;
- invalid transition returns rejected receipt.

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- test/project-guard.spec.ts`
Expected: FAIL because `ProjectGuard` does not exist.

- [ ] **Step 3: Implement SQLite-backed state tables**

Initialize these logical tables in Durable Object SQL storage:

```sql
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transactions (transaction_id TEXT PRIMARY KEY, status TEXT NOT NULL, receipt_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_json TEXT NOT NULL);
```

Keep event canonical copies in Dropbox, while the DO transaction ledger provides idempotency and current structured state.

- [ ] **Step 4: Implement transaction processing order**

Inside the object:
1. parse request body;
2. return existing transaction receipt if `transaction_id` exists;
3. load current state;
4. run deterministic transition;
5. for rejected/conflict, persist terminal receipt in DO transaction ledger and Dropbox terminal transaction area;
6. for commit, call Dropbox repository writes;
7. only after required Dropbox writes succeed, persist new structured state and committed receipt in DO storage;
8. return receipt.

- [ ] **Step 5: Add eviction persistence test**

Use Cloudflare test eviction helpers to evict the object, submit another mutation, and prove revision/idempotency state survives eviction.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -- test/project-guard.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/durable/project-guard.ts test/project-guard.spec.ts
git commit -m "feat: add durable single-writer project guard"
```

---

### Task 6: Worker HTTP routing and Dropbox webhook verification

**Files:**
- Create: `src/webhook/dropbox.ts`
- Create: `src/index.ts`
- Test: `test/webhook.spec.ts`
- Test: `test/index.spec.ts`

**Interfaces:**
- Consumes: `Env.PROJECT_GUARD`, Dropbox webhook secret, transaction parser.
- Produces: routes `GET /health`, Dropbox webhook challenge endpoint, and internal transaction processing route.

- [ ] **Step 1: Write webhook tests**

Test:
- Dropbox challenge request returns exact `challenge` body with 200;
- invalid webhook signature returns 401;
- valid signature proceeds;
- `/health` returns `{ "status": "ok" }`;
- malformed transaction request returns 400 without touching any Durable Object.

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- test/webhook.spec.ts test/index.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement constant-time HMAC verification**

Compute the Dropbox webhook signature with `DROPBOX_APP_SECRET` using Web Crypto HMAC-SHA256 over the exact raw request body and compare byte arrays without early exit.

- [ ] **Step 4: Implement Worker routes**

Keep `src/index.ts` thin: validate method/path, verify webhook, discover incoming transaction files as defined by the Dropbox adapter, parse each transaction, map `project_id` to `env.PROJECT_GUARD.idFromName(project_id)`, and forward to the stub.

For direct testability and future integrations, also support authenticated `POST /v1/transactions` using a Cloudflare secret `INGRESS_TOKEN`; this route accepts the same strict transaction schema and never accepts arbitrary file payloads.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -- test/webhook.spec.ts test/index.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/webhook/dropbox.ts src/index.ts test/webhook.spec.ts test/index.spec.ts
git commit -m "feat: add worker routing and Dropbox webhook verification"
```

---

### Task 7: End-to-end operation coverage for V1 domain surface

**Files:**
- Modify: `src/domain/transitions.ts`
- Modify: `src/render/*.ts`
- Modify: `test/transitions.spec.ts`
- Modify: `test/project-guard.spec.ts`
- Modify: `test/render.spec.ts`

**Interfaces:**
- Consumes: operation schemas from Task 1 and state engine from Task 2.
- Produces: complete V1 support for all allowed operations.

- [ ] **Step 1: Add failing tests for project lifecycle**

Cover `project.pause`, `project.resume`, `project.complete`, `project.archive`; reject invalid transitions such as archived -> active in V1.

- [ ] **Step 2: Implement project lifecycle transitions**

Keep lifecycle rules explicit in a transition table and return `rejected` for invalid state changes.

- [ ] **Step 3: Add failing tests for decisions and plan phases**

Cover:
- `decision.accept` creates unique accepted decision;
- `decision.supersede` requires existing accepted decision and preserves old record with `superseded` status;
- `plan.phase.create` unique phase ID;
- `plan.phase.update` only on non-completed phase;
- `plan.phase.complete` terminal completion.

- [ ] **Step 4: Implement decisions and plan phases**

Ensure L2 operations require current revision exactly. No semantic auto-merge.

- [ ] **Step 5: Add failing tests for constraints and deliverables**

Cover `constraint.add`, `deliverable.add`, `deliverable.complete`, duplicate IDs, and invalid completion.

- [ ] **Step 6: Implement constraints and deliverables**

Use stable IDs from payload; reject duplicates instead of silently overwriting.

- [ ] **Step 7: Run full unit/integration suite**

Run: `npm test && npm run typecheck`
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/domain src/render test
git commit -m "feat: complete Project OS V1 operation surface"
```

---

### Task 8: Deployment documentation, production safety checks and final verification

**Files:**
- Create: `docs/deployment.md`
- Create: `.gitignore`
- Create: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: complete Worker code.
- Produces: reproducible setup and deployment procedure.

- [ ] **Step 1: Add CI-quality scripts**

`package.json` must include:

```json
{
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm test",
    "deploy": "wrangler deploy"
  }
}
```

- [ ] **Step 2: Write deployment documentation with exact secret names**

Document these Cloudflare secrets only:

```text
DROPBOX_ACCESS_TOKEN
DROPBOX_APP_SECRET
INGRESS_TOKEN
```

Document GitHub -> Cloudflare Workers Builds connection, `main` production branch, build command `npm ci && npm run check`, deploy command `npm run deploy`, and the Dropbox webhook URL once the Worker hostname exists.

- [ ] **Step 3: Document Dropbox folder bootstrap**

The first successful `project.create` must be able to create the required `/PROJECT_OS/...` tree lazily; no user-created empty folder hierarchy is required beyond Dropbox account/app authorization.

- [ ] **Step 4: Run final verification**

Run locally/CI:

```bash
npm ci
npm run check
npx wrangler deploy --dry-run
```

Expected:
- typecheck PASS;
- all tests PASS;
- Wrangler validates configuration and bundles successfully.

- [ ] **Step 5: Perform explicit stress tests**

Automated suite must demonstrate:
- duplicate transaction replay commits once;
- stale additive transaction can safely apply by rule;
- stale L2 transaction conflicts;
- Durable Object eviction preserves state;
- Dropbox write retry never yields a false committed receipt;
- corrupt materialized Markdown can be regenerated from structured state;
- path traversal is rejected;
- malformed/forbidden operation never reaches transition application.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/deployment.md .gitignore package.json
git commit -m "docs: add deployment and verification guide"
```

---

## Plan Self-Review

### Spec coverage

- Typed operations and forbidden generic writes: Tasks 1 and 7.
- Deterministic transitions and risk classes: Tasks 2 and 7.
- Single-writer concurrency and Durable Object persistence: Task 5.
- Idempotency and monotonic revisioning: Tasks 2 and 5.
- Immutable events and receipts: Tasks 2, 4, and 5.
- Rebuildable Markdown views: Task 3.
- Dropbox integration and retry safety: Task 4.
- Webhook authenticity: Task 6.
- Security/path constraints: Tasks 1, 3, 4, and 6.
- Cloudflare deployment: Task 8.
- Stress tests from design definition-of-done: Tasks 5, 7, and 8.

### Placeholder scan

No `TBD`, `TODO`, unspecified generic error-handling steps, or undefined future implementation steps remain.

### Type consistency

The plan consistently uses `Transaction`, `ProjectState`, `DomainEvent`, `Receipt`, `TransitionResult`, `DropboxTransport`, `ProjectRepository`, and `ProjectGuard` with their defining task identified before first consumption.
