# SOP Enforcement V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Project OS so project framing, discovery synthesis, and deliverable lifecycle are represented canonically and rendered truthfully without inferring one SOP concept from another.

**Architecture:** Add explicit `framing` and `discovery` objects to `ProjectState`, normalize old stored state on read, extend the closed typed transaction union with exact-revision semantic updates and a richer deliverable lifecycle, then render the human workspace directly from those canonical concepts. Existing ProjectGuard serialization, receipt gating, event history, IDs, revisions, and Dropbox layout remain unchanged.

**Tech Stack:** TypeScript 5.9, Zod 4, Vitest 4, Cloudflare Workers/Durable Objects, Dropbox persistence, GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-08-21-sop-enforcement-v2-design.md`

## Global Constraints

- Keep transaction envelope `schema_version: "1.0"`.
- Keep project state `schema_version: "1.0"` for this rollout.
- Do not rewrite historical events or increment revision during pure normalization/materialization.
- Never infer deliverable acceptance from legacy `completed`, task completion, file creation, or silence.
- Preserve ProjectGuard serialization, transaction-id idempotency, receipt-last persistence, and exact conflict behavior.
- Preserve current project IDs, aliases, lifecycle rules, Dropbox V2 layout, Durable Object bindings, and declarative `exports` configuration.
- Keep `ROADMAP.md` primary horizons as `Current / Next / Later`.
- All production behavior changes follow RED → GREEN → refactor with a failing test observed before implementation.

---

## File Structure

- Create `src/domain/project-state-normalizer.ts` — validates/normalizes legacy and V2 in-memory project state.
- Modify `src/domain/project-state.ts` — canonical V2-compatible types for framing, discovery, and deliverables.
- Modify `src/domain/transitions.ts` — defaults plus new semantic transitions.
- Modify `src/domain/transaction.ts` — new typed transaction discriminants and payload validation.
- Modify `src/durable/project-guard.ts` — normalize state on read before transitions/materialization.
- Modify `src/render/brief.ts` — render framing only.
- Modify `src/render/discovery.ts` — render synthesis only, with research links.
- Modify `src/render/deliverable.ts` — render lifecycle/version/acceptance/history metadata.
- Modify `src/render/roadmap.ts` — map richer deliverable statuses without changing horizon semantics.
- Modify `test/operations.spec.ts` — transaction and transition contracts.
- Modify `test/render.spec.ts` — Brief/Discovery/Roadmap contracts.
- Modify `test/rich-render.spec.ts` — deliverable rendering contract.
- Create `test/project-state-normalizer.spec.ts` — compatibility and idempotence.
- Modify `test/project-guard.spec.ts` — stored legacy state is normalized without business revision changes.
- Modify `docs/project-os-sop.md` and `docs/deployment.md` only where runtime semantics/rollout references need to point at the new canonical fields and legacy compatibility status.

---

### Task 1: Backward-compatible canonical state normalization

**Files:**
- Create: `src/domain/project-state-normalizer.ts`
- Modify: `src/domain/project-state.ts`
- Modify: `src/domain/transitions.ts`
- Create: `test/project-state-normalizer.spec.ts`

**Interfaces:**
- Produces: `normalizeProjectState(input: unknown): ProjectState`
- Produces: `ProjectFraming`, `DiscoveryFinding`, `DiscoverySynthesis`, and expanded `DeliverableStatus`/`DeliverableRecord`.
- Later tasks consume normalized `framing`, `discovery`, `deliverable.decision_ids`, and V2 deliverable statuses.

- [ ] **Step 1: Write the failing normalizer tests**

Create `test/project-state-normalizer.spec.ts` with tests equivalent to:

```ts
import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { normalizeProjectState } from "../src/domain/project-state-normalizer";

