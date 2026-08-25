# IMP-MODEL001 Formal Lifecycle and Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: proposed for user review. This document becomes runtime implementation authorization only after explicit user approval and a committed Project OS implementation-authorization decision.

**Goal:** Implement the approved schema-1.0-compatible Project OS lifecycle and concurrency contract so stale lifecycle/direction mutations conflict deterministically, phase progression is coherent, new governed references are valid, and historical state remains readable without a schema migration.

**Architecture:** Keep ProjectGuard as the existing per-project serialization boundary and keep persisted `ProjectState 1.0` unchanged. Put stale-rebase classification in one small fail-closed domain policy, enforce lifecycle/reference invariants in the pure transition layer, and prove behavior at both pure-domain and ProjectGuard receipt boundaries. Historical compatibility remains a reader contract: old structurally valid snapshots stay loadable while stricter rules govern new mutations.

**Tech Stack:** TypeScript 5.9, Vitest 4.1, Cloudflare Workers + SQLite Durable Objects, Zod 4.4, Wrangler 4.124, Dropbox persistence.

**Spec:** `docs/superpowers/specs/2026-08-25-imp-model001-formal-lifecycle-concurrency-design.md`

## Global Constraints

- Execution baseline is GitHub `main` commit `820030be0f775aa89689a4bdb56ac6495e21dfe1`; refresh `main` immediately before execution and revalidate this plan if `main` changed materially.
- Canonical design baseline is PRJ-0002 revision `89`, `RES-IMPMODELDESIGN001`, and accepted `DEC-IMPMODELDESIGN001`.
- `ProjectState.schema_version` remains exactly `1.0`; do not add persisted fields, transaction operations, transaction payload members, upcasters, migrations, dependency graphs, per-entity revisions, or research statuses.
- `src/domain/project-state.ts` and `src/domain/transaction.ts` are expected to remain unchanged. If a failing test demonstrates that either persisted shape must change, stop MODEL001 implementation and return that need to the SCHEMA gate.
- `PROJECT_OS_CONTINUITY_MODE` remains `stable`.
- `PROJECT_OS_MUTATION_GATE_MODE` remains `observe`; this plan never authorizes `enforce`.
- Do not repair, adopt, reject, move, overwrite, or otherwise mutate historical PRJ-0003 deviations as part of MODEL001.
- Do not implement IMP-SCHEMA001 runtime behavior.
- Do not add a second lock, queue, or persistence coordinator; ProjectGuard remains the per-project serialization boundary.
- Every behavior change follows strict RED -> GREEN -> REFACTOR. Production code is written only after the dedicated test has been observed failing for the intended reason.
- Historical schema-1.0 snapshots satisfying the existing normalizer remain readable even if their lifecycle combination would not be newly created after MODEL001.
- Approval of this plan authorizes an isolated implementation/test/documentation branch after the canonical implementation-authorization receipt commits. Runtime PR merge and production deployment remain a later explicit gate after exact-head verification.

---

## Gate 0: Record implementation authorization and isolate execution

**Files:**
- Existing review branch: `docs/imp-model001-design`
- Documentation PR: `#39`
- Future implementation branch: `imp/model001-lifecycle-concurrency`

**Interfaces:**
- Consumes: approved spec, this approved plan, canonical PRJ-0002 current revision.
- Produces: committed `DEC-IMPMODELIMPL001`, merged documentation checkpoint, isolated implementation branch/worktree based on refreshed `main`.

- [ ] **Step 1: Read the execution-isolation skill before source edits**

At execution time read `superpowers:using-git-worktrees` and follow it before changing runtime code.

- [ ] **Step 2: Refresh PRJ-0002 and GitHub main**

Verify `TASK-IMPMODEL001` remains active, `DEC-IMPMODELDESIGN001` remains accepted, PR #39 is documentation-only, and no new `main` change invalidates the approved model.

- [ ] **Step 3: Commit implementation authorization through Project OS**

Submit a fresh typed `decision.accept` against the then-current PRJ-0002 revision:

```json
{
  "operation": "decision.accept",
  "payload": {
    "decision_id": "DEC-IMPMODELIMPL001",
    "title": "Authorize IMP-MODEL001 isolated TDD implementation",
    "decision": "Authorize implementation of the approved IMP-MODEL001 specification and TDD plan on an isolated branch after the documentation checkpoint is merged. This covers source changes, tests, documentation and creation of an implementation PR only. It does not authorize runtime PR merge, production deployment, MutationGate enforce, PRJ-0003 repair, or IMP-SCHEMA001 runtime.",
    "reason": "The written design and executable implementation plan were separately reviewed and approved before runtime changes.",
    "impacts": [
      "Implement MODEL001 strictly with RED-GREEN-REFACTOR.",
      "Keep ProjectState and Transaction persisted schemas at 1.0.",
      "Require a separate runtime merge/deployment approval after exact-head verification.",
      "Keep MutationGate observe and leave PRJ-0003 and SCHEMA runtime untouched."
    ]
  }
}
```

