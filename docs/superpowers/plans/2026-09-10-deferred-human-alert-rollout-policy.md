# Deferred human-alert rollout policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permit an explicitly deferred human-alert policy to remove only notification acknowledgement from rollout blockers.

**Architecture:** A pure policy type in `src/convergence/rollout.ts` has a default value of `required`. `rolloutBlockers` receives an explicit policy and, only under `deferred`, treats `notification_ack_proven` as recorded but non-blocking. Existing incidents, retry state, metrics, capacity admission, and every other rollout-evidence field are unchanged.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers environment types.

**Spec:** [Deferred human-alert rollout policy](../specs/2026-09-10-deferred-human-alert-rollout-policy-design.md)

## Global Constraints

- `required` is the default when no explicit rollout-review policy is supplied.
- `deferred` excludes only `notification_ack_proven`; all other false rollout evidence remains a blocker.
- Do not add a notification provider, external service, queue, Durable Object, canonical Dropbox mutation, deployment, canary, merge, or PRJ-0003 repair.
- Keep durable incident records, optional monitoring delivery code, retries, and structured metrics intact.
- Production remains off until every non-notification gate and the separately authorized canary qualification are proven.
- Use `NODE=/Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`; `node` and `npm` are absent from `PATH`.

---

## File structure

- `src/convergence/rollout.ts` owns the explicit human-alert policy parser and evidence evaluation rule.
- `test/convergence-rollout.spec.ts` proves default fail-closed behavior, the explicit exception, and preservation of every other blocker.
- `docs/deployment.md` and `docs/materialization.md` record the operational policy without claiming an acknowledgement, deployment, or activation.

### Task 1: Make the deferred policy explicit and fail closed

**Files:**
- Modify: `src/convergence/rollout.ts`
- Modify: `test/convergence-rollout.spec.ts`

**Interfaces:**
- Produces: `export type HumanAlertPolicy = "required" | "deferred"`.
- Changes: `export function rolloutBlockers(evidence: RolloutEvidence, policy?: HumanAlertPolicy): string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
it("requires a notification acknowledgement by default and defers only that evidence explicitly", () => {
  const evidence: RolloutEvidence = {
    reader_compatible: true, single_writer: true, fencing_proven: true,
    registry_continuation_proven: true, notification_ack_proven: false,
    transport_complete: false, capacity_qualified: true, recovery_qualified: true,
    compatible_stable_ready: false
  };
  expect(rolloutBlockers(evidence)).toEqual([
    "compatible_stable_ready", "notification_ack_proven", "transport_complete"
  ]);
  expect(rolloutBlockers(evidence, "deferred")).toEqual([
    "compatible_stable_ready", "transport_complete"
  ]);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
"$NODE" node_modules/vitest/vitest.mjs run test/convergence-rollout.spec.ts
```

Expected: FAIL because `rolloutBlockers` still retains `notification_ack_proven` when it is given the explicit `deferred` policy.

- [ ] **Step 3: Implement the smallest pure policy**

```ts
export type HumanAlertPolicy = "required" | "deferred";

export function rolloutBlockers(
  evidence: RolloutEvidence,
  policy: HumanAlertPolicy = "required"
): string[] {
  return Object.entries(evidence)
    .filter(([name, proven]) => !proven && !(policy === "deferred" && name === "notification_ack_proven"))
    .map(([name]) => name)
    .sort();
}
```

Do not add an environment variable: this rollout evidence function has no runtime consumer. A production review supplies `"deferred"` explicitly and records that decision in its evidence.

- [ ] **Step 4: Run focused tests and type checking**

Run:

```bash
"$NODE" node_modules/vitest/vitest.mjs run test/convergence-rollout.spec.ts
"$NODE" node_modules/typescript/bin/tsc --noEmit
```

Expected: PASS. The test must demonstrate that the default `required` policy cannot waive acknowledgement and that `deferred` cannot waive transport or compatible-stable evidence.

- [ ] **Step 5: Commit the tested policy**

```bash
git add src/convergence/rollout.ts test/convergence-rollout.spec.ts
git commit -m "feat: allow explicit deferred human alert rollout policy"
```

### Task 2: Record the operational exception without overstating production readiness

**Files:**
- Modify: `docs/deployment.md`
- Modify: `docs/materialization.md`
- Test: `test/convergence-rollout.spec.ts`

**Interfaces:**
- Consumes: `HumanAlertPolicy` and `rolloutBlockers` from Task 1.
- Produces: documentation that states `notification_ack_proven` is false and deferred only under an explicit policy.

- [ ] **Step 1: Add the failing documentation-facing assertion**

Extend the Task 1 test with a second false evidence field and assert that `deferred` retains it:

```ts
expect(rolloutBlockers({ ...evidence, recovery_qualified: false }, "deferred"))
  .toEqual(["compatible_stable_ready", "recovery_qualified", "transport_complete"]);
```

- [ ] **Step 2: Run the focused test to verify the preservation oracle**

Run:

```bash
"$NODE" node_modules/vitest/vitest.mjs run test/convergence-rollout.spec.ts
```

Expected: PASS after Task 1. This is a regression guard: no future documentation or policy refactor may broaden the exception.

- [ ] **Step 3: Record the bounded operational policy**

Add a dated deployment evidence paragraph stating:

```markdown
Human-facing notification delivery is deliberately deferred. A production review may explicitly
record `human_alert_policy: deferred`; only `notification_ack_proven` is non-blocking
under that policy. The field remains false, incidents remain durable, and all other rollout,
canary, capacity, recovery, transport, reader, fencing, and writer gates remain required.
```

In `docs/materialization.md`, state that missing monitoring configuration preserves durable incidents and retry state; it does not create an acknowledgement or change repair behavior.

- [ ] **Step 4: Run the final local verification set**

Run:

```bash
"$NODE" node_modules/typescript/bin/tsc --noEmit
"$NODE" node_modules/vitest/vitest.mjs run test/convergence-rollout.spec.ts test/convergence-observability.spec.ts
"$NODE" node_modules/vitest/vitest.mjs run
"$NODE" node_modules/wrangler/bin/wrangler.js deploy --dry-run
git diff --check
git status --short
```

Expected: all tests and dry-run pass; `worker-configuration.d.ts`, if generated, is removed before the final status check; no deployment occurs.

- [ ] **Step 5: Commit the evidence**

```bash
git add docs/deployment.md docs/materialization.md test/convergence-rollout.spec.ts
git commit -m "docs: record deferred human alert rollout policy"
```

## Plan self-review

- Spec coverage: Task 1 implements the explicit default-fail-closed policy and the single allowed exception. Task 2 records the no-external-service decision and proves every other evidence field is unchanged.
- Placeholder scan: no unresolved placeholders, generic test requests, or undefined interfaces remain.
- Type consistency: `HumanAlertPolicy` and the optional second argument to `rolloutBlockers` are introduced in Task 1 and consumed with the same names in Task 2.
