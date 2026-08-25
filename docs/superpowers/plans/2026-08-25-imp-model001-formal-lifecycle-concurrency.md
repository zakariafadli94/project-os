# IMP-MODEL001 Formal Lifecycle and Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: proposed for user review. This document is not runtime implementation authorization until the user explicitly approves it and the corresponding Project OS implementation-authorization decision is committed.

**Goal:** Implement the approved schema-1.0-compatible Project OS lifecycle and concurrency contract so stale lifecycle/direction mutations conflict deterministically, phase progression is coherent, new governed references are valid, and historical state remains readable without a schema migration.

**Architecture:** Keep ProjectGuard as the existing per-project serialization boundary and keep persisted `ProjectState 1.0` unchanged. Move stale-rebase classification into one small fail-closed domain policy, enforce lifecycle/reference invariants in the pure transition layer, and prove behavior at both pure-domain and ProjectGuard receipt boundaries. Historical compatibility remains a reader concern: old structurally valid snapshots stay loadable, while stricter rules govern new mutations.

**Tech Stack:** TypeScript 5.9, Vitest 4.1, Cloudflare Workers + SQLite Durable Objects, Zod 4.4, Wrangler 4.124, Dropbox persistence.

**Spec:** `docs/superpowers/specs/2026-08-25-imp-model001-formal-lifecycle-concurrency-design.md`

## Global Constraints

- Implementation baseline is GitHub `main` commit `820030be0f775aa89689a4bdb56ac6495e21dfe1`; refresh `main` immediately before execution and stop for revalidation if it changed materially.
- Canonical design baseline is PRJ-0002 revision `89`, `RES-IMPMODELDESIGN001`, and accepted `DEC-IMPMODELDESIGN001`.
- `ProjectState.schema_version` remains exactly `1.0`; do not add persisted fields, operations, payload members, upcasters, migrations, dependency graphs, per-entity revisions, or research statuses.
- Do not modify `src/domain/project-state.ts` or `src/domain/transaction.ts` unless a failing test proves an implementation necessity that is still schema-compatible; if either persisted shape must change, stop and return to the SCHEMA gate instead of proceeding.
- `PROJECT_OS_CONTINUITY_MODE` remains `stable`.
- `PROJECT_OS_MUTATION_GATE_MODE` remains `observe`; this plan never authorizes `enforce`.
- Do not repair, adopt, reject, move, overwrite, or otherwise mutate historical PRJ-0003 deviations as part of MODEL001.
- Do not implement IMP-SCHEMA001 runtime behavior.
- No new distributed lock, queue, or persistence coordinator; ProjectGuard remains the per-project serialization boundary.
- New lifecycle behavior must be introduced with strict RED -> GREEN -> REFACTOR TDD. Never write production behavior before watching its dedicated test fail for the expected reason.
- Historical schema-1.0 snapshots that satisfy the existing normalizer remain readable even if their lifecycle combination would not be newly created after MODEL001.
- Approval of this plan authorizes only an isolated implementation/test/documentation branch after the canonical implementation-authorization receipt commits. It does **not** authorize runtime PR merge or production deployment; those remain a later explicit gate after exact-head verification.

---

## Gate 0: Record implementation authorization and isolate execution

**Files:**
- Existing review branch: `docs/imp-model001-design`
- Documentation PR: `#39`
- Future implementation branch: `imp/model001-lifecycle-concurrency`

**Interfaces:**
- Consumes: approved spec, this approved plan, canonical PRJ-0002 current revision.
- Produces: committed `DEC-IMPMODELIMPL001`, merged documentation checkpoint, isolated implementation branch/worktree based on the refreshed post-documentation `main`.

- [ ] **Step 1: Re-read the execution-isolation skill before any source edit**

Read `superpowers:using-git-worktrees` at execution time and follow it before changing runtime code.

- [ ] **Step 2: Refresh canonical PRJ-0002 and GitHub main**

Verify `TASK-IMPMODEL001` is still active and `DEC-IMPMODELDESIGN001` is accepted. Verify PR #39 still contains documentation only and revalidate any new `main` commits against this plan.

- [ ] **Step 3: Commit the implementation-authorization decision through Project OS**

Use a fresh typed `decision.accept` transaction with the then-current PRJ-0002 revision:

```json
{
  "operation": "decision.accept",
  "payload": {
    "decision_id": "DEC-IMPMODELIMPL001",
    "title": "Authorize IMP-MODEL001 isolated TDD implementation",
    "decision": "Authorize implementation of the approved IMP-MODEL001 specification and TDD plan on an isolated branch after the documentation checkpoint is merged. This authorization covers source changes, tests, documentation and creation of an implementation PR only. It does not authorize merging the runtime PR, production deployment, MutationGate enforce, PRJ-0003 repair, or IMP-SCHEMA001 runtime.",
    "reason": "The written design and implementation plan were separately reviewed and approved before runtime changes.",
    "impacts": [
      "Implement MODEL001 strictly with RED-GREEN-REFACTOR.",
      "Keep ProjectState and Transaction persisted schemas at 1.0.",
      "Require a separate merge/deployment approval after exact-head verification.",
      "Keep MutationGate observe and leave PRJ-0003 and SCHEMA runtime untouched."
    ]
  }
}
```

