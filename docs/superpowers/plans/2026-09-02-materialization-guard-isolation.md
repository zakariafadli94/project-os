# MaterializationGuard Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move projection/materialization execution into a separately bound `MaterializationGuard` Durable Object so ProjectGuard canonical transactions no longer share Cloudflare I/O context with projection work.

**Architecture:** Keep immutable canonical commit records and ProjectGuard as business truth. Add one `MaterializationGuard` per project, backed by its own SQLite Durable Object and alarm, and move the existing `MaterializationLedger`/`MaterializationCoordinator`/`WorkspaceProjectionWriter` ownership there. ProjectGuard schedules projection with a lightweight internal DO call and retains compatibility endpoints that forward without doing local Dropbox projection I/O.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers Durable Objects with SQLite and alarms, Dropbox persistence boundary, Vitest 4 with `@cloudflare/vitest-pool-workers`, Wrangler 4.

**Spec:** `docs/superpowers/specs/2026-09-02-materialization-guard-isolation-design.md`

## Global Constraints

- Immutable canonical commit records remain authoritative business truth.
- Projection/materialization failure must never rewind or invalidate a committed business revision.
- ProjectGuard must not perform projection/human-view Dropbox I/O after cutover.
- MaterializationGuard must never create or mutate business revisions.
- No user-visible `SYNC`, `REFRESH`, `MATERIALIZE`, retry, or recovery command is introduced.
- Dropbox remains the production persistence provider.
- Existing Projection Engine semantics, evidence formats, hash verification, coalescing, archive handling, and projection version remain unchanged.
- MaterializationGuard hot SQLite remains reconstructible from canonical state/commits and durable materialization generation/head evidence.
- Existing ProjectGuard materialization SQLite tables are not migrated; they become unused legacy hot state.
- `MATERIALIZATION_GUARD` uses the repository's existing Wrangler Durable Object pattern: `state: "created"`, `storage: "sqlite"`.
- `IMP-INDEX001` remains the active product improvement and is not modified or completed by this incident fix.
- Every new behavior is introduced test-first; do not combine unrelated refactors.

## File Structure

- Create `src/durable/materialization-guard.ts` — owns projection ledger/coordinator/writer, provider-I/O routes, local serialization, and projection alarm.
- Create `src/materialization/handoff.ts` — small internal target-request helper used by ProjectGuard; scheduling failure is logged and swallowed after canonical commit.
- Modify `src/durable/project-guard-neutral.ts` — remove local projection ownership, expose canonical recovery to subclasses, forward legacy projection endpoints, drain legacy alarms, schedule targets through the new binding.
- Modify `src/durable/project-guard.ts` — keep referral/input recovery unchanged; inherit the protected canonical recovery helper.
- Modify `src/durable/project-guard-mutation-gate.ts` — replace `materialization-status` recovery side-channel with direct canonical recovery helper.
- Modify `src/durable/project-guard-subrequest-resilient.ts` — remove projection routes from fast-forward set; replace `materialization-status` recovery side-channel; remove materialization-alarm serialization responsibility.
- Modify `src/index-neutral.ts` — route fleet reconciliation and explicit materialization directly to `MATERIALIZATION_GUARD`.
- Modify `src/index-mutation-gate.ts` — export `MaterializationGuard`.
- Modify `wrangler.jsonc` — add the new DO binding/export.
- Modify `package.json` — add isolation regression test to `test:persistence-high-risk`.
- Create `test/materialization-guard-isolation.spec.ts` — boundary, forwarding, alarm ownership, handoff, reconstruction, coalescing, binding mismatch, and serialization tests.
- Modify `test/materialization-faults.spec.ts` — run projection alarms and projection status/reconcile through `MATERIALIZATION_GUARD` while preserving all existing Projection Engine assertions.
- Modify `test/project-guard-alarm-serialization.spec.ts` — replace the old same-DO alarm/transaction assertion with proof that a ProjectGuard legacy alarm performs no Dropbox projection I/O.

---

### Task 1: Establish the RED Durable Object boundary

**Files:**
- Create: `test/materialization-guard-isolation.spec.ts`

**Interfaces:**
- Consumes existing `env.PROJECT_GUARD`, Dropbox mock, `CURRENT_PROJECTION_VERSION`, and `runDurableObjectAlarm`.
- Produces the behavioral contract that later tasks must satisfy.