it("adds empty framing and discovery without changing revision", () => {
  const legacy = emptyProjectState("PRJ-3001", "Legacy", "legacy");
  const raw = structuredClone(legacy) as Record<string, unknown>;
  delete raw.framing;
  delete raw.discovery;
  const normalized = normalizeProjectState(raw);
  expect(normalized.revision).toBe(0);
  expect(normalized.framing).toEqual({
    scope: [], out_of_scope: [], success_criteria: [], stakeholders: [], open_questions: []
  });
  expect(normalized.discovery).toEqual({
    confirmed_findings: [], provisional_findings: [], unresolved_questions: [], next_exploration: []
  });
});

it("maps legacy deliverable statuses without inventing acceptance", () => {
  const legacy = emptyProjectState("PRJ-3002", "Legacy", "legacy");
  legacy.deliverables["DEL-3001"] = {
    deliverable_id: "DEL-3001", title: "Report", status: "pending",
    created_at: "2026-08-20T18:00:00.000Z", updated_at: "2026-08-20T18:00:00.000Z"
  } as never;
  legacy.deliverables["DEL-3002"] = {
    deliverable_id: "DEL-3002", title: "Old final", status: "completed",
    created_at: "2026-08-20T18:00:00.000Z", updated_at: "2026-08-20T18:00:00.000Z"
  } as never;
  const normalized = normalizeProjectState(legacy);
  expect(normalized.deliverables["DEL-3001"].status).toBe("planned");
  expect(normalized.deliverables["DEL-3002"].status).toBe("legacy_completed");
  expect(normalized.deliverables["DEL-3002"].acceptance_note).toBeUndefined();
});

it("is idempotent", () => {
  const state = emptyProjectState("PRJ-3003", "Idempotent", "idempotent");
  expect(normalizeProjectState(normalizeProjectState(state))).toEqual(normalizeProjectState(state));
});
```

- [ ] **Step 2: Run RED**

Run CI-equivalent targeted tests:

```bash
npx vitest run test/project-state-normalizer.spec.ts
```

Expected: FAIL because `project-state-normalizer` and new canonical fields/statuses do not exist.

- [ ] **Step 3: Add canonical types and defaults**

In `src/domain/project-state.ts`, introduce:

```ts
export interface ProjectFraming {
  scope: string[];
  out_of_scope: string[];
  success_criteria: string[];
  stakeholders: string[];
  open_questions: string[];
}

export interface DiscoveryFinding {
  summary: string;
  research_ids: string[];
}

export interface DiscoverySynthesis {
  confirmed_findings: DiscoveryFinding[];
  provisional_findings: DiscoveryFinding[];
  unresolved_questions: string[];
  next_exploration: string[];
}

export type DeliverableStatus =
  | "planned" | "in_progress" | "review" | "accepted"
  | "superseded" | "abandoned" | "legacy_completed";
```

Extend `DeliverableRecord` with `owner`, `version`, `phase_id`, `decision_ids`, `acceptance_note`, `accepted_at`, `supersedes`, `superseded_by`, `superseded_reason`, and `abandoned_reason`. Add `framing` and `discovery` to `ProjectState`.

In `emptyProjectState()` initialize both objects with empty arrays.

- [ ] **Step 4: Implement strict deterministic normalizer**

Create `src/domain/project-state-normalizer.ts`. It should reject non-object/non-state inputs, validate required legacy core fields, clone the state, default missing V2 fields, normalize deliverables, and return `ProjectState`. Core status mapping:

```ts
function normalizeDeliverableStatus(status: unknown): DeliverableStatus {
  if (status === "pending") return "planned";
  if (status === "completed") return "legacy_completed";
  if (["planned", "in_progress", "review", "accepted", "superseded", "abandoned", "legacy_completed"].includes(String(status))) {
    return status as DeliverableStatus;
  }
  throw new Error(`Invalid deliverable status: ${String(status)}`);
}
```

Every normalized deliverable gets `decision_ids: existingArrayOrEmpty` and no synthesized acceptance fields.

- [ ] **Step 5: Run GREEN and regression suite**

```bash
npx vitest run test/project-state-normalizer.spec.ts test/operations.spec.ts test/render.spec.ts test/rich-render.spec.ts
```

Expected: PASS after adapting legacy test fixtures to the new in-memory statuses while preserving old transaction behavior in Task 3.

- [ ] **Step 6: Commit**

Commit message:

```text
feat: normalize SOP V2 project state
```

---

### Task 2: Explicit project framing and discovery synthesis transactions

**Files:**
- Modify: `src/domain/transaction.ts`
- Modify: `src/domain/transitions.ts`
- Modify: `test/operations.spec.ts`

**Interfaces:**
- Produces operation `project.framing.update`.
- Produces operation `discovery.synthesis.update`.
- Both require exact current revision.

- [ ] **Step 1: Write failing transaction/transition tests**

Add tests that build transactions through the existing typed helper:

```ts
state = commit(state, tx(state.project_id, state.revision, "project.framing.update", {
  scope: ["Agency offer design"],
  success_criteria: ["Validated offer"],
  stakeholders: ["Owner"]
}));
expect(state.framing.scope).toEqual(["Agency offer design"]);
expect(state.framing.success_criteria).toEqual(["Validated offer"]);