Continue only after the receipt is `committed`.

- [ ] **Step 4: Merge the approved documentation checkpoint and isolate runtime work**

After plan approval and the committed implementation-authorization decision, merge PR #39, refresh `main`, and create `imp/model001-lifecycle-concurrency` from that exact post-documentation `main`. Runtime changes never go into PR #39.

---

### Task 1: Make stale-rebase policy explicit and fail closed

**Files:**
- Create: `src/domain/concurrency-policy.ts`
- Create: `test/model-lifecycle-concurrency.spec.ts`
- Modify: `src/domain/transitions.ts`
- Modify: `test/transitions.spec.ts`

**Interfaces:**
- Consumes: `Transaction["operation"]`.
- Produces: `mayRebaseStaleOperation(operation: Transaction["operation"]): boolean`, called by `applyTransaction` before state mutation.

- [ ] **Step 1: Create the MODEL test file with deterministic helpers and stale lifecycle tests**

Create `test/model-lifecycle-concurrency.spec.ts` with this preamble and first tests:

```ts
import { describe, expect, it } from "vitest";
import type { ProjectState } from "../src/domain/project-state";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";
import type { Transaction } from "../src/domain/transaction";

const at = "2026-08-25T18:00:00.000Z";
let serial = 0;

function tx<T extends Transaction["operation"]>(
  projectId: string,
  baseRevision: number,
  operation: T,
  payload: Extract<Transaction, { operation: T }>["payload"]
): Transaction {
  serial += 1;
  return {
    schema_version: "1.0",
    transaction_id: `TXN-MODEL-${serial.toString().padStart(10, "0")}`,
    project_id: projectId,
    base_revision: baseRevision,
    operation,
    created_at: at,
    payload
  } as Transaction;
}

function commit(state: ProjectState, transaction: Transaction): ProjectState {
  const result = applyTransaction(state, transaction);
  expect(result.kind).toBe("commit");
  if (result.kind !== "commit") throw new Error(`Expected commit, got ${result.kind}`);
  return result.state;
}

describe("MODEL001 concurrency", () => {
  it("conflicts stale task start", () => {
    let state = emptyProjectState("PRJ-4001", "Model", "model");
    state = commit(state, tx(state.project_id, state.revision, "task.create", {
      task_id: "TASK-4001", title: "Target"
    }));
    const concurrent = { ...state, revision: state.revision + 1 };
    const result = applyTransaction(concurrent, tx(state.project_id, state.revision, "task.start", {
      task_id: "TASK-4001"
    }));
    expect(result).toMatchObject({ kind: "conflict", code: "STALE_REVISION" });
  });

  it("conflicts stale task block", () => {
    let state = emptyProjectState("PRJ-4002", "Model", "model");
    state = commit(state, tx(state.project_id, state.revision, "task.create", {
      task_id: "TASK-4002", title: "Target"
    }));
    const concurrent = { ...state, revision: state.revision + 1 };
    const result = applyTransaction(concurrent, tx(state.project_id, state.revision, "task.block", {
      task_id: "TASK-4002", reason: "Blocked"
    }));
    expect(result).toMatchObject({ kind: "conflict", code: "STALE_REVISION" });
  });

  it("conflicts stale task completion", () => {
    let state = emptyProjectState("PRJ-4003", "Model", "model");
    state = commit(state, tx(state.project_id, state.revision, "task.create", {
      task_id: "TASK-4003", title: "Target"
    }));
    const concurrent = { ...state, revision: state.revision + 1 };
    const result = applyTransaction(concurrent, tx(state.project_id, state.revision, "task.complete", {
      task_id: "TASK-4003"
    }));
    expect(result).toMatchObject({ kind: "conflict", code: "STALE_REVISION" });
  });

  it("conflicts stale legacy deliverable completion", () => {
    let state = emptyProjectState("PRJ-4004", "Model", "model");
    state = commit(state, tx(state.project_id, state.revision, "deliverable.add", {
      deliverable_id: "DEL-4001", title: "Legacy"
    }));
    const concurrent = { ...state, revision: state.revision + 1 };
    const result = applyTransaction(concurrent, tx(state.project_id, state.revision, "deliverable.complete", {
      deliverable_id: "DEL-4001", outcome: "Done"
    }));
    expect(result).toMatchObject({ kind: "conflict", code: "STALE_REVISION" });
  });
});
```

- [ ] **Step 2: Remove the obsolete permissive stale completion expectation**

Delete the existing `test/transitions.spec.ts` case named `allows a stale independent task completion only while the target transition is still valid`. Keep the stale `research.add` and stale `decision.accept` tests.

- [ ] **Step 3: Run RED**

```bash
npx vitest run test/model-lifecycle-concurrency.spec.ts test/transitions.spec.ts
```

Expected: stale task lifecycle and stale `deliverable.complete` tests fail because the current runtime permits them.

- [ ] **Step 4: Add the fail-closed policy**

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

- [ ] **Step 5: Wire it into `applyTransaction`**