- [ ] **Step 1: Add a failing binding test without requiring generated types**

Use a structural cast so the test compiles before Wrangler knows the new binding:

```ts
const materializationNamespace = (testEnv as unknown as {
  MATERIALIZATION_GUARD?: DurableObjectNamespace
}).MATERIALIZATION_GUARD;

expect(materializationNamespace).toBeDefined();
```

- [ ] **Step 2: Add a failing ownership test**

Create a V2 project through `PROJECT_GUARD`, then assert that running a ProjectGuard alarm does not create a materialization generation while running the future `MATERIALIZATION_GUARD` alarm does. Before implementation, the first assertion must fail because ProjectGuard still owns projection.

```ts
expect(await runDurableObjectAlarm(testEnv.PROJECT_GUARD.getByName(projectId))).toBe(true);
expect(mock.files.has(machineMaterializationRecordPath(projectId, 1, CURRENT_PROJECTION_VERSION))).toBe(false);
```

- [ ] **Step 3: Run only the new test and capture RED evidence**

Run:

```bash
npx vitest run test/materialization-guard-isolation.spec.ts
```

Expected: failure because `MATERIALIZATION_GUARD` is absent and/or ProjectGuard still materializes locally.

- [ ] **Step 4: Commit RED test only**

Commit message:

```text
test: require isolated materialization guard
```

---

### Task 2: Add the MaterializationGuard binding and minimal target API

**Files:**
- Create: `src/durable/materialization-guard.ts`
- Modify: `src/index-mutation-gate.ts`
- Modify: `wrangler.jsonc`
- Test: `test/materialization-guard-isolation.spec.ts`

**Interfaces:**
- Produces internal request type:

```ts
export interface MaterializationTargetRequestBody {
  project_id: string;
  revision: number;
  projection_version: number;
}
```

- Produces routes `POST /request-target`, `GET /status`, `POST /reconcile`, `POST /materialize` and `alarm()`.
- `POST /request-target` returns `{ project_id, requested: { revision, projection_version } | null }`.

- [ ] **Step 1: Add RED tests for request validation and binding mismatch**

Test all of these:

```ts
const wrong = await testEnv.MATERIALIZATION_GUARD.getByName(projectId).fetch(
  "https://materialization-guard.internal/request-target",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_id: "PRJ-9999",
      revision: 1,
      projection_version: CURRENT_PROJECTION_VERSION
    })
  }
);
expect(wrong.status).toBe(409);
```

Also require invalid revision/projection version to return 400 and a correct request to return 200 without creating human workspace outputs synchronously.

- [ ] **Step 2: Add Wrangler binding/export**

In `wrangler.jsonc` add:

```json
{ "name": "MATERIALIZATION_GUARD", "class_name": "MaterializationGuard" }
```

and:

```json
"MaterializationGuard": {
  "type": "durable-object",
  "state": "created",
  "storage": "sqlite"
}
```

Do not add a destructive migration block.

In `src/index-mutation-gate.ts` add:

```ts
export { MaterializationGuard } from "./durable/materialization-guard";
```

- [ ] **Step 3: Implement MaterializationGuard construction**

Create `src/durable/materialization-guard.ts` around existing projection components:

```ts
export class MaterializationGuard extends DurableObject<Env> {
  private readonly persistence: ProjectOsPersistenceRuntime;
  private readonly repository: ProjectRepository;
  private readonly ledger: MaterializationLedger;
  private readonly coordinator: MaterializationCoordinator;
  private queue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeMaterializationSchema(ctx.storage);
    this.persistence = createProductionPersistence(env);
    this.repository = new ProjectRepository(this.persistence, parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE));
    this.ledger = new MaterializationLedger(ctx.storage);
    this.coordinator = new MaterializationCoordinator({
      projectId: ctx.id.name ?? "",
      repository: this.repository,
      ledger: this.ledger,
      writer: new WorkspaceProjectionWriter(
        this.persistence.objects,
        parseProjectionConcurrency(env.PROJECT_OS_PROJECTION_CONCURRENCY)
      ),
      projectionVersion: CURRENT_PROJECTION_VERSION
    });
  }
}
```

Reject missing/empty bound project names rather than allowing an unbound projection worker.

- [ ] **Step 4: Implement `/request-target` as local-only scheduling**

Parse JSON, validate `project_id === ctx.id.name`, call:

```ts
this.coordinator.requestTarget(body.revision, body.projection_version);
await this.ensureAlarm();
```

`ensureAlarm()` may use only Durable Object storage calls (`getAlarm`/`setAlarm`); it must not read Dropbox.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run types
npx vitest run test/materialization-guard-isolation.spec.ts
```

Expected: binding/request tests pass; alarm-ownership tests remain red until Task 3.

- [ ] **Step 6: Commit**

Commit message:

```text
feat: add materialization guard binding
```

---

### Task 3: Move projection execution, recovery, and alarms into MaterializationGuard

**Files:**
- Modify: `src/durable/materialization-guard.ts`
- Modify: `test/materialization-guard-isolation.spec.ts`
- Modify: `test/materialization-faults.spec.ts`

**Interfaces:**
- `GET /status` returns the existing materialization status shape.
- `POST /reconcile` reconciles current canonical revision and schedules lag.
- `POST /materialize` accepts exactly `{ "target": "workspace-v2" }` and converges the current canonical revision.
- `alarm()` owns retry/defer behavior formerly in ProjectGuard.

- [ ] **Step 1: Add RED tests for MaterializationGuard projection ownership**

Migrate the helper in `test/materialization-faults.spec.ts` to:

```ts
async function materialize(projectId: string): Promise<void> {
  expect(await runDurableObjectAlarm(testEnv.MATERIALIZATION_GUARD.getByName(projectId))).toBe(true);
}
```

Add focused tests for:

- generation creation by MaterializationGuard alarm;
- head-write recovery on the second alarm;
- cold SQLite reconstruction using `runInDurableObject` on `MATERIALIZATION_GUARD` and deleting `materialization_*` rows;
- four rapid targets coalescing to newest revision;
- `/status` reporting `canonical_revision` from machine state;
- guard-local serialization by blocking one alarm Dropbox read and proving `/reconcile` cannot issue another provider read until the alarm releases.

- [ ] **Step 2: Implement canonical-state loading in MaterializationGuard**

Add:

```ts
private async canonicalState(): Promise<ProjectState | null> {
  const projectId = this.boundProjectId();
  const state = await this.repository.readProjectState(projectId);
  if (state && state.project_id !== projectId) {
    throw new Error(`MaterializationGuard state binding mismatch: expected ${projectId}, got ${state.project_id}`);
  }
  return state;
}
```

All provider-I/O routes call `serialize()`.

- [ ] **Step 3: Implement `/status`, `/reconcile`, `/materialize`**

`/status` loads canonical state, runs `coordinator.reconcile(state.revision)` so durable head evidence can rebuild cold SQLite, then returns:

```ts
{
  project_id: state.project_id,
  canonical_revision: state.revision,
  projection_version: CURRENT_PROJECTION_VERSION,
  materialized_head: status.head,
  requested: status.requested,
  active: status.active
    ? { revision: status.active.revision, projection_version: status.active.projection_version }
    : null,
  blocked_error: status.last_error,
  output_count: status.output_count,
  attempt_output_count: status.attempt_output_count
}
```

`/reconcile` performs the same reconstruction/scheduling and ensures an alarm when work is pending.

`/materialize` validates the body, loads canonical state, reconciles, requests the current target, calls `runUntilIdle()`, deletes its own alarm, and returns `{ project_id, revision, materialized: true }`. Preserve the historical V2 fallback: if the current revision has no immutable commit record, call `repository.materializeV2(state)` inside MaterializationGuard.

- [ ] **Step 4: Move the old alarm behavior exactly**

Use the previous retry contract:

```ts
const result = await this.coordinator.runNext(alarmInfo?.retryCount ?? 0);
if (result.more_work) await this.ctx.storage.setAlarm(Date.now() + 1_000);
```

For `MaterializationOutputConflictError`, log and stop. At retry count >= 5, log and defer by 300,000 ms. Otherwise re-arm at 1,000 ms and rethrow.

- [ ] **Step 5: Run Projection Engine tests**

Run:

```bash
npx vitest run test/materialization-guard-isolation.spec.ts test/materialization-faults.spec.ts
```

Expected: MaterializationGuard ownership/reconstruction/coalescing tests pass; ProjectGuard cutover assertions remain red until Task 4.

- [ ] **Step 6: Commit**

Commit message:

```text
feat: move projection execution to materialization guard
```

---

### Task 4: Make ProjectGuard canonical-only and remove recovery side-channels

**Files:**
- Create: `src/materialization/handoff.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: `src/durable/project-guard-mutation-gate.ts`
- Modify: `src/durable/project-guard-subrequest-resilient.ts`
- Modify: `test/materialization-guard-isolation.spec.ts`
- Modify: `test/project-guard-alarm-serialization.spec.ts`