state.research["RES-3001"] = {
  research_id: "RES-3001", title: "Interviews", body: "Evidence", created_at: at
};
state = commit(state, tx(state.project_id, state.revision, "discovery.synthesis.update", {
  confirmed_findings: [{ summary: "SMBs value speed", research_ids: ["RES-3001"] }],
  unresolved_questions: ["Preferred pricing model?"]
}));
expect(state.discovery.confirmed_findings[0].research_ids).toEqual(["RES-3001"]);
```

Also test: empty payload rejected by Zod; missing research ID rejected by transition; stale base revision conflicts for both operations; array replacement clears old values when `[]` is supplied.

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/operations.spec.ts
```

Expected: FAIL because operation discriminants are missing.

- [ ] **Step 3: Extend transaction schema**

Add `project.framing.update` with optional objective/framing fields and `.refine()` requiring at least one field. Add `discovery.synthesis.update` with optional replacement fields and `.refine()` requiring at least one field. Finding entries use strict objects:

```ts
const discoveryFinding = z.strictObject({
  summary: nonEmpty,
  research_ids: z.array(stableId("RES")).default([])
});
```

- [ ] **Step 4: Implement transitions and exact-revision rules**

Add both operation names to `exactRevisionOperations`. `project.framing.update` replaces only supplied fields. `discovery.synthesis.update` verifies every referenced research ID exists before replacing supplied synthesis fields.

- [ ] **Step 5: Run GREEN**

```bash
npx vitest run test/operations.spec.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```text
feat: add framing and discovery transactions
```

---

### Task 3: Normative deliverable lifecycle with explicit acceptance

**Files:**
- Modify: `src/domain/transaction.ts`
- Modify: `src/domain/transitions.ts`
- Modify: `test/operations.spec.ts`

**Interfaces:**
- Produces operations `deliverable.create`, `deliverable.start`, `deliverable.revise`, `deliverable.submit_review`, `deliverable.accept`, `deliverable.supersede`, `deliverable.abandon`.
- Retains parsing/behavior of deprecated `deliverable.add` and `deliverable.complete`, mapping them to `planned` and `legacy_completed` respectively.

- [ ] **Step 1: Write failing lifecycle tests**

Cover the full happy path:

```ts
state = commit(state, tx(state.project_id, state.revision, "deliverable.create", {
  deliverable_id: "DEL-3101", title: "Strategy", version: "v1"
}));
expect(state.deliverables["DEL-3101"].status).toBe("planned");
state = commit(state, tx(state.project_id, state.revision, "deliverable.start", { deliverable_id: "DEL-3101" }));
state = commit(state, tx(state.project_id, state.revision, "deliverable.submit_review", { deliverable_id: "DEL-3101" }));
state = commit(state, tx(state.project_id, state.revision, "deliverable.accept", {
  deliverable_id: "DEL-3101", acceptance_note: "Explicitly approved by user"
}));
expect(state.deliverables["DEL-3101"].status).toBe("accepted");
expect(state.deliverables["DEL-3101"].accepted_at).toBe(at);
```

Cover revision from review back to in-progress, accepted supersession linkage, abandonment from planned/in-progress/review/legacy_completed, and rejection of invalid transitions. Add a test proving deprecated `deliverable.complete` results in `legacy_completed`, never `accepted`. Add a test proving explicit `deliverable.accept` may promote `legacy_completed → accepted` only when the new acceptance transaction and note are provided.

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/operations.spec.ts
```