Do not continue until its receipt is `committed`.

- [ ] **Step 4: Merge the approved documentation checkpoint and create isolated implementation work**

After explicit plan approval and the committed implementation-authorization decision, merge PR #39, refresh `main`, then create `imp/model001-lifecycle-concurrency` from that exact `main`. Do not place runtime changes into PR #39.

---

### Task 1: Make stale-rebase policy explicit and fail closed

**Files:**
- Create: `src/domain/concurrency-policy.ts`
- Modify: `src/domain/transitions.ts`
- Modify: `test/transitions.spec.ts`

**Interfaces:**
- Consumes: `Transaction["operation"]` from `src/domain/transaction.ts`.
- Produces: `mayRebaseStaleOperation(operation: Transaction["operation"]): boolean`, used by `applyTransaction` before cloning/mutating current state.

- [ ] **Step 1: Replace the existing stale-task expectation with failing exact-current tests**

In `test/transitions.spec.ts`, remove the test that currently expects stale task completion to commit. Add tests that construct a valid target state, advance only the project revision to simulate an unrelated intervening commit, and assert stale lifecycle writes conflict:

```ts
it("returns conflict for stale task lifecycle mutations", () => {
  let state = emptyProjectState("PRJ-0001", "Agency", "agency");
  const created = applyTransaction(state, tx({
    operation: "task.create",
    payload: { task_id: "TASK-0001", title: "Launch" }
  }));
  if (created.kind !== "commit") throw new Error("setup failed");

  const concurrent = { ...created.state, revision: created.state.revision + 1 };
  for (const operation of ["task.start", "task.block", "task.complete"] as const) {
    const payload = operation === "task.block"
      ? { task_id: "TASK-0001", reason: "Blocked" }
      : { task_id: "TASK-0001" };
    const result = applyTransaction(concurrent, tx({
      base_revision: created.state.revision,
      operation,
      payload
    } as never));
    expect(result).toMatchObject({ kind: "conflict", code: "STALE_REVISION" });
  }
});

it("returns conflict for stale legacy deliverable completion", () => {
  let state = emptyProjectState("PRJ-0001", "Agency", "agency");
  const created = applyTransaction(state, tx({
    operation: "deliverable.add",
    payload: { deliverable_id: "DEL-0001", title: "Legacy" }
  }));
  if (created.kind !== "commit") throw new Error("setup failed");
  const concurrent = { ...created.state, revision: created.state.revision + 1 };
  const result = applyTransaction(concurrent, tx({
    base_revision: created.state.revision,
    operation: "deliverable.complete",
    payload: { deliverable_id: "DEL-0001", outcome: "Done" }
  }));
  expect(result).toMatchObject({ kind: "conflict", code: "STALE_REVISION" });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run test/transitions.spec.ts
```

Expected: the new stale task lifecycle and stale `deliverable.complete` assertions fail because current `applyTransaction` still permits those stale operations.

- [ ] **Step 3: Add the fail-closed concurrency policy**

Create `src/domain/concurrency-policy.ts`:

```ts
import type { Transaction } from "./transaction";

const staleRebasableOperations = new Set<Transaction["operation"]>([
  "research.add",
  "constraint.add",
  "task.create",
  "deliverable.add"
]);

export function mayRebaseStaleOperation(operation: Transaction["operation"]): boolean {
  return staleRebasableOperations.has(operation);
}
```

This intentionally makes every existing or future operation exact-current unless it is explicitly added to the narrow additive allow-list.

- [ ] **Step 4: Wire the policy into `applyTransaction`**

In `src/domain/transitions.ts`, import the helper, delete `exactRevisionOperations`, and replace:

```ts
if (stale && exactRevisionOperations.has(tx.operation)) {
```

with:

```ts
if (stale && !mayRebaseStaleOperation(tx.operation)) {
  return conflict("STALE_REVISION", `${tx.operation} requires the current project revision`);
}
```

Keep `project.create`, `REVISION_AHEAD`, archived/completed project guards and transaction ordering unchanged.

- [ ] **Step 5: Verify GREEN and preserve additive stale behavior**

Run:

```bash
npx vitest run test/transitions.spec.ts
```

Expected: all tests pass, including the existing stale `research.add` commit case and stale `decision.accept` conflict case.

- [ ] **Step 6: Commit the task**

```bash
git add src/domain/concurrency-policy.ts src/domain/transitions.ts test/transitions.spec.ts
git commit -m "feat: formalize MODEL001 concurrency policy"
```