In `src/domain/transitions.ts`, import `mayRebaseStaleOperation`, delete `exactRevisionOperations`, and replace the stale check with:

```ts
const stale = tx.base_revision !== state.revision;
if (stale && !mayRebaseStaleOperation(tx.operation)) {
  return conflict("STALE_REVISION", `${tx.operation} requires the current project revision`);
}
```

Keep the existing `project.create`, `REVISION_AHEAD`, archived-project and completed-project guards in their current order.

- [ ] **Step 6: Add characterization for all four stale-rebasable operations**

Append to the concurrency describe block:

```ts
it("rebases only the approved additive operations when current-state invariants still hold", () => {
  const state = { ...emptyProjectState("PRJ-4005", "Model", "model"), revision: 5 };

  expect(applyTransaction(state, tx(state.project_id, 2, "research.add", {
    research_id: "RES-4001", title: "Research", body: "Evidence"
  })).kind).toBe("commit");

  expect(applyTransaction(state, tx(state.project_id, 2, "constraint.add", {
    constraint_id: "CON-4001", title: "Constraint", description: "Rule"
  })).kind).toBe("commit");

  expect(applyTransaction(state, tx(state.project_id, 2, "task.create", {
    task_id: "TASK-4005", title: "Independent task"
  })).kind).toBe("commit");

  expect(applyTransaction(state, tx(state.project_id, 2, "deliverable.add", {
    deliverable_id: "DEL-4002", title: "Legacy additive"
  })).kind).toBe("commit");
});
```

- [ ] **Step 7: Run GREEN and commit**

```bash
npx vitest run test/model-lifecycle-concurrency.spec.ts test/transitions.spec.ts
git add src/domain/concurrency-policy.ts src/domain/transitions.ts test/model-lifecycle-concurrency.spec.ts test/transitions.spec.ts
git commit -m "feat: formalize MODEL001 concurrency policy"
```

---

### Task 2: Lock the approved task lifecycle matrix

**Files:**
- Modify: `test/model-lifecycle-concurrency.spec.ts`

**Interfaces:**
- Consumes: existing task transition logic plus Task 1 exact-current policy.
- Produces: executable coverage of direct completion, blocking/reason refresh, resume, active blocking, blocked completion and terminal completion.

- [ ] **Step 1: Add exact task lifecycle characterization**

Append:

```ts
describe("MODEL001 task lifecycle", () => {
  it("allows pending to complete without mandatory start", () => {
    let state = emptyProjectState("PRJ-4101", "Tasks", "tasks");
    state = commit(state, tx(state.project_id, state.revision, "task.create", {
      task_id: "TASK-4101", title: "Direct completion"
    }));
    state = commit(state, tx(state.project_id, state.revision, "task.complete", {
      task_id: "TASK-4101", result: "Done naturally"
    }));
    expect(state.tasks["TASK-4101"]).toMatchObject({ status: "completed", result: "Done naturally" });
  });

  it("supports blocked reason refresh, resume, active block and blocked completion", () => {
    let state = emptyProjectState("PRJ-4102", "Tasks", "tasks");
    state = commit(state, tx(state.project_id, state.revision, "task.create", {
      task_id: "TASK-4102", title: "Recoverable"
    }));
    state = commit(state, tx(state.project_id, state.revision, "task.block", {
      task_id: "TASK-4102", reason: "First blocker"
    }));
    state = commit(state, tx(state.project_id, state.revision, "task.block", {
      task_id: "TASK-4102", reason: "Updated blocker"
    }));
    expect(state.tasks["TASK-4102"].blocked_reason).toBe("Updated blocker");

    state = commit(state, tx(state.project_id, state.revision, "task.start", {
      task_id: "TASK-4102"
    }));
    expect(state.tasks["TASK-4102"]).toMatchObject({ status: "active" });
    expect(state.tasks["TASK-4102"].blocked_reason).toBeUndefined();

    state = commit(state, tx(state.project_id, state.revision, "task.block", {
      task_id: "TASK-4102", reason: "Second blocker"
    }));
    state = commit(state, tx(state.project_id, state.revision, "task.complete", {
      task_id: "TASK-4102"
    }));
    expect(state.tasks["TASK-4102"].status).toBe("completed");
    expect(state.tasks["TASK-4102"].blocked_reason).toBeUndefined();
  });

  it("keeps completed tasks terminal", () => {
    let state = emptyProjectState("PRJ-4103", "Tasks", "tasks");
    state = commit(state, tx(state.project_id, state.revision, "task.create", {
      task_id: "TASK-4103", title: "Terminal"
    }));
    state = commit(state, tx(state.project_id, state.revision, "task.complete", {
      task_id: "TASK-4103"
    }));

    expect(applyTransaction(state, tx(state.project_id, state.revision, "task.start", {
      task_id: "TASK-4103"
    })).kind).toBe("rejected");
    expect(applyTransaction(state, tx(state.project_id, state.revision, "task.block", {
      task_id: "TASK-4103", reason: "No"
    })).kind).toBe("rejected");
    expect(applyTransaction(state, tx(state.project_id, state.revision, "task.complete", {
      task_id: "TASK-4103"
    })).kind).toBe("rejected");
  });
});
```