Expected: FAIL on missing discriminants/lifecycle.

- [ ] **Step 3: Add strict transaction payloads**

Implement strict schemas. `deliverable.create.version` and `deliverable.accept.acceptance_note` are non-empty. `phase_id`, `decision_ids`, and replacement IDs use stable IDs and are checked against current state during transition.

- [ ] **Step 4: Implement lifecycle transitions**

Rules:

```text
create -> planned
planned -> start -> in_progress
in_progress -> submit_review -> review
review -> revise(new version) -> in_progress
in_progress -> revise(new version) -> in_progress
review -> accept(note) -> accepted
legacy_completed -> accept(note) -> accepted
accepted + accepted replacement -> supersede(original, replacement, reason) -> original superseded
planned|in_progress|review|legacy_completed -> abandon(reason) -> abandoned
```

`deliverable.supersede` sets reciprocal `superseded_by` / `supersedes` only at supersession time. Accepted items cannot be abandoned.

- [ ] **Step 5: Preserve deprecated compatibility**

`deliverable.add` creates `planned` with `decision_ids: []` and no invented version. `deliverable.complete` moves a non-terminal non-accepted record to `legacy_completed` and retains optional outcome.

- [ ] **Step 6: Run GREEN and typecheck**

```bash
npx vitest run test/operations.spec.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```text
feat: enforce deliverable lifecycle
```

---

### Task 4: Truthful Brief, Discovery, Deliverable, and Roadmap rendering

**Files:**
- Modify: `src/render/brief.ts`
- Modify: `src/render/discovery.ts`
- Modify: `src/render/deliverable.ts`
- Modify: `src/render/roadmap.ts`
- Modify: `test/render.spec.ts`
- Modify: `test/rich-render.spec.ts`

**Interfaces:**
- Consumes `state.framing`, `state.discovery`, expanded deliverable records.
- Produces Markdown matching the adopted SOP sections.

- [ ] **Step 1: Write failing Brief/Discovery renderer tests**

For Brief assert exact semantic separation:

```ts
state.framing.scope = ["Offer design"];
state.framing.out_of_scope = ["Paid media execution"];
state.framing.success_criteria = ["Offer explicitly validated"];
state.framing.stakeholders = ["Owner"];
state.framing.open_questions = ["Which niche first?"];
const brief = renderBrief(state);
expect(brief).toContain("## Scope");
expect(brief).toContain("Offer design");
expect(brief).toContain("## Success criteria");
expect(brief).toContain("Offer explicitly validated");
expect(brief).not.toContain("Launch — Go live");
```

For Discovery assert only synthesized findings are shown and unrelated research/blockers/phase actions are not dumped unless represented in synthesis.

- [ ] **Step 2: Write failing deliverable renderer tests**

Assert `Version`, related decisions, acceptance note/date, supersession reason, abandonment reason, and the explicit `legacy_completed` warning.

- [ ] **Step 3: Run RED**

```bash
npx vitest run test/render.spec.ts test/rich-render.spec.ts
```

Expected: FAIL with old derivation-based renderers.

- [ ] **Step 4: Implement Brief renderer**

Render: Purpose, Scope, Out of scope, Boundaries, Stakeholders, Success criteria, Open questions. Use deterministic empty messages and never fall back to phase/deliverable data for these concepts.

- [ ] **Step 5: Implement Discovery renderer**

Render confirmed/provisional findings with links such as:

```text
- SMBs value speed — [[RESEARCH/RES-3001|RES-3001]]
```

Then unresolved questions, explore next, and accepted decision links. Do not automatically list all research records or blocked tasks.

- [ ] **Step 6: Implement deliverable and Roadmap status rendering**

Deliverable note exposes lifecycle metadata. Roadmap retains `Current / Next / Later` and displays richer deliverable statuses verbatim, including `legacy_completed`, instead of collapsing them to pending/completed.

- [ ] **Step 7: Run GREEN**

```bash
npx vitest run test/render.spec.ts test/rich-render.spec.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```text
feat: render canonical SOP concepts
```