---

### Task 2: Lock the complete task lifecycle matrix

**Files:**
- Modify: `test/operations.spec.ts`

**Interfaces:**
- Consumes: existing task transition behavior in `applyTransaction` plus Task 1 exact-current policy.
- Produces: executable characterization of every approved task transition, including blocked-reason refresh and terminal completion.

- [ ] **Step 1: Add the approved task transition matrix**

Add a dedicated `describe("MODEL001 task lifecycle", ...)` section with explicit cases:

```ts
it("supports the approved task lifecycle without a mandatory start", () => {
  let state = emptyProjectState("PRJ-2301", "Tasks", "tasks");
  state = commit(state, tx(state.project_id, state.revision, "task.create", {
    task_id: "TASK-2301", title: "Direct completion"
  }));
  state = commit(state, tx(state.project_id, state.revision, "task.complete", {
    task_id: "TASK-2301", result: "Done naturally"
  }));
  expect(state.tasks["TASK-2301"].status).toBe("completed");
});

it("supports pending to blocked, blocked reason refresh, blocked to active and active to completed", () => {
  let state = emptyProjectState("PRJ-2302", "Tasks", "tasks");
  state = commit(state, tx(state.project_id, state.revision, "task.create", {
    task_id: "TASK-2302", title: "Recoverable task"
  }));
  state = commit(state, tx(state.project_id, state.revision, "task.block", {
    task_id: "TASK-2302", reason: "First blocker"
  }));
  state = commit(state, tx(state.project_id, state.revision, "task.block", {
    task_id: "TASK-2302", reason: "Updated blocker"
  }));
  expect(state.tasks["TASK-2302"].blocked_reason).toBe("Updated blocker");
  state = commit(state, tx(state.project_id, state.revision, "task.start", {
    task_id: "TASK-2302"
  }));
  expect(state.tasks["TASK-2302"].blocked_reason).toBeUndefined();
  state = commit(state, tx(state.project_id, state.revision, "task.complete", {
    task_id: "TASK-2302"
  }));
  expect(state.tasks["TASK-2302"].status).toBe("completed");
});

it("keeps completed tasks terminal", () => {
  let state = emptyProjectState("PRJ-2303", "Tasks", "tasks");
  state = commit(state, tx(state.project_id, state.revision, "task.create", {
    task_id: "TASK-2303", title: "Terminal"
  }));
  state = commit(state, tx(state.project_id, state.revision, "task.complete", {
    task_id: "TASK-2303"
  }));
  expect(applyTransaction(state, tx(state.project_id, state.revision, "task.start", {
    task_id: "TASK-2303"
  })).kind).toBe("rejected");
  expect(applyTransaction(state, tx(state.project_id, state.revision, "task.block", {
    task_id: "TASK-2303", reason: "No"
  })).kind).toBe("rejected");
});
```

- [ ] **Step 2: Run the focused characterization suite**

```bash
npx vitest run test/operations.spec.ts
```

Expected: PASS. These tests freeze approved existing behavior rather than adding a new persisted state.

- [ ] **Step 3: Commit the characterization tests**

```bash
git add test/operations.spec.ts
git commit -m "test: lock MODEL001 task lifecycle matrix"
```

---

### Task 3: Enforce coherent phase progression and phase attachment rules

**Files:**
- Create: `test/model-phase-lifecycle.spec.ts`
- Modify: `src/domain/transitions.ts`

**Interfaces:**
- Consumes: `ProjectState.plan_phases`, `current_phase_id`, `task.create`, `deliverable.create`, `plan.phase.complete`.
- Produces: exact-current phase completion that only closes the single active/current phase, deterministic lexicographic promotion, and completed-phase attachment rejection.

- [ ] **Step 1: Write failing pending/non-current completion tests**

Create `test/model-phase-lifecycle.spec.ts` with the same deterministic transaction helper pattern as `test/operations.spec.ts`. Add:

```ts
it("rejects completion of a pending non-current phase", () => {
  let state = emptyProjectState("PRJ-2401", "Phases", "phases");
  state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
    phase_id: "PHASE-2401", title: "Current"
  }));
  state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
    phase_id: "PHASE-2402", title: "Later"
  }));
  const result = applyTransaction(state, tx(state.project_id, state.revision, "plan.phase.complete", {
    phase_id: "PHASE-2402"
  }));
  expect(result).toMatchObject({ kind: "rejected", code: "PHASE_NOT_CURRENT" });
  expect(state.current_phase_id).toBe("PHASE-2401");
  expect(state.plan_phases["PHASE-2401"].status).toBe("active");
});
```

Add a second failing case that injects a second historical `active` phase while `current_phase_id` points to the target and expects `PHASE_STATE_INCONSISTENT` rather than a transition that leaves multiple active phases.