- [ ] **Step 2: Run the characterization suite**

```bash
npx vitest run test/model-lifecycle-concurrency.spec.ts
```

Expected: PASS. These cases freeze approved existing task semantics; no production change is expected in this task.

- [ ] **Step 3: Commit**

```bash
git add test/model-lifecycle-concurrency.spec.ts
git commit -m "test: lock MODEL001 task lifecycle"
```

---

### Task 3: Enforce coherent phase progression and completed-phase attachment rules

**Files:**
- Modify: `src/domain/transitions.ts`
- Modify: `test/model-lifecycle-concurrency.spec.ts`

**Interfaces:**
- Consumes: `plan_phases`, `current_phase_id`, `plan.phase.complete`, `task.create`, normative `deliverable.create`.
- Produces: only the single active/current phase can complete, known multiple-active state fails closed, lexicographic promotion is preserved, and completed phases reject new work attachment.

- [ ] **Step 1: Add failing phase tests**

Append:

```ts
describe("MODEL001 phase lifecycle", () => {
  it("rejects completion of a pending non-current phase", () => {
    let state = emptyProjectState("PRJ-4201", "Phases", "phases");
    state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
      phase_id: "PHASE-4201", title: "Current"
    }));
    state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
      phase_id: "PHASE-4202", title: "Later"
    }));
    const result = applyTransaction(state, tx(state.project_id, state.revision, "plan.phase.complete", {
      phase_id: "PHASE-4202"
    }));
    expect(result).toMatchObject({ kind: "rejected", code: "PHASE_NOT_CURRENT" });
  });

  it("fails closed when a historical state contains another active phase", () => {
    let state = emptyProjectState("PRJ-4202", "Phases", "phases");
    state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
      phase_id: "PHASE-4203", title: "Current"
    }));
    state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
      phase_id: "PHASE-4204", title: "Later"
    }));
    state.plan_phases["PHASE-4204"].status = "active";

    const result = applyTransaction(state, tx(state.project_id, state.revision, "plan.phase.complete", {
      phase_id: "PHASE-4203"
    }));
    expect(result).toMatchObject({ kind: "rejected", code: "PHASE_STATE_INCONSISTENT" });
  });
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/model-lifecycle-concurrency.spec.ts
```

Expected: the pending phase currently completes and the multiple-active historical state is not rejected by the transition layer.

- [ ] **Step 3: Guard active/current completion before mutating the phase**

In `plan.phase.complete`, after locating the target phase, add:

```ts
if (phase.status !== "active" || next.current_phase_id !== phase.phase_id) {
  return rejected(
    "PHASE_NOT_CURRENT",
    `Only current active phase ${next.current_phase_id ?? "<none>"} can be completed`
  );
}
const otherActive = Object.values(next.plan_phases).find(
  (candidate) => candidate.status === "active" && candidate.phase_id !== phase.phase_id
);
if (otherActive) {
  return rejected(
    "PHASE_STATE_INCONSISTENT",
    `Multiple active phases include ${phase.phase_id} and ${otherActive.phase_id}`
  );
}
```

Keep the existing lexicographic pending-phase promotion code after these guards.

- [ ] **Step 4: Add failing completed-phase attachment tests**

Append inside the phase describe block:

```ts
it("rejects new task and normative deliverable attachment to a completed phase", () => {
  let state = emptyProjectState("PRJ-4203", "Phases", "phases");
  state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
    phase_id: "PHASE-4205", title: "Closed phase"
  }));
  state = commit(state, tx(state.project_id, state.revision, "plan.phase.complete", {
    phase_id: "PHASE-4205"
  }));

  const task = applyTransaction(state, tx(state.project_id, state.revision, "task.create", {
    task_id: "TASK-4201", title: "Too late", phase_id: "PHASE-4205"
  }));
  expect(task).toMatchObject({ kind: "rejected", code: "PHASE_COMPLETED" });

  const deliverable = applyTransaction(state, tx(state.project_id, state.revision, "deliverable.create", {
    deliverable_id: "DEL-4201", title: "Too late", version: "v1", phase_id: "PHASE-4205"
  }));
  expect(deliverable).toMatchObject({ kind: "rejected", code: "PHASE_COMPLETED" });
});
```

Run the focused file and verify this case fails because current create operations check phase existence but not completion.

- [ ] **Step 5: Implement completed-phase attachment rejection**

Replace the task phase check with:

```ts
if (p.phase_id) {
  const phase = next.plan_phases[p.phase_id];
  if (!phase) return rejected("PHASE_NOT_FOUND", `Phase ${p.phase_id} does not exist`);
  if (phase.status === "completed") {
    return rejected("PHASE_COMPLETED", `Completed phase ${p.phase_id} is terminal`);
  }
}
```

Use the same existence/completed logic in normative `deliverable.create` before decision validation.