---

### Task 5: ProjectGuard normalization, full regression, rollout documentation, and stress-test readiness

**Files:**
- Modify: `src/durable/project-guard.ts`
- Modify: `test/project-guard.spec.ts`
- Modify: `docs/project-os-sop.md`
- Modify: `docs/deployment.md`
- Potentially modify tests that construct raw legacy `ProjectState` fixtures so they prove normalization rather than bypassing it.

**Interfaces:**
- `ProjectGuard.loadState()` consumes persisted JSON and returns `normalizeProjectState(JSON.parse(...))`.
- `/materialize` renders normalized state without creating an event or changing revision.

- [ ] **Step 1: Write failing ProjectGuard compatibility tests**

Seed Durable Object stored state with a legacy JSON object lacking `framing`/`discovery` and containing `completed` deliverable status. Exercise materialization/transaction through the real guard boundary and assert no load/type failure, unchanged pre-transaction revision, and compatibility status `legacy_completed` in the rendered/materialized representation.

- [ ] **Step 2: Run RED**

```bash
npx vitest run test/project-guard.spec.ts
```

Expected: FAIL because `loadState()` raw-casts JSON.

- [ ] **Step 3: Normalize on ProjectGuard read**

Change:

```ts
return row ? JSON.parse(row.state_json) as ProjectState : null;
```

to:

```ts
return row ? normalizeProjectState(JSON.parse(row.state_json)) : null;
```

Do not persist normalized representation solely because it was read/materialized.

- [ ] **Step 4: Run full verification**

```bash
npm install
npm run check
npx wrangler deploy --dry-run
```

Expected: all tests/type generation/typecheck pass and Wrangler dry-run succeeds.

- [ ] **Step 5: Review requirements against spec**

Verify explicitly:

```text
framing represented canonically
Discovery synthesis represented canonically
legacy completed not accepted
new acceptance explicit
supersession preserves history
normalization no revision/event
old transaction parsing retained
ROADMAP Current/Next/Later retained
Brief/Discovery no cross-concept derivation
ProjectGuard/receipt/idempotency unchanged
```

- [ ] **Step 6: Update rollout documentation**

Document the compatibility status `legacy_completed`, pure normalization/materialization rule, and post-deploy verification sequence. Do not document secrets or change Cloudflare binding strategy.

- [ ] **Step 7: Commit**

```text
feat: integrate SOP V2 with ProjectGuard
```

- [ ] **Step 8: Open implementation PR and verify CI + Cloudflare preview**

PR body must reference `DEC-SOPENF002`, the design spec, this implementation plan, RED/GREEN evidence, and compatibility behavior. Do not merge until GitHub CI is green and Cloudflare Workers build/preview signal is acceptable.

- [ ] **Step 9: Production rollout after merge**

After successful Cloudflare production deployment, verify `/health`, then use only the dedicated fictitious `PRJ-0004` for the second stress test. Confirm materialized `BRIEF.md`, `DISCOVERY.md`, `ROADMAP.md`, deliverable notes, decision supersession, and Markdown-only clean-room reconstruction. Real projects must not receive fictitious stress data.