- [ ] **Step 2: Run the phase tests and verify RED**

```bash
npx vitest run test/model-phase-lifecycle.spec.ts
```

Expected: pending completion currently commits, so the first test fails for the expected reason.

- [ ] **Step 3: Implement active/current completion guards**

In `plan.phase.complete`, after locating the phase and before mutating it, add:

```ts
if (phase.status !== "active" || next.current_phase_id !== phase.phase_id) {
  return rejected("PHASE_NOT_CURRENT", `Only current active phase ${next.current_phase_id ?? "<none>"} can be completed`);
}
const otherActive = Object.values(next.plan_phases).find(
  (candidate) => candidate.status === "active" && candidate.phase_id !== phase.phase_id
);
if (otherActive) {
  return rejected("PHASE_STATE_INCONSISTENT", `Multiple active phases include ${phase.phase_id} and ${otherActive.phase_id}`);
}
```

Keep deterministic promotion, but make the compatibility rule explicit:

```ts
const nextPhase = Object.values(next.plan_phases)
  .filter((candidate) => candidate.status === "pending")
  .sort((a, b) => a.phase_id.localeCompare(b.phase_id))[0];
```

- [ ] **Step 4: Add RED tests for completed-phase attachments**

Add tests that first complete `PHASE-2401`, then attempt:

```ts
applyTransaction(state, tx(state.project_id, state.revision, "task.create", {
  task_id: "TASK-2401", title: "Too late", phase_id: "PHASE-2401"
}));
```

and:

```ts
applyTransaction(state, tx(state.project_id, state.revision, "deliverable.create", {
  deliverable_id: "DEL-2401", title: "Too late", version: "v1", phase_id: "PHASE-2401"
}));
```

Both must be `rejected` with `PHASE_COMPLETED`.

Run the focused file and verify these new tests fail before production changes.

- [ ] **Step 5: Reject new work attachment to completed phases**

In `task.create`, replace the one-line phase existence check with:

```ts
if (p.phase_id) {
  const phase = next.plan_phases[p.phase_id];
  if (!phase) return rejected("PHASE_NOT_FOUND", `Phase ${p.phase_id} does not exist`);
  if (phase.status === "completed") return rejected("PHASE_COMPLETED", `Completed phase ${p.phase_id} is terminal`);
}
```

Apply the same existence/completed check to normative `deliverable.create`.

- [ ] **Step 6: Add deterministic progression and no-inferred-child-gate coverage**

Add passing characterization cases that:

1. create active `PHASE-2403`, then pending `PHASE-2405`, then pending `PHASE-2404`;
2. complete `PHASE-2403` and assert `PHASE-2404` is promoted first;
3. complete the last active phase and assert `current_phase_id === null` when no pending phase remains;
4. attach a still-pending task and planned deliverable to the current phase, complete the phase, and assert phase completion commits without fabricating child completion.

- [ ] **Step 7: Verify GREEN**