- [ ] **Step 6: Add progression and no-inferred-child-gate characterization**

Append:

```ts
it("promotes the lexicographically lowest pending phase and clears current when none remain", () => {
  let state = emptyProjectState("PRJ-4204", "Phases", "phases");
  state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
    phase_id: "PHASE-4210", title: "Current"
  }));
  state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
    phase_id: "PHASE-4212", title: "Third"
  }));
  state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
    phase_id: "PHASE-4211", title: "Second"
  }));
  state = commit(state, tx(state.project_id, state.revision, "plan.phase.complete", {
    phase_id: "PHASE-4210"
  }));
  expect(state.current_phase_id).toBe("PHASE-4211");
  expect(state.plan_phases["PHASE-4211"].status).toBe("active");

  state = commit(state, tx(state.project_id, state.revision, "plan.phase.complete", {
    phase_id: "PHASE-4211"
  }));
  state = commit(state, tx(state.project_id, state.revision, "plan.phase.complete", {
    phase_id: "PHASE-4212"
  }));
  expect(state.current_phase_id).toBeNull();
});

it("does not fabricate child completion when the current phase completes", () => {
  let state = emptyProjectState("PRJ-4205", "Phases", "phases");
  state = commit(state, tx(state.project_id, state.revision, "plan.phase.create", {
    phase_id: "PHASE-4220", title: "Current"
  }));
  state = commit(state, tx(state.project_id, state.revision, "task.create", {
    task_id: "TASK-4220", title: "Still pending", phase_id: "PHASE-4220"
  }));
  state = commit(state, tx(state.project_id, state.revision, "deliverable.create", {
    deliverable_id: "DEL-4220", title: "Still planned", version: "v1", phase_id: "PHASE-4220"
  }));
  state = commit(state, tx(state.project_id, state.revision, "plan.phase.complete", {
    phase_id: "PHASE-4220"
  }));
  expect(state.tasks["TASK-4220"].status).toBe("pending");
  expect(state.deliverables["DEL-4220"].status).toBe("planned");
});
```

- [ ] **Step 7: Run GREEN and commit**

```bash
npx vitest run test/model-lifecycle-concurrency.spec.ts test/operations.spec.ts
git add src/domain/transitions.ts test/model-lifecycle-concurrency.spec.ts
git commit -m "feat: enforce MODEL001 phase invariants"
```

---

### Task 4: Require currently accepted decisions for new governed deliverables

**Files:**
- Modify: `src/domain/transitions.ts`
- Modify: `test/model-lifecycle-concurrency.spec.ts`

**Interfaces:**
- Consumes: `decisions[decision_id].status` and `deliverable.create.payload.decision_ids`.
- Produces: new normative deliverables reject superseded governing decisions while preserving historical decisions and existing deliverable relationships.

- [ ] **Step 1: Add the failing governance reference test**

Append:

```ts
describe("MODEL001 governing references", () => {
  it("rejects a superseded decision and accepts the current replacement for new deliverables", () => {
    let state = emptyProjectState("PRJ-4301", "Governance", "governance");
    state = commit(state, tx(state.project_id, state.revision, "decision.accept", {
      decision_id: "DEC-4301", title: "Old", decision: "Old rule", reason: "Initial", impacts: []
    }));
    state = commit(state, tx(state.project_id, state.revision, "decision.accept", {
      decision_id: "DEC-4302", title: "New", decision: "New rule", reason: "Replacement", impacts: []
    }));
    state = commit(state, tx(state.project_id, state.revision, "decision.supersede", {
      decision_id: "DEC-4301", replacement_decision_id: "DEC-4302", reason: "Replaced"
    }));

    const oldDecision = applyTransaction(state, tx(state.project_id, state.revision, "deliverable.create", {
      deliverable_id: "DEL-4301", title: "Old governance", version: "v1", decision_ids: ["DEC-4301"]
    }));
    expect(oldDecision).toMatchObject({ kind: "rejected", code: "DELIVERABLE_DECISION_NOT_ACCEPTED" });

    const currentDecision = applyTransaction(state, tx(state.project_id, state.revision, "deliverable.create", {
      deliverable_id: "DEL-4302", title: "Current governance", version: "v1", decision_ids: ["DEC-4302"]
    }));
    expect(currentDecision.kind).toBe("commit");
  });
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/model-lifecycle-concurrency.spec.ts
```

Expected: the superseded-decision deliverable currently commits because runtime checks existence only.

- [ ] **Step 3: Implement accepted-status validation**

In `deliverable.create`, use:

```ts
for (const decisionId of p.decision_ids ?? []) {
  const decision = next.decisions[decisionId];
  if (!decision) return rejected("DECISION_NOT_FOUND", `Decision ${decisionId} does not exist`);
  if (decision.status !== "accepted") {
    return rejected(
      "DELIVERABLE_DECISION_NOT_ACCEPTED",
      `Deliverable requires accepted decision ${decisionId}`
    );
  }
}
```

Do not rewrite any already-created deliverable if a governing decision is later superseded.