**Interfaces:**
- Produces:

```ts
export async function requestMaterializationTargetSafely(
  env: Env,
  projectId: string,
  revision: number,
  projectionVersion: number
): Promise<void>
```

- Changes `ProjectGuard.loadOrRecoverState()` from private to protected so subclasses no longer abuse `/materialization-status` as a canonical-recovery trigger.

- [ ] **Step 1: Add RED tests for canonical-only ProjectGuard**

Require all of these:

- a committed V2 transaction returns `committed` before any human workspace file is written;
- the corresponding MaterializationGuard target is requested;
- a ProjectGuard alarm performs zero Dropbox calls and clears any legacy alarm;
- legacy ProjectGuard `GET /materialization-status`, `POST /reconcile-materialization`, and `POST /materialize` return the MaterializationGuard responses;
- calling those compatibility routes performs no ProjectGuard snapshot fast-forward Dropbox read before forwarding;
- working-head and MutationGate candidate-resolution recovery still work after ProjectGuard eviction without calling `materialization-status` as a side-channel.

- [ ] **Step 2: Add the safe handoff helper**

Implement `src/materialization/handoff.ts`:

```ts
export async function requestMaterializationTargetSafely(
  env: Env,
  projectId: string,
  revision: number,
  projectionVersion: number
): Promise<void> {
  try {
    const response = await env.MATERIALIZATION_GUARD.getByName(projectId).fetch(
      "https://materialization-guard.internal/request-target",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project_id: projectId, revision, projection_version: projectionVersion })
      }
    );
    if (!response.ok) throw new Error(`MaterializationGuard returned ${response.status}`);
  } catch (error) {
    console.error("Project OS materialization scheduling failed after canonical commit", {
      project_id: projectId,
      target_revision: revision,
      projection_version: projectionVersion,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
```

The helper intentionally resolves after logging; it must not turn a durable canonical commit into an application failure.

- [ ] **Step 3: Remove local materialization ownership from ProjectGuard**

In `src/durable/project-guard-neutral.ts`:

- remove `MaterializationLedger`, `MaterializationCoordinator`, `WorkspaceProjectionWriter`, `MaterializationOutputConflictError`, projection concurrency, and materialization schema initialization imports/fields;
- remove `materializationLedger` and `materializationCoordinator` construction;
- change `requestMaterializationSafely(revision)` to call `requestMaterializationTargetSafely(this.env, projectId, revision, CURRENT_PROJECTION_VERSION)`;
- make `loadOrRecoverState()` `protected`;
- replace projection endpoint bodies with pure internal forwarding to `MATERIALIZATION_GUARD.getByName(boundProjectId)`;
- change `alarm()` to clear a legacy stored alarm and return without Dropbox access.

Compatibility forwarding must preserve method/body:

```ts
return this.env.MATERIALIZATION_GUARD.getByName(projectId).fetch(
  `https://materialization-guard.internal/${targetPath}`,
  forwardedInit
);
```

Map:

```text
/materialization-status   -> /status
/reconcile-materialization -> /reconcile
/materialize              -> /materialize
```

- [ ] **Step 4: Remove the two materialization-status recovery hacks**

In `src/durable/project-guard-mutation-gate.ts`, replace:

```ts
await super.fetch(new Request("https://project-guard.internal/materialization-status", { method: "GET" }));
```

with:

```ts
return this.loadOrRecoverState();
```

or an equivalent protected canonical helper, preserving project binding validation.

In `src/durable/project-guard-subrequest-resilient.ts`, `handleWorkingHead()` must call the protected canonical recovery helper when local state is absent rather than fetching `/materialization-status`.

- [ ] **Step 5: Stop fast-forwarding projection compatibility routes**

Change `FAST_FORWARD_PATHS` to remove:

```text
/reconcile-materialization
/materialize
```

The compatibility route must reach the separate DO without a ProjectGuard Dropbox read first.

Update comments that currently claim the recovery queue serializes materialization alarms; after this task it serializes canonical recovery/mutation work only.

- [ ] **Step 6: Replace the old alarm concurrency test**

`test/project-guard-alarm-serialization.spec.ts` should now assert:

```ts
mock.downloadCalls.length = 0;
mock.uploadCalls.length = 0;
await runDurableObjectAlarm(testEnv.PROJECT_GUARD.getByName(projectId));
expect(mock.downloadCalls).toEqual([]);
expect(mock.uploadCalls).toEqual([]);
```

Then run a transaction and prove canonical recovery still succeeds.

- [ ] **Step 7: Run focused canonical/high-risk tests**

Run:

```bash
npx vitest run \
  test/materialization-guard-isolation.spec.ts \
  test/project-guard-alarm-serialization.spec.ts \
  test/project-guard-working-head.spec.ts \
  test/mutation-gate-faults.spec.ts \
  test/project-guard-commit-recovery.spec.ts