```bash
npx vitest run test/model-phase-lifecycle.spec.ts test/operations.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the task**

```bash
git add src/domain/transitions.ts test/model-phase-lifecycle.spec.ts
git commit -m "feat: enforce MODEL001 phase invariants"
```

---

### Task 4: Require currently accepted decisions for new governed deliverables

**Files:**
- Modify: `src/domain/transitions.ts`
- Modify: `test/operations.spec.ts`

**Interfaces:**
- Consumes: `ProjectState.decisions[*].status` and `deliverable.create.payload.decision_ids`.
- Produces: new normative deliverables can only claim governance from decisions currently in `accepted` state; superseded decisions remain historical but cannot newly govern.

- [ ] **Step 1: Write the failing superseded-decision reference test**

Add to the deliverable lifecycle section:

```ts
it("rejects a superseded governing decision on new deliverables", () => {
  let state = emptyProjectState("PRJ-2501", "Governance", "governance");
  state = commit(state, tx(state.project_id, state.revision, "decision.accept", {
    decision_id: "DEC-2501", title: "Old", decision: "Old rule", reason: "Initial", impacts: []
  }));
  state = commit(state, tx(state.project_id, state.revision, "decision.accept", {
    decision_id: "DEC-2502", title: "New", decision: "New rule", reason: "Replacement", impacts: []
  }));
  state = commit(state, tx(state.project_id, state.revision, "decision.supersede", {
    decision_id: "DEC-2501", replacement_decision_id: "DEC-2502", reason: "Replaced"
  }));

  const rejected = applyTransaction(state, tx(state.project_id, state.revision, "deliverable.create", {
    deliverable_id: "DEL-2501", title: "Bad governance", version: "v1", decision_ids: ["DEC-2501"]
  }));
  expect(rejected).toMatchObject({ kind: "rejected", code: "DELIVERABLE_DECISION_NOT_ACCEPTED" });

  const accepted = applyTransaction(state, tx(state.project_id, state.revision, "deliverable.create", {
    deliverable_id: "DEL-2502", title: "Current governance", version: "v1", decision_ids: ["DEC-2502"]
  }));
  expect(accepted.kind).toBe("commit");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npx vitest run test/operations.spec.ts
```

Expected: the superseded-decision case currently commits because the runtime checks existence only.

- [ ] **Step 3: Implement accepted-status validation**

In `deliverable.create`, replace the current decision loop with:

```ts
for (const decisionId of p.decision_ids ?? []) {
  const decision = next.decisions[decisionId];
  if (!decision) return rejected("DECISION_NOT_FOUND", `Decision ${decisionId} does not exist`);
  if (decision.status !== "accepted") {
    return rejected("DELIVERABLE_DECISION_NOT_ACCEPTED", `Deliverable requires accepted decision ${decisionId}`);
  }
}
```

Do not rewrite existing deliverables if a governing decision is superseded later.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npx vitest run test/operations.spec.ts
git add src/domain/transitions.ts test/operations.spec.ts
git commit -m "feat: require current governing decisions"
```

---

### Task 5: Prove historical schema-1.0 compatibility remains reader-safe

**Files:**
- Modify: `test/project-state-normalizer.spec.ts`
- Modify: `test/project-guard.spec.ts`
- No production file expected.

**Interfaces:**
- Consumes: `normalizeProjectState`, ProjectGuard historical-state loading/materialization.
- Produces: regression proof that MODEL001 does not turn historical lifecycle irregularities into reader failures or hidden migrations.

- [ ] **Step 1: Add a normalizer compatibility case**

Extend `test/project-state-normalizer.spec.ts` with a structurally valid historical state containing an archived project whose stored phase is still active/current:

```ts
it("keeps historical lifecycle combinations readable without rewriting revision", () => {
  const historical = legacyState();
  historical.status = "archived";
  historical.current_phase_id = "PHASE-3001";
  historical.plan_phases = {
    "PHASE-3001": {
      phase_id: "PHASE-3001",
      title: "Historical active phase",
      next_actions: [],
      status: "active",
      created_at: at,
      updated_at: at
    }
  } as never;

  const normalized = normalizeProjectState(historical);
  expect(normalized.revision).toBe(7);
  expect(normalized.status).toBe("archived");
  expect(normalized.current_phase_id).toBe("PHASE-3001");
  expect(normalized.plan_phases["PHASE-3001"].status).toBe("active");
});
```

- [ ] **Step 2: Add a ProjectGuard materialization compatibility case**

In `test/project-guard.spec.ts`, use `runInDurableObject` to store the same kind of schema-1.0 historical snapshot, call `materialize(projectId)`, and assert:

```ts
expect(result).toEqual({ project_id: projectId, revision: 7, materialized: true });
```

Then inspect generated `STATE.md` and assert it reflects revision 7 rather than creating a new business revision.

- [ ] **Step 3: Run compatibility and recovery suites**

```bash
npx vitest run test/project-state-normalizer.spec.ts test/project-guard.spec.ts test/project-guard-commit-recovery.spec.ts
```

Expected: PASS. If these tests require a production normalizer change, stop and re-evaluate against the no-hidden-migration design instead of strengthening the persisted-state parser casually.

- [ ] **Step 4: Commit the compatibility tests**

```bash
git add test/project-state-normalizer.spec.ts test/project-guard.spec.ts
git commit -m "test: preserve MODEL001 historical compatibility"
```

---

### Task 6: Verify concurrency semantics through ProjectGuard receipts

**Files:**
- Modify: `test/project-guard.spec.ts`

**Interfaces:**
- Consumes: Task 1 domain policy through the existing ProjectGuard transaction path.
- Produces: receipt-level proof that stale lifecycle conflicts do not advance canonical revision, while stale additive creates still can.

- [ ] **Step 1: Add the ProjectGuard concurrency integration test**

Add:

```ts
it("conflicts stale task lifecycle without advancing revision and still rebases additive work", async () => {
  const projectId = "PRJ-1010";
  await submit(projectId, createTx(projectId, "TXN-PROJECT-1010-0001"));

  const task = await submit(projectId, {
    schema_version: "1.0",
    transaction_id: "TXN-PROJECT-1010-0002",
    project_id: projectId,
    base_revision: 1,
    operation: "task.create",
    created_at: at,
    payload: { task_id: "TASK-1010", title: "Lifecycle target" }
  });
  expect(task.new_revision).toBe(2);

  const concurrent = await submit(projectId, {
    schema_version: "1.0",
    transaction_id: "TXN-PROJECT-1010-0003",
    project_id: projectId,
    base_revision: 2,
    operation: "research.add",
    created_at: at,
    payload: { research_id: "RES-1010", title: "Intervening", body: "Evidence" }
  });
  expect(concurrent.new_revision).toBe(3);

  const staleLifecycle = await submit(projectId, {
    schema_version: "1.0",
    transaction_id: "TXN-PROJECT-1010-0004",
    project_id: projectId,
    base_revision: 2,
    operation: "task.complete",
    created_at: at,
    payload: { task_id: "TASK-1010" }
  });
  expect(staleLifecycle).toMatchObject({
    status: "conflict",
    previous_revision: 3,
    new_revision: 3,
    code: "STALE_REVISION"
  });
  expect(staleLifecycle.event_id).toBeUndefined();

  const additive = await submit(projectId, {
    schema_version: "1.0",
    transaction_id: "TXN-PROJECT-1010-0005",
    project_id: projectId,
    base_revision: 2,
    operation: "task.create",
    created_at: at,
    payload: { task_id: "TASK-1011", title: "Independent stale create" }
  });
  expect(additive).toMatchObject({ status: "committed", previous_revision: 3, new_revision: 4 });
});
```

- [ ] **Step 2: Run the integration test**

```bash
npx vitest run test/project-guard.spec.ts
```

Expected: PASS after Task 1. If it fails while pure transition tests pass, fix only the smallest ProjectGuard integration defect demonstrated by the failure; do not add a second concurrency coordinator.

- [ ] **Step 3: Commit the integration proof**

```bash
git add test/project-guard.spec.ts
git commit -m "test: prove MODEL001 receipt concurrency"
```

---

### Task 7: Publish the formal domain contract in operational documentation

**Files:**
- Create: `docs/domain-model.md`
- Modify: `docs/project-os-sop.md`
- Modify: `docs/deployment.md`

**Interfaces:**
- Consumes: implemented behavior from Tasks 1-6 and approved spec.
- Produces: stable contract for operators and downstream PERSIST/INDEX packages.

- [ ] **Step 1: Create `docs/domain-model.md` with the implemented rules**

The document must explicitly contain these sections and exact semantics:

```markdown
# Project OS Domain Lifecycle and Concurrency Model

## Authority
Canonical commit records are immutable history. `ProjectState` is the current aggregate reconstructed from that history. Markdown/materializations/indexes are derived and reconstructible.

## Concurrency
A stale transaction may rebase only for `research.add`, `constraint.add`, `task.create`, and deprecated `deliverable.add`, after validation against current state. Every other operation requires the current project revision. Stale exact-current operations return `conflict` and create no business revision.

## Project lifecycle
`active -> paused -> active`; `active|paused -> completed`; `active|paused|completed -> archived`; archived is terminal. Project completion does not infer child completion.

## Task lifecycle
`pending -> active|blocked|completed`; `active -> blocked|completed`; `blocked -> active|blocked|completed`; completed is terminal. `blocked -> blocked` is an exact-current reason refresh.

## Phase lifecycle
The first phase is active/current; later phases are pending. Only the single active `current_phase_id` may complete. The lexicographically lowest pending `phase_id` is promoted. New tasks and normative deliverables cannot attach to a completed phase. Phase completion does not fabricate child completion.

## Decisions and research
Decisions are accepted then explicitly superseded without deleting history. Research is append-only evidence; Discovery is the mutable synthesis layer.

## Deliverables
Normative lifecycle remains `planned -> in_progress -> review -> accepted`, with review revision back to `in_progress`, explicit supersession, abandonment, and `legacy_completed` compatibility without inferred acceptance. New governing decision references must be currently accepted.

## Historical compatibility
MODEL001 does not rewrite or reject structurally valid schema-1.0 historical snapshots merely because their stored lifecycle combination would no longer be newly created.

## Deferred schema capabilities
Persisted dependency graphs, per-entity revisions, explicit phase ordering fields, research statuses, and other new durable relations remain deferred to IMP-SCHEMA001 or a separately approved package.
```

- [ ] **Step 2: Update SOP concurrency/lifecycle sections**

In `docs/project-os-sop.md`, replace generic concurrency wording with the four-operation stale-rebase allow-list, exact-current rule, conflict semantics, one-current-phase invariant, and explicit task/deliverable attachment rules. Keep the existing project lifecycle table and add the no-inferred-child-completion clarification.

- [ ] **Step 3: Add MODEL001 production proof to deployment documentation**

In `docs/deployment.md`, add a dedicated `IMP-MODEL001` production-proof subsection requiring:

- exact merge SHA deployment;
- `npm run check` and `npx wrangler deploy --dry-run` on the exact implementation head;
- health success;
- continuity `stable`;
- MutationGate `observe`;
- controlled current lifecycle success;
- stale lifecycle conflict with no revision increment;
- stale additive commit after current-state revalidation;
- existing project read/recovery check;
- no PRJ-0003 repair and no SCHEMA runtime.

- [ ] **Step 4: Run documentation-sensitive regression tests**

```bash
npx vitest run test/render.spec.ts test/rich-render.spec.ts test/v2-boundaries.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/domain-model.md docs/project-os-sop.md docs/deployment.md
git commit -m "docs: formalize Project OS domain model"
```

---

### Task 8: Run exact-head pre-merge verification and open the runtime PR

**Files:**
- Verification only; no new behavior unless a failing gate requires a TDD fix.

**Interfaces:**
- Consumes: final implementation branch head from Tasks 1-7.
- Produces: reproducible exact-head evidence and a runtime PR ready for human review.

- [ ] **Step 1: Run the focused MODEL001 suites**

```bash
npx vitest run \
  test/transitions.spec.ts \
  test/operations.spec.ts \
  test/model-phase-lifecycle.spec.ts \
  test/project-state-normalizer.spec.ts \
  test/project-guard.spec.ts \
  test/project-guard-commit-recovery.spec.ts
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run the complete repository gate**

```bash
npm install
npm run check
```

Expected: `wrangler types`, TypeScript typecheck and the complete Vitest suite all exit 0.

- [ ] **Step 3: Run the exact-head Worker dry-run**

```bash
npx wrangler deploy --dry-run
```

Expected: exit 0 with no production deployment.

- [ ] **Step 4: Verify forbidden drift is absent**

Inspect the final diff and confirm:

```text
src/domain/project-state.ts        unchanged
src/domain/transaction.ts          unchanged
wrangler.jsonc                     unchanged
PROJECT_OS_CONTINUITY_MODE         stable
PROJECT_OS_MUTATION_GATE_MODE      observe
no PRJ-0003 files                  touched
no SCHEMA runtime                  added
```

- [ ] **Step 5: Apply verification-before-completion discipline**

Re-run any gate whose evidence is stale after the last commit. Do not claim tests/build/dry-run pass from an earlier head.

- [ ] **Step 6: Open a separate implementation PR**

Open the runtime PR from `imp/model001-lifecycle-concurrency` to `main` with:

- approved spec and plan links;
- exact base/head SHAs;
- RED/GREEN evidence summary;
- focused and full test results;
- dry-run result;
- explicit schema/MutationGate/PRJ-0003 boundaries;
- rollback statement: code rollback only, no history rewrite.

Do **not** merge or deploy in this task.

---

## Gate 1: Explicit runtime merge/deployment approval

After Task 8, present the exact implementation PR head, changed files, test counts/results, dry-run result, and any review findings to the user.

The next authorization must explicitly cover runtime PR merge and production deployment. Until that approval exists:

```text
NO runtime PR merge
NO production deploy
NO MutationGate enforce
NO PRJ-0003 repair
NO SCHEMA runtime
```

---

### Task 9: Merge the exact reviewed runtime head and validate deployment

**Files:**
- No source edits expected after approval; if code changes are required, return to Task 8 verification on the new head.

**Interfaces:**
- Consumes: explicitly approved runtime PR head.
- Produces: exact merge SHA, successful main deployment evidence, production health evidence.

- [ ] **Step 1: Reconfirm the PR head did not change after approval**

Compare the approved head SHA to the current PR head. If different, stop and re-run Task 8 before merge.

- [ ] **Step 2: Merge the runtime PR and record the exact merge SHA**

Do not infer deployment from merge status alone.

- [ ] **Step 3: Verify the deployment workflow for that exact SHA**

Confirm checkout, credentials check, Node setup, install, `npm run check`, Worker deploy, health check and deployment-status publication all succeed for the exact merge commit.

- [ ] **Step 4: Verify production health and configuration boundary**

Verify `/health` succeeds and production remains aligned with:

```text
PROJECT_OS_CONTINUITY_MODE=stable
PROJECT_OS_MUTATION_GATE_MODE=observe
```

No MODEL001 production gate may switch MutationGate to enforce.

---

### Task 10: Run an isolated production behavior proof

**Files:**
- No repository source edits.
- Durable test evidence: one explicitly named isolated Project OS probe project, created only under the runtime deployment approval gate and archived at the end.

**Interfaces:**
- Consumes: deployed exact MODEL001 merge SHA.
- Produces: receipts proving current lifecycle success, stale lifecycle conflict, stale additive commit, and terminal archival without touching PRJ-0003.

- [ ] **Step 1: Create one isolated production probe project**

Use normal typed `project.create` with `project_id: "PRJ-AUTO"`, name `MODEL001 production probe`, slug `model001-production-probe`, and objective `Validate MODEL001 lifecycle and concurrency semantics in production without using a business project.` Record the allocated PRJ ID and committed revision 1.

- [ ] **Step 2: Create the lifecycle target at revision 1**

Submit `task.create` for `TASK-MODELPROBE001` at base revision 1. Require a committed receipt to revision 2.

- [ ] **Step 3: Create an intervening additive commit**

Submit `research.add` for `RES-MODELPROBE001` at base revision 2 with body `Synthetic MODEL001 production probe evidence only; not business research.` Require a committed receipt to revision 3.

- [ ] **Step 4: Prove stale lifecycle conflict without revision advance**

Submit `task.start` for `TASK-MODELPROBE001` using stale `base_revision: 2`. Require:

```text
status=conflict
code=STALE_REVISION
new_revision=3
no event_id
```

Refresh state and verify the project remains revision 3 and the task remains pending.

- [ ] **Step 5: Prove exact-current lifecycle success**

Submit the same semantic `task.start` as a fresh transaction at base revision 3. Require committed revision 4 and task status `active`.

- [ ] **Step 6: Prove stale additive task creation still rebases**

Submit `task.create` for unique `TASK-MODELPROBE002` using stale `base_revision: 2` while canonical state is revision 4. Require committed revision 5.

- [ ] **Step 7: Close probe tasks and archive the probe project**

Complete `TASK-MODELPROBE001` at revision 5 -> 6, complete `TASK-MODELPROBE002` at revision 6 -> 7, then archive the probe project at revision 7 -> 8 with reason `MODEL001 production proof completed`.

- [ ] **Step 8: Verify existing projects remain readable without mutation**

Read PRJ-0002 canonical state and one existing historical project state through normal read paths. Do not write, repair, adopt, reject or otherwise modify PRJ-0003.

- [ ] **Step 9: Record exact production proof evidence**

Capture the deployment merge SHA, deployment workflow/run evidence, health result, probe project ID, committed/conflict receipt IDs and final archived revision. Do not include secret values.

---

### Task 11: Canonically close MODEL001 and revalidate the downstream roadmap

**Files:**
- Project OS typed transactions only for canonical closure.
- Read-only revalidation: `docs/project-os-improvement-roadmap.md` and current downstream package docs.

**Interfaces:**
- Consumes: exact production deployment/probe evidence from Tasks 9-10.
- Produces: canonical implementation research, completed `TASK-IMPMODEL001`, and an explicit downstream dependency conclusion for `IMP-PERSIST001`.

- [ ] **Step 1: Refresh PRJ-0002 current revision**

Never use a remembered base revision after production work.

- [ ] **Step 2: Add canonical implementation/production evidence**

Create `RES-IMPMODELIMPL001` via `research.add`. Its body must state the implemented semantics, exact runtime PR number/head, exact merge SHA, focused/full verification results, Wrangler dry-run result, production deploy/health evidence, isolated probe project ID and receipt outcomes, continuity `stable`, MutationGate `observe`, and explicit confirmation that PRJ-0003 repair and SCHEMA runtime did not occur.

Its `source` must cite the exact GitHub implementation PR/merge and deployment evidence, not this chat.

- [ ] **Step 3: Complete `TASK-IMPMODEL001` only after the research receipt commits**

Use a fresh `task.complete` transaction with a result equivalent to:

```text
IMP-MODEL001 implemented, fully verified, merged and production-validated on the exact recorded commit. Formal lifecycle/concurrency semantics are active without a ProjectState schema bump; historical schema-1.0 compatibility is preserved; MutationGate remains observe; PRJ-0003 repair and SCHEMA runtime were not performed.
```

Require `status=committed`.

- [ ] **Step 4: Re-read canonical HANDOFF/STATE and downstream roadmap**

Confirm MODEL001 is completed canonically. Revalidate `IMP-PERSIST001` against the exact new main rather than assuming the old roadmap analysis still holds.

- [ ] **Step 5: Continue only with genuinely independent downstream work**

If PERSIST001 remains independent of MutationGate/SCHEMA validation, begin its analysis/design gate next. Keep SCHEMA-dependent subsets isolated and keep MutationGate enforcement/PRJ-0003 repair on their separate gates.

---

## Self-review checklist for this plan

Before presenting this plan for user approval, verify:

- Every approved MODEL001 design requirement maps to at least one task above.
- There is no `TBD`, `TODO`, placeholder implementation, hidden schema change, or unspecified error handling.
- The concurrency helper is fail closed: only four operations are stale-rebasable.
- Task lifecycle preserves direct completion and exact-current blocked-reason refresh.
- Phase completion cannot close pending/non-current phases and cannot leave a known second active phase.
- New task/deliverable attachment to a completed phase is rejected.
- Superseded decisions remain historical but cannot newly govern a deliverable.
- Historical normalizer/recovery compatibility remains unchanged.
- ProjectGuard serialization is reused rather than replaced.
- Pre-merge tests/dry-run and post-merge production proof are distinct gates.
- Plan approval does not itself authorize runtime merge/deployment.
- MutationGate remains observe; no PRJ-0003 repair and no SCHEMA runtime are included.