- [ ] **Step 4: Run GREEN and commit**

```bash
npx vitest run test/model-lifecycle-concurrency.spec.ts test/operations.spec.ts
git add src/domain/transitions.ts test/model-lifecycle-concurrency.spec.ts
git commit -m "feat: require current governing decisions"
```

---

### Task 5: Prove historical schema-1.0 compatibility remains readable

**Files:**
- Modify: `test/project-state-normalizer.spec.ts`
- No production file expected.

**Interfaces:**
- Consumes: `normalizeProjectState`.
- Produces: regression proof that a structurally valid historical lifecycle combination remains readable without revision rewrite or hidden migration.

- [ ] **Step 1: Add the compatibility case**

Append:

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

- [ ] **Step 2: Run compatibility and existing recovery suites**

```bash
npx vitest run test/project-state-normalizer.spec.ts test/project-guard-commit-recovery.spec.ts
```

Expected: PASS without changing `src/domain/project-state-normalizer.ts`. If this step unexpectedly requires stricter parser changes, stop and re-evaluate against the approved no-hidden-migration contract.

- [ ] **Step 3: Commit**

```bash
git add test/project-state-normalizer.spec.ts
git commit -m "test: preserve MODEL001 historical compatibility"
```

---

### Task 6: Verify MODEL001 through ProjectGuard receipts

**Files:**
- Modify: `test/project-guard.spec.ts`

**Interfaces:**
- Consumes: the domain policy through the existing ProjectGuard transaction route.
- Produces: receipt-level proof that stale lifecycle conflicts do not advance revision and stale additive task creation still commits.

- [ ] **Step 1: Add the integration test**

Append inside `describe("ProjectGuard", ...)`:

```ts
it("conflicts stale task lifecycle without advancing revision and still rebases additive task creation", async () => {
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

  const intervening = await submit(projectId, {
    schema_version: "1.0",
    transaction_id: "TXN-PROJECT-1010-0003",
    project_id: projectId,
    base_revision: 2,
    operation: "research.add",
    created_at: at,
    payload: { research_id: "RES-1010", title: "Intervening", body: "Evidence" }
  });
  expect(intervening.new_revision).toBe(3);

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

- [ ] **Step 2: Run the ProjectGuard suite**

```bash
npx vitest run test/project-guard.spec.ts
```

Expected: PASS. If pure transition tests pass but this integration fails, fix only the demonstrated ProjectGuard integration defect and do not introduce another concurrency coordinator.

- [ ] **Step 3: Commit**

```bash
git add test/project-guard.spec.ts
git commit -m "test: prove MODEL001 receipt concurrency"
```

---

### Task 7: Publish the formal domain contract

**Files:**
- Create: `docs/domain-model.md`
- Modify: `docs/project-os-sop.md`
- Modify: `docs/deployment.md`

**Interfaces:**
- Consumes: implemented behavior and approved spec.
- Produces: stable operator/downstream contract for MODEL001, PERSIST001 and INDEX001.

- [ ] **Step 1: Create `docs/domain-model.md`**

Use this complete core contract, expanding only with explanatory examples that do not change semantics:

```markdown
# Project OS Domain Lifecycle and Concurrency Model

## Authority
Canonical commit records are immutable history. `ProjectState` is the current aggregate reconstructed from that history. Markdown, materializations and indexes are derived and reconstructible.

## Concurrency
A stale transaction may rebase only for `research.add`, `constraint.add`, `task.create`, and deprecated `deliverable.add`, after validation against current state. Every other operation requires the current project revision. A stale exact-current operation returns `conflict` and creates no business revision.

## Project lifecycle
`active -> paused -> active`; `active|paused -> completed`; `active|paused|completed -> archived`; archived is terminal. Project completion does not infer child completion.

## Task lifecycle
`pending -> active|blocked|completed`; `active -> blocked|completed`; `blocked -> active|blocked|completed`; completed is terminal. `blocked -> blocked` is an exact-current blocker-reason refresh.

## Phase lifecycle
The first phase is active/current; later phases are pending. Only the single active `current_phase_id` may complete. The lexicographically lowest pending `phase_id` is promoted. New tasks and normative deliverables cannot attach to a completed phase. Phase completion does not fabricate child completion.

## Decisions and research
Decisions are accepted then explicitly superseded without deleting history. Research is append-only evidence; Discovery is the mutable synthesis layer.

## Deliverables
Normative lifecycle remains `planned -> in_progress -> review -> accepted`, with review revision back to `in_progress`, explicit supersession, abandonment, and `legacy_completed` compatibility without inferred acceptance. New governing decision references must be currently accepted.

## Historical compatibility
MODEL001 does not rewrite or reject structurally valid schema-1.0 historical snapshots merely because their stored lifecycle combination would no longer be newly created.