```

Expected: all pass.

- [ ] **Step 8: Commit**

Commit message:

```text
fix: isolate canonical guard from projection io
```

---

### Task 5: Route worker/admin projection operations directly to MaterializationGuard

**Files:**
- Modify: `src/index-neutral.ts`
- Modify: `src/index-mutation-gate.ts`
- Modify: `test/materialization-guard-isolation.spec.ts`

**Interfaces:**
- `materializeExistingProjects()` uses `MATERIALIZATION_GUARD` after the existing `mirrorLegacyEvents()` compatibility step.
- `reconcileMaterializations()` calls `POST /reconcile` on `MATERIALIZATION_GUARD`.
- Transaction/artifact/document/referral routes remain unchanged.

- [ ] **Step 1: Add RED worker-routing tests**

Exercise the exported worker/admin functions and prove projection operations do not hit `PROJECT_GUARD` projection compatibility routes. The assertion should inspect resulting materialization state/output rather than relying only on call counts.

- [ ] **Step 2: Change explicit materialization routing**

In `materializeExistingProjects()` replace:

```ts
const guard = env.PROJECT_GUARD.getByName(projectId);
```

with:

```ts
const guard = env.MATERIALIZATION_GUARD.getByName(projectId);
```

and call `https://materialization-guard.internal/materialize` with the same body.

- [ ] **Step 3: Change fleet reconciliation routing**

In `reconcileMaterializations()`, call:

```ts
const stub = env.MATERIALIZATION_GUARD.getByName(project.project_id);
const response = await stub.fetch("https://materialization-guard.internal/reconcile", { method: "POST" });
```

Preserve existing summary fields `scanned`, `scheduled`, `current`, `failed` and the existing head-current calculation.

- [ ] **Step 4: Run worker/inbox/materialization tests**

Run:

```bash
npx vitest run \
  test/materialization-guard-isolation.spec.ts \
  test/materialization-faults.spec.ts \
  test/inbox-isolation.spec.ts \
  test/inbox-replay-cleanup.spec.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

Commit message:

```text
refactor: route projection work to materialization guard
```

---

### Task 6: High-risk gate, cold-start regression, and deployment configuration proof

**Files:**
- Modify: `package.json`
- Modify: `test/materialization-guard-isolation.spec.ts`
- Verify: `wrangler.jsonc`

**Interfaces:**
- High-risk suite explicitly includes `test/materialization-guard-isolation.spec.ts`.
- Wrangler generated types expose `MATERIALIZATION_GUARD` after `npm run types`.

- [ ] **Step 1: Add the isolation suite to `test:persistence-high-risk`**

Append exactly:

```text
test/materialization-guard-isolation.spec.ts
```

to the existing Vitest command; keep all current high-risk files.

- [ ] **Step 2: Add the final cold-start/cutover regression**

The test sequence must be:

1. commit revision 1;
2. run `MATERIALIZATION_GUARD` alarm and verify generation 1;
3. delete MaterializationGuard `materialization_*` SQLite rows and evict that DO only;
4. commit revision 2 through ProjectGuard;
5. call MaterializationGuard `/reconcile`;
6. run MaterializationGuard alarm;
7. verify materialization head is revision 2 and both immutable commit records remain present;
8. verify ProjectGuard alarm produces no provider I/O.

- [ ] **Step 3: Run repository gates**

Run exactly:

```bash
npm run check
npm run test:persistence-high-risk
npx wrangler deploy --dry-run
```

Expected: all three exit 0.

- [ ] **Step 4: Review the full branch diff**

Required review checks:

- no business schema changes;
- no canonical commit format changes;
- no new public unauthenticated route;
- no leftover MaterializationCoordinator construction in ProjectGuard;
- no `/materialize` or `/reconcile-materialization` entry in `FAST_FORWARD_PATHS`;
- no `super.fetch(...materialization-status...)` recovery hack remains;
- MaterializationGuard is exported and bound exactly once;
- existing Projection Engine fault tests retain their original semantic assertions.

- [ ] **Step 5: Commit final test/config changes**

Commit message:

```text
test: gate materialization guard isolation
```

---

### Task 7: PR, production proof, and safe PRJ-0003 canary

**Files:**
- No product code unless verification reveals a proven defect.
- Canonical PRJ-0002 governance transaction is created only after production proof and requires a fresh canonical revision/receipt gate.

**Interfaces:**
- Production deployment must serve the exact merged SHA.
- PRJ-0003 canary remains intentionally stale/non-mutating.

- [ ] **Step 1: Open the implementation PR against current `main`**

Before opening, compare the implementation branch to current `main`. If `main` advanced, rebase/merge only when changes are mechanically compatible; rerun all three gates after any base change.

PR body must list:

```text
Root cause: projection and canonical mutation shared one ProjectGuard Durable Object/I/O context.
Fix: separate MaterializationGuard Durable Object with its own SQLite/alarm/I/O context.
Canonical behavior: unchanged.
Projection evidence format: unchanged.
Verification: npm run check; test:persistence-high-risk; wrangler dry-run.
```

- [ ] **Step 2: Require exact green PR head**

Do not merge until all three CI steps are green on the exact PR head SHA.

- [ ] **Step 3: Merge with expected-head SHA protection**

Use squash merge only after the exact head is green. Record the merge SHA.

- [ ] **Step 4: Verify deployment**

Require the deploy workflow for the merge SHA to pass:

```text
Verify project
Deploy exact Git release
Verify exact production identity and health
```

Capture run ID and deployed Cloudflare version ID from logs.

- [ ] **Step 5: Refresh PRJ-0003 before canary**

Read current manifest/state. Do not assume revision 236 remains current.

- [ ] **Step 6: Run one stale/non-mutating canary only**

Use the already quarantined supersede transaction only if it is still stale relative to current revision. Move that exact file to incoming only after the Dropbox mutation confirmation policy is satisfied.

Success condition:

```text
ProjectGuard returns a normal business conflict/rejection due stale base revision
```

Failure condition:

```text
Dropbox ... state.json ... files/download request #1 ... Too many subrequests
```

The canary must not create a new business revision.

- [ ] **Step 7: Only after canary success, reconstruct still-valid PRJ-0003 intents**

Refresh canonical state before each new transaction. Do not reuse stale transaction IDs/base revisions for non-rebasable operations such as `decision.accept`, `decision.supersede`, or `task.complete`. Preserve old quarantine files as historical evidence.

- [ ] **Step 8: Record PRJ-0002 governance evidence**

Refresh PRJ-0002 `HANDOFF.md`, `STATE.md`, manifest/revision. Create one minimal typed transaction recording the accepted MaterializationGuard architecture plus authoritative evidence: spec path, PR number, merge SHA, CI run, deploy run, Cloudflare version, and production canary result. Deposit through `transactions/incoming` only after exact Dropbox mutation confirmation; claim persistence only after receipt `status = committed`.

---

## Plan Self-Review

- **Spec coverage:** separate binding, canonical-only ProjectGuard, MaterializationGuard alarm ownership, cold reconstruction, coalescing, compatibility forwarding, guard-local serialization, worker routing, production canary, and PRJ-0002 governance closure are all mapped to explicit tasks.
- **Hidden coupling covered:** MutationGate and Working Head no longer use `/materialization-status` as a canonical recovery side-channel.
- **Provider budget boundary covered:** projection compatibility routes are removed from ProjectGuard snapshot fast-forward before forwarding.
- **Migration safety covered:** old ProjectGuard projection SQLite remains untouched/dead; MaterializationGuard rebuilds from durable external evidence.
- **No placeholders:** every task names concrete files, routes, interfaces, commands, and expected outcomes.
- **Type consistency:** `MATERIALIZATION_GUARD`, `MaterializationGuard`, `MaterializationTargetRequestBody`, and `requestMaterializationTargetSafely()` names are used consistently throughout.