## Deferred schema capabilities
Persisted dependency graphs, per-entity revisions, explicit phase-order fields, research statuses, and new durable relations remain deferred to IMP-SCHEMA001 or a separately approved package.
```

- [ ] **Step 2: Update SOP sections 13 and 15**

In `docs/project-os-sop.md`, make the concurrency section enumerate the four stale-rebasable operations, state that all other operations are exact-current, distinguish conflict from business rejection, and add the one-current-phase/completed-phase-attachment rules. Keep the existing project lifecycle table and add that project/phase completion does not fabricate child completion.

- [ ] **Step 3: Add MODEL001 production proof requirements to deployment docs**

In `docs/deployment.md`, add a dedicated MODEL001 subsection requiring exact merge SHA, `npm run check`, `npx wrangler deploy --dry-run`, production health, continuity `stable`, MutationGate `observe`, current lifecycle success, stale lifecycle conflict with no revision increment, stale additive commit, existing-project read/recovery, and explicit absence of PRJ-0003 repair/SCHEMA runtime.

- [ ] **Step 4: Run documentation-sensitive tests and commit**

```bash
npx vitest run test/render.spec.ts test/rich-render.spec.ts test/v2-boundaries.spec.ts
git add docs/domain-model.md docs/project-os-sop.md docs/deployment.md
git commit -m "docs: formalize Project OS domain model"
```

---

### Task 8: Run exact-head pre-merge verification and open a separate runtime PR

**Files:**
- Verification only unless a gate exposes a defect requiring a new RED/GREEN cycle.

**Interfaces:**
- Consumes: final implementation branch head.
- Produces: fresh exact-head evidence and an implementation PR ready for human review.

- [ ] **Step 1: Run focused MODEL001 tests**

```bash
npx vitest run \
  test/model-lifecycle-concurrency.spec.ts \
  test/transitions.spec.ts \
  test/operations.spec.ts \
  test/project-state-normalizer.spec.ts \
  test/project-guard.spec.ts \
  test/project-guard-commit-recovery.spec.ts
```

- [ ] **Step 2: Run the full repository gate**

```bash
npm install
npm run check
```

Require exit 0 for Wrangler types, TypeScript typecheck and the complete Vitest suite.

- [ ] **Step 3: Run Worker dry-run**

```bash
npx wrangler deploy --dry-run
```

Require exit 0 and no production deployment.

- [ ] **Step 4: Verify forbidden drift is absent on the exact head**

Confirm the diff has these properties:

```text
src/domain/project-state.ts        unchanged
src/domain/transaction.ts          unchanged
wrangler.jsonc                     unchanged
PROJECT_OS_CONTINUITY_MODE         stable
PROJECT_OS_MUTATION_GATE_MODE      observe
PRJ-0003 business/provider files   untouched
IMP-SCHEMA001 runtime              absent
```

- [ ] **Step 5: Apply verification-before-completion discipline**

If any commit occurs after Steps 1-4, rerun the affected focused tests, `npm run check`, and dry-run on the new exact head before making a success claim or opening the PR.

- [ ] **Step 6: Open the implementation PR**

Open `imp/model001-lifecycle-concurrency` -> `main` and include approved spec/plan paths, exact base/head SHAs, observed RED/GREEN evidence, focused/full test results, dry-run result, schema/MutationGate/PRJ-0003 boundaries, and rollback statement `code rollback only; canonical history is never rewritten`.

Do not merge or deploy in this task.

---

## Gate 1: Explicit runtime merge/deployment approval

Present the exact implementation PR head, changed files, fresh test results, dry-run result and review findings. The next authorization must explicitly cover runtime PR merge and production deployment. Until then:

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
- No source edit is expected after approval. If the PR head changes, return to Task 8 verification before merge.

**Interfaces:**
- Consumes: explicitly approved runtime PR head.
- Produces: exact merge SHA, successful main deployment evidence and production health evidence.

- [ ] **Step 1: Reconfirm approved PR head identity**

Compare the user-approved head SHA to the current PR head and stop if they differ.

- [ ] **Step 2: Merge and record exact merge SHA**

Merge only the reviewed head. Record the merge SHA; do not infer deployment from merge status.

- [ ] **Step 3: Verify deployment workflow for that SHA**

Confirm checkout, credentials check, Node setup, dependency install, `npm run check`, Worker deploy, production health check and deployment-status publication succeed for the exact merge commit.

- [ ] **Step 4: Verify production boundary**

Verify `/health` succeeds and deployed configuration remains consistent with:

```text
PROJECT_OS_CONTINUITY_MODE=stable
PROJECT_OS_MUTATION_GATE_MODE=observe
```

---

### Task 10: Run isolated production behavior proof

**Files:**
- No repository source edit.
- Durable test evidence: one isolated production probe project created under the explicit runtime deployment approval gate and archived at the end.

**Interfaces:**
- Consumes: deployed exact MODEL001 merge SHA.
- Produces: receipt evidence for current lifecycle success, stale lifecycle conflict, stale additive commit and final archival without touching PRJ-0003.

- [ ] **Step 1: Create isolated project**

Submit typed `project.create` with `project_id: "PRJ-AUTO"`, name `MODEL001 production probe`, slug `model001-production-probe`, aliases `[]`, objective `Validate MODEL001 lifecycle and concurrency semantics in production without using a business project.` Require committed revision 1 and record the allocated PRJ ID.

- [ ] **Step 2: Create lifecycle target**

At base revision 1, create `TASK-MODELPROBE001` titled `MODEL001 lifecycle target`. Require committed revision 2.

- [ ] **Step 3: Create intervening evidence**

At base revision 2, add `RES-MODELPROBE001` titled `MODEL001 synthetic production probe` with body `Synthetic MODEL001 production probe evidence only; not business research.` Require committed revision 3.

- [ ] **Step 4: Prove stale lifecycle conflict**

Submit a fresh `task.start` transaction for `TASK-MODELPROBE001` with stale `base_revision: 2`. Require:

```text
status=conflict
code=STALE_REVISION
new_revision=3
event_id absent
```

Refresh canonical state and verify revision remains 3 and `TASK-MODELPROBE001` remains pending.

- [ ] **Step 5: Prove exact-current lifecycle success**

Submit a new `task.start` transaction at base revision 3. Require committed revision 4 and task status `active`.

- [ ] **Step 6: Prove stale additive create still rebases**

Submit `task.create` for unique `TASK-MODELPROBE002` using stale `base_revision: 2` while canonical state is revision 4. Require committed revision 5.

- [ ] **Step 7: Close and archive the probe**

Complete `TASK-MODELPROBE001` at base 5 -> revision 6; complete `TASK-MODELPROBE002` at base 6 -> revision 7; archive the probe project at base 7 -> revision 8 with reason `MODEL001 production proof completed`.

- [ ] **Step 8: Verify existing-project readability without mutation**

Read PRJ-0002 canonical state and one historical schema-1.0 project through normal read paths. PRJ-0003 may be read only if needed for compatibility evidence; do not write, repair, adopt, reject, move or overwrite anything in PRJ-0003.

- [ ] **Step 9: Capture proof evidence**

Record exact merge SHA, deployment workflow/run evidence, health result, probe project ID, every committed/conflict transaction ID and final archived revision. Record secret names only, never secret values.

---

### Task 11: Canonically close MODEL001 and revalidate downstream roadmap

**Files:**
- Project OS typed transactions for canonical closure.
- Read-only dependency revalidation against current `docs/project-os-improvement-roadmap.md` and current downstream package documents.

**Interfaces:**
- Consumes: Tasks 9-10 exact production evidence.
- Produces: `RES-IMPMODELIMPL001`, completed `TASK-IMPMODEL001`, and a fresh dependency conclusion for `IMP-PERSIST001`.

- [ ] **Step 1: Refresh PRJ-0002 current revision**

Use canonical structured state, not remembered chat revision.

- [ ] **Step 2: Add canonical implementation/production research**

Submit `research.add` for `RES-IMPMODELIMPL001`. Its body must include the implemented semantics, exact runtime PR number/head, exact merge SHA, focused/full verification results, Wrangler dry-run result, deployment/health evidence, probe project ID and receipt outcomes, continuity `stable`, MutationGate `observe`, and explicit confirmation that PRJ-0003 repair and SCHEMA runtime did not occur. Its `source` must cite exact GitHub/deployment evidence rather than this conversation.

Continue only after its receipt is `committed`.

- [ ] **Step 3: Complete `TASK-IMPMODEL001`**

Submit `task.complete` at the refreshed current revision with this result text:

```text
IMP-MODEL001 implemented, fully verified, merged and production-validated on the exact recorded commit. Formal lifecycle/concurrency semantics are active without a ProjectState schema bump; historical schema-1.0 compatibility is preserved; MutationGate remains observe; PRJ-0003 repair and SCHEMA runtime were not performed.
```

Require a committed receipt.

- [ ] **Step 4: Refresh HANDOFF/STATE and revalidate PERSIST001**

Confirm MODEL001 is canonically completed, then compare `IMP-PERSIST001` assumptions to the exact new `main`. If PERSIST001 remains independent of the still-separate MutationGate/SCHEMA gates, begin its analysis/design package next. Keep any genuine SCHEMA-dependent subset isolated.

---

## Plan self-review result

- Every approved MODEL001 requirement maps to a concrete task above.
- Every behavior-changing production edit has an explicit failing test first.
- The concurrency policy fails closed: only four operations are stale-rebasable.
- Direct task completion and exact-current blocker-reason refresh are preserved.
- Pending/non-current phase completion is rejected; known multiple-active phase state fails closed.
- Completed phases reject new task and normative deliverable attachment.
- Phase/project closure does not fabricate child completion.
- Superseded decisions stay in history but cannot newly govern a deliverable.
- Historical schema-1.0 reader compatibility is protected without parser/schema tightening.
- ProjectGuard serialization is reused rather than replaced.
- Pre-merge verification, runtime merge/deployment approval, production proof and canonical closure are distinct gates.
- MutationGate remains observe; PRJ-0003 repair and SCHEMA runtime remain outside this plan.
