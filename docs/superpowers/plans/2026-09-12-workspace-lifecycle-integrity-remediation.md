# Workspace Lifecycle Integrity Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every active Project OS workspace current, clean and navigable by making package lifecycle canonical, stopping stale convergence retries, and repairing the four active projects through typed transactions and committed receipts.

**Architecture:** Extend the existing ProjectState/ProjectGuard/convergence path with one small `workspace.head.set` operation. The operation records explicit current package paths and archive moves; existing fenced convergence effects apply the moves, rebind managed heads and materialize one current index per active zone together with `STATE.md` and `HANDOFF.md`. No new service, database, dashboard, notification provider or filename inference is introduced.

**Tech Stack:** TypeScript, Zod, Cloudflare Workers/Durable Objects, Dropbox provider adapter, Vitest, existing Project OS typed transaction and convergence contracts.

**Spec:** `docs/superpowers/specs/2026-09-12-workspace-lifecycle-integrity-design.md`

## Global Constraints

- Dropbox remains canonical persistent state.
- Never modify machine-managed canonical project files directly.
- Every durable business or workspace-lifecycle mutation uses a typed transaction and a `committed` receipt.
- Human notification remains disabled and is not an activation gate.
- Apply the same code path to all active projects; do not introduce a new synthetic canary project.
- Do not infer current versions from filenames.
- Do not bulk-rename or recursively audit historical archive content.
- Keep PRJ-0003 and PRJ-0007 repair data outside production code.
- Begin execution by merging `origin/main` into the existing branch; do not create another worktree.

---

### Task 1: Stop superseded human-convergence retry loops

**Files:**
- Modify: `src/convergence/engine.ts`
- Modify: `src/convergence/contract.ts`
- Modify: `src/durable/materialization-guard.ts`
- Test: `test/convergence-engine.spec.ts`
- Test: `test/materialization-guard-isolation.spec.ts`
- Test: `test/convergence-acceptance.spec.ts`

**Interfaces:**
- Consumes: `ProjectRepository.readMaterializationHead`, `readMaterializationRecord`, `readCommitRecord`, current critical-pair verification, `Progress.active`, `Progress.requested`.
- Produces: `adoptVerifiedNewerHumanHead(progress, budget, health): Promise<boolean>` and terminal exhausted obligations with `next_attempt_at: null`.

- [ ] **Step 1: Synchronize the existing branch and prove the baseline**

Run:

```bash
git fetch origin
git merge --no-edit origin/main
git diff --check
npm test -- --run test/convergence-engine.spec.ts test/materialization-guard-isolation.spec.ts test/convergence-acceptance.spec.ts
```

Expected: merge succeeds in the existing worktree; the only pre-merge content difference was a blank line in `test/review-candidate-governance.spec.ts`; targeted tests pass.

- [ ] **Step 2: Add the PRJ-0007 race as a failing test**

Create a test fixture with canonical revision 38, provider materialization head 38, a valid revision-38 materialization record, `progress.active = 37`, `progress.requested = 38`, and an exhausted revision-37 human obligation. Assert:

```ts
expect(result.more_work).toBe(false);
expect(saved.progress.active).toBeNull();
expect(saved.progress.requested).toBeNull();
expect(saved.progress.obligations[oldId]).toMatchObject({
  state: "verified",
  next_attempt_at: null,
  code: null
});
expect(attemptFilesFor(oldId)).toHaveLength(0);
```

- [ ] **Step 3: Run the new test and verify the current loop**

Run:

```bash
npm test -- --run test/convergence-engine.spec.ts -t "adopts a newer verified human head"
```

Expected: FAIL because the engine reserves another attempt for revision 37.

- [ ] **Step 4: Adopt a newer head before reserving a human attempt**

Add a helper in `ConvergenceEngine` that:

```ts
private async adoptVerifiedNewerHumanHead(
  progress: Progress,
  budget: SliceBudget,
  health: ConvergenceHealth
): Promise<boolean>
```

The helper must:

1. return `false` when `progress.active` is null;
2. read the provider materialization head;
3. require `head.target_revision > progress.active.revision` and `head.target_revision <= progress.canonical_observed_revision`;
4. read and bind the matching materialization record and canonical commit record;
5. reuse independent generation/head and critical `STATE.md`/`HANDOFF.md` verification;
6. mark only human obligations with `target.revision <= head.target_revision` as verified;
7. clear an active/requested target only when it is not newer than the verified head;
8. recompute `next_alarm_at` from genuinely pending obligations.

Call it at the start of `resumePendingHumanSlice`, before `reserveAttempt` can run.

- [ ] **Step 5: Stop automatic human retries after exhaustion**

Keep the shared machine-layer retry calculation unchanged. In the human failure path, make exhaustion terminal for automatic alarms:

```ts
const automaticWake = retry.state === "exhausted" ? null : retry.at;
progress.obligations[obligationId] = {
  ...failed,
  state: retry.state,
  next_attempt_at: automaticWake
}
```

For failure counts below 6, preserve existing backoff. At 6 or above, keep `state: "exhausted"` but store `next_attempt_at: null` for `human_handoff`. A new canonical target or explicit repair request may reactivate the work; an alarm may not retry it indefinitely. Machine-layer retry semantics remain unchanged.

- [ ] **Step 6: Preserve a bounded diagnostic fingerprint**

Extend the human failure classification result to keep the allowlisted code plus a SHA-256 fingerprint of the normalized error name/message. Do not persist tokens, paths outside Project OS or raw provider payloads. Expose the fingerprint in diagnostic status so repeated identical failures are distinguishable without leaking secrets.

- [ ] **Step 7: Run targeted convergence verification**

Run:

```bash
npm test -- --run test/convergence-engine.spec.ts test/materialization-guard-isolation.spec.ts test/convergence-acceptance.spec.ts test/convergence-observability.spec.ts
npm run typecheck
```

Expected: PASS; no test accepts a seventh automatic attempt after exhaustion.

- [ ] **Step 8: Commit the runtime containment**

```bash
git add src/convergence src/durable/materialization-guard.ts test/convergence-engine.spec.ts test/materialization-guard-isolation.spec.ts test/convergence-acceptance.spec.ts test/convergence-observability.spec.ts
git commit -m "fix: stop superseded human convergence retries"
```

---

### Task 2: Add one canonical workspace-head operation

**Files:**
- Modify: `src/domain/project-state.ts`
- Modify: `src/domain/project-state-normalizer.ts`
- Modify: `src/schema/project-state.ts`
- Modify: `src/domain/transaction.ts`
- Modify: `src/domain/transitions.ts`
- Modify: `src/domain/event.ts`
- Test: `test/transaction.spec.ts`
- Test: `test/model-lifecycle-concurrency.spec.ts`
- Test: `test/schema/project-state.spec.ts`
- Test: `test/project-state-normalizer.spec.ts`

**Interfaces:**
- Produces: `WorkspaceHeadRecord`, `WorkspaceArchiveMove`, `ProjectState.workspace_heads`, operation `workspace.head.set`.
- Consumes: existing base-revision conflict handling and committed-receipt pipeline.

- [ ] **Step 1: Write failing schema and transition tests**

Use this exact durable shape:

```ts
export interface WorkspaceHeadRecord {
  workstream_id: string;
  title: string;
  working_path?: string;
  review_path?: string;
  published_path?: string;
  updated_at: string;
}

export interface WorkspaceArchiveMove {
  source_path: string;
  archive_path: string;
}
```

The `workspace.head.set` payload is:

```ts
{
  workstream_id: "WORKSTREAM-A03KNOWLEDGE",
  title: "A03 Knowledge",
  working_path: "WORKING/PRJ-0003-KNOWLEDGE-EXHAUSTIVENESS-PRODUCTION-R2",
  review_path: "REVIEW/PRJ-0003-A03-KNOWLEDGE-FOUNDER-GATE-R1",
  archive_moves: [{
    source_path: "WORKING/old-package",
    archive_path: "ARCHIVES/WORKSTREAM-A03KNOWLEDGE/2026-09-12/old-package"
  }]
}
```

Tests must reject wrong-zone pointers, `ARCHIVE/`, nested active-zone archives, duplicate sources/destinations, source equal to a declared current head, unknown keys and stale base revisions.

- [ ] **Step 2: Run tests red**

```bash
npm test -- --run test/transaction.spec.ts test/model-lifecycle-concurrency.spec.ts test/schema/project-state.spec.ts test/project-state-normalizer.spec.ts
```

Expected: FAIL because the operation and state field do not exist.

- [ ] **Step 3: Implement the minimal state and transaction model**

Add `workspace_heads: Record<string, WorkspaceHeadRecord>` to `ProjectState`. Initialize it to `{}` in `emptyProjectState` and normalize missing legacy values to `{}` without changing the external schema version.

Add `workspace.head.set` to `operationValues`. Validate IDs with `WORKSTREAM-[A-Z0-9]{4,}`, constrain each pointer to its exact root, and constrain every archive destination to `ARCHIVES/`.

In `applyTransaction`, replace only the addressed workstream record and emit the archive-move intent in the canonical event. Do not perform provider I/O in the domain transition.

- [ ] **Step 4: Run domain tests green**

```bash
npm test -- --run test/transaction.spec.ts test/model-lifecycle-concurrency.spec.ts test/schema/project-state.spec.ts test/project-state-normalizer.spec.ts test/operations.spec.ts
npm run typecheck
```

Expected: PASS; existing project states decode with an empty workspace-head map.

- [ ] **Step 5: Commit the canonical contract**

```bash
git add src/domain src/schema test/transaction.spec.ts test/model-lifecycle-concurrency.spec.ts test/schema/project-state.spec.ts test/project-state-normalizer.spec.ts test/operations.spec.ts
git commit -m "feat: record canonical workspace heads"
```

---

### Task 3: Apply package archive moves and rebind managed heads

**Files:**
- Create: `src/workspace/lifecycle.ts`
- Create: `src/workspace/managed-head-rebind.ts`
- Modify: `src/materialization/coordinator.ts`
- Modify: `src/materialization/ledger.ts`
- Modify: `src/convergence/contract.ts`
- Modify: `src/convergence/engine.ts`
- Modify: `src/documents/active-path-index.ts`
- Modify: `src/documents/repository.ts`
- Create: `test/workspace-lifecycle.spec.ts`
- Test: `test/materialization-faults.spec.ts`
- Test: `test/managed-document-working-head.spec.ts`

**Interfaces:**
- Consumes: `WorkspaceArchiveMove`, provider metadata, `deleteIfUnchanged`, server-side copy, convergence fenced-effect journal.
- Produces: resumable `workspace_archive_move` effects and `rebindManagedHeadsBelowPrefix(...)`.

- [ ] **Step 1: Write one end-to-end failing lifecycle test**

The fixture contains a working package with text and binary files, two managed heads below that package, a `workspace.head.set` transaction that selects a new package and archives the old one, and an injected crash after archive copy but before source deletion.

After replay, assert:

```ts
expect(oldSourceTree()).toBeAbsent();
expect(archivedTree()).toMatchProviderEvidence(originalTree);
expect(allManagedHeads()).toSatisfy(head =>
  head.reconciliation_status !== "clean" || providerPathExists(head.provider_path)
);
expect(committedReceipt.status).toBe("committed");
```

- [ ] **Step 2: Run the lifecycle test red**

```bash
npm test -- --run test/workspace-lifecycle.spec.ts
```

Expected: FAIL because package archive effects do not exist.

- [ ] **Step 3: Implement a fenced archive effect without a new service**

`src/workspace/lifecycle.ts` must expose:

```ts
export async function applyWorkspaceArchiveMove(input: {
  projectId: string;
  move: WorkspaceArchiveMove;
  runtime: ProjectOsPersistenceRuntime;
  effects: FencedEffects;
}): Promise<"moved" | "idempotent">
```

Freeze a machine-side manifest of source files using the existing paged listing interface, then process a bounded number of files per slice with the existing provider copy/verify/delete pattern. Record each prepared file effect before copying it. On replay, accept an already verified archive file. Delete each source only with unchanged provider identity, remove emptied source directories last, and never overwrite a nonmatching archive destination. Do not assume the provider can atomically copy a large folder.

- [ ] **Step 4: Rebind or retire every affected managed head**

`rebindManagedHeadsBelowPrefix` must list head records by project and select exact path-prefix matches. For a superseded working/review path, clear that active provider pointer only after its immutable version record and archived bytes are verified. Preserve any unaffected published/reference pointer. When no active pointer remains, retire the active head record while retaining immutable version history. Do not point managed active-stage provider fields into `ARCHIVES/`, and never leave `reconciliation_status: clean` when any remaining provider path is missing.

Add a test for a partial package move: the replay completes remaining head updates and does not restore the old package.

- [ ] **Step 5: Integrate the effect before human projection publication**

The materialization coordinator applies pending archive moves before rendering current indexes and the critical pair. A materialization head cannot publish while any workspace archive effect or managed-head rebind remains unverified.

- [ ] **Step 6: Run focused fault tests**

```bash
npm test -- --run test/workspace-lifecycle.spec.ts test/materialization-faults.spec.ts test/managed-document-working-head.spec.ts test/document-external-edits.spec.ts
npm run typecheck
```

Expected: PASS across copy conflict, crash replay, changed source and missing-source cases.

- [ ] **Step 7: Commit physical lifecycle convergence**

```bash
git add src/workspace src/materialization src/convergence src/documents test/workspace-lifecycle.spec.ts test/materialization-faults.spec.ts test/managed-document-working-head.spec.ts test/document-external-edits.spec.ts
git commit -m "feat: converge workspace package lifecycle"
```

---

### Task 4: Generate trusted current navigation and enforce lifecycle invariants

**Files:**
- Create: `src/render/current.ts`
- Modify: `src/render/state.ts`
- Modify: `src/render/handoff.ts`
- Modify: `src/render/operating.ts`
- Modify: `src/materialization/planner.ts`
- Modify: `src/domain/transitions.ts`
- Modify: `src/domain/transaction.ts`
- Modify: `src/persistence/artifact-routing.ts`
- Test: `test/materialization-planner.spec.ts`
- Test: `test/materialization-coordinator.spec.ts`
- Test: `test/model-lifecycle-concurrency.spec.ts`
- Test: `test/artifact-routing.spec.ts`

**Interfaces:**
- Consumes: `ProjectState.workspace_heads`.
- Produces: `WORKING/00-CURRENT.md`, `REVIEW/00-CURRENT.md`, `DELIVERABLES/00-CURRENT.md`, “Open now” sections in state/handoff, `task.reassign`.

- [ ] **Step 1: Write red projection tests**

Given two workspace heads, assert that each generated zone index contains only pointers for that zone, includes project revision, carries managed frontmatter, and is marked critical. Assert that `STATE.md` and `HANDOFF.md` link to the same paths.

Also assert that a removed workspace head removes its index entry in the next projection.

- [ ] **Step 2: Add red lifecycle invariant tests**

Add these exact cases:

```ts
expect(completePhaseWithPendingChild.code).toBe("PHASE_HAS_UNFINISHED_TASKS");
expect(configureRoute({ archive_prefix: "WORKING/ARCHIVE" })).toReject();
expect(configureRoute({ archive_prefix: "ARCHIVE/OLD" })).toReject();
expect(configureRoute({ archive_prefix: "ARCHIVES/REVENUE-OS" })).toCommit();
```

Add `task.reassign` with payload `{ task_id, phase_id }`; reject completed tasks and nonexisting/completed destination phases.

- [ ] **Step 3: Run the focused tests red**

```bash
npm test -- --run test/materialization-planner.spec.ts test/materialization-coordinator.spec.ts test/model-lifecycle-concurrency.spec.ts test/artifact-routing.spec.ts
```

- [ ] **Step 4: Render one current file per zone**

`renderCurrent(state, zone)` sorts by `workstream_id` and emits links only from canonical workspace heads. Add the three files to `GLOBAL_PATHS`/output descriptors as critical outputs so their hashes participate in materialization verification.

Do not generate a `00-CURRENT/` directory or `00-CURRENT-INDEX.md`.

- [ ] **Step 5: Add “Open now” without mixing provider observations into canonical state**

`STATE.md` and `HANDOFF.md` gain a concise current-head section plus one link to `INPUTS/`. Do not render provider-observed input counts inside canonical projections: the read-only fleet report in Task 6 owns those counts, and inputs do not become accepted tasks or decisions automatically.

- [ ] **Step 6: Enforce archive and phase rules**

Require `archive_prefix` to start with `ARCHIVES/`. Reject phase completion when an attached task is unfinished. Implement the narrow `task.reassign` transition for legitimate carry-forward.

- [ ] **Step 7: Raise the operating contract version**

Set `OPERATING_CONTRACT_VERSION = 4` and document:

- exactly one archive root;
- one generated current file per active zone;
- package changes require `workspace.head.set`;
- direct Dropbox moves are detected drift, not canonical lifecycle;
- human notifications are optional and nonblocking.

- [ ] **Step 8: Run projection and compatibility tests**

```bash
npm test -- --run test/materialization-planner.spec.ts test/materialization-coordinator.spec.ts test/materialization-writer.spec.ts test/model-lifecycle-concurrency.spec.ts test/artifact-routing.spec.ts test/operations.spec.ts
npm run typecheck
```

Expected: PASS; legacy states produce empty but valid current indexes until a workspace head is declared.

- [ ] **Step 9: Commit navigation and invariants**

```bash
git add src/render src/materialization/planner.ts src/domain src/persistence/artifact-routing.ts test
git commit -m "feat: materialize current workspace navigation"
```

---

### Task 5: Detect bypass drift and clean terminal staging safely

**Files:**
- Create: `src/workspace/audit.ts`
- Modify: `src/documents/change-coordinator.ts`
- Modify: `src/documents/reconciler.ts`
- Modify: `src/persistence/repository.ts`
- Modify: `src/convergence/observability.ts`
- Modify: `src/convergence/engine.ts`
- Create: `test/workspace-drift.spec.ts`
- Test: `test/staged-artifact-e2e.spec.ts`
- Test: `test/convergence-observability.spec.ts`

**Interfaces:**
- Produces: `auditWorkspaceLayout(state, observations): WorkspaceDrift[]` and `cleanupTerminalStagedArtifact(request, receipt)`.
- Consumes: Dropbox change feed, canonical workspace heads, artifact terminal receipts and provider evidence.

- [ ] **Step 1: Write red drift tests from PRJ-0003 and PRJ-0007**

Fixtures must detect:

- a clean head whose provider path is missing;
- `ARCHIVE/`, `WORKING/ARCHIVE` and `REVIEW/ARCHIVE`;
- duplicate manual `00-CURRENT/` and `00-CURRENT-INDEX.md` navigation;
- an exact duplicate payload across active zones.

The auditor reports evidence and severity. It does not infer which duplicate to delete and does not move data.

- [ ] **Step 2: Write red terminal-staging tests**

Test rejected terminal receipts for evidence mismatch and disabled ingress. Unchanged source bytes must leave staging and enter request-scoped quarantine/retention. Changed source bytes must remain and produce a drift record. No test may delete unverifiable bytes.

- [ ] **Step 3: Implement bounded change-driven workspace audit**

Audit only the changed top-level project and canonical head paths. Add a bounded fleet audit command for rollout, but do not run a recursive full-project scan on every webhook.

Set a managed head to non-clean drift status as soon as its provider path is absent. If an explicit workspace archive move covers it, let Task 3 rebind it; otherwise preserve it for review and do not restore a whole obsolete package automatically.

- [ ] **Step 4: Implement terminal staging retention**

Extend repository cleanup to terminal rejected receipts. Use request ID, source identity and revision token to move unchanged bytes to `/PROJECT_OS/.project-os/artifacts/quarantine/<request_id>/`. Persist the terminal reason. Never condition cleanup on a human notification acknowledgement.

- [ ] **Step 5: Disable notification wakes when no sink exists**

When notification delivery is not configured, keep incident and alert records but set delivery to non-applicable. `notification_pending` must not contribute to `next_alarm_at` or mutation admission.

- [ ] **Step 6: Run focused tests**

```bash
npm test -- --run test/workspace-drift.spec.ts test/staged-artifact-e2e.spec.ts test/artifact-binary-policy.spec.ts test/convergence-observability.spec.ts
npm run typecheck
```

- [ ] **Step 7: Commit drift and staging hygiene**

```bash
git add src/workspace src/documents src/persistence/repository.ts src/convergence test/workspace-drift.spec.ts test/staged-artifact-e2e.spec.ts test/artifact-binary-policy.spec.ts test/convergence-observability.spec.ts
git commit -m "fix: surface workspace drift and terminal staging"
```

---

### Task 6: Add deployment identity and a read-only fleet qualification report

**Files:**
- Modify: `src/index-neutral.ts`
- Modify: `src/env.ts`
- Modify: `wrangler.jsonc`
- Create: `scripts/audit-active-workspaces.mjs`
- Test: `test/index.spec.ts`
- Create: `test/workspace-fleet-audit.spec.ts`

**Interfaces:**
- Produces: health `git_sha`/version tag and a read-only JSON fleet audit.
- Consumes: canonical registry, workspace audit, convergence diagnostic status, materialization heads and managed heads.

- [ ] **Step 1: Write health and fleet-report tests**

Health must return a nonempty immutable deployment identifier supplied at build/deploy time. The fleet report must include per project:

```json
{
  "project_id": "PRJ-0007",
  "canonical_revision": 38,
  "materialized_revision": 38,
  "pending_convergence": 0,
  "missing_clean_heads": 0,
  "invalid_archive_roots": 0,
  "broken_current_links": 0,
  "terminal_staging_objects": 0,
  "qualified": true
}
```

- [ ] **Step 2: Run tests red**

```bash
npm test -- --run test/index.spec.ts test/workspace-fleet-audit.spec.ts
```

- [ ] **Step 3: Implement read-only reporting**

The script must never write Dropbox. It reads the active registry, calls diagnostic/read interfaces and exits nonzero when any acceptance invariant fails. Keep counts and bounded evidence paths; do not dump document contents.

- [ ] **Step 4: Bind deployment identity**

Inject the deployed Git SHA into the Worker version metadata during the existing sole-authority deployment workflow. Health must not report `null`/`unknown` for a promoted build.

- [ ] **Step 5: Run the checks**

```bash
npm test -- --run test/index.spec.ts test/workspace-fleet-audit.spec.ts
npm run check:production-promotion-authority
npm run typecheck
```

- [ ] **Step 6: Commit qualification visibility**

```bash
git add src/index-neutral.ts src/env.ts wrangler.jsonc scripts/audit-active-workspaces.mjs test/index.spec.ts test/workspace-fleet-audit.spec.ts
git commit -m "feat: qualify active workspace integrity"
```

---

### Task 7: Repair all active projects through typed transactions

**Files:**
- Create: `docs/superpowers/evidence/2026-09-12-workspace-lifecycle-rollout.md`
- Use: existing governed operator submission path
- Use: `scripts/audit-active-workspaces.mjs`

**Interfaces:**
- Consumes: production code from Tasks 1–6, fresh canonical revisions and provider evidence.
- Produces: committed repair receipts and a passing fleet qualification report.

- [ ] **Step 1: Run the complete predeployment gate**

```bash
npm run check
npm run deploy -- --dry-run
git diff --check
```

Expected: all tests and checks pass; the dry run builds without changing production.

- [ ] **Step 2: Review the branch before integration**

Review only the diff from `origin/main`. Confirm there is no direct canonical write path, project-specific production branch, unbounded recursive webhook scan or notification activation.

- [ ] **Step 3: Integrate and deploy through the existing sole authority**

Merge the reviewed branch through the repository’s existing PR path. Let the sole production deployment workflow promote that exact merge SHA. Verify `/health` reports the same SHA before submitting repair transactions.

- [ ] **Step 4: Repair PRJ-0007 first because it is actively looping**

Use fresh revision 38 or the then-current revision. Submit typed transactions that:

1. declare its current workstream heads;
2. archive the singular `ARCHIVE/` tree under `ARCHIVES/`;
3. classify the C2 workbook working/deliverable duplicate explicitly;
4. reassign or close any unfinished phase-bound task factually.

Check every receipt until `status = committed`. Then verify zero new obsolete human attempts, no pending convergence target and one generated current file per active zone.

- [ ] **Step 5: Repair PRJ-0003 without restoring obsolete packages**

Refresh canonical revision 267 or later. Submit typed workspace-head and archive transactions for the current A03 packages. Rebind or retire the 44 stale heads; replace manual current indexes through convergence; update the canonical phase/task disposition so no A02 task remains attached unfinished to completed A02.

Verify:

```text
missing clean heads = 0
broken STATE/HANDOFF/current links = 0
active-zone archive roots = 0
manual current index variants = 0
```

- [ ] **Step 6: Repair PRJ-0002 and close the canary lifecycle**

For PRJ-0002, preserve the two anomaly inputs as evidence, create the accepted remediation phase/tasks via typed transactions, and declare any current workspace heads. For PRJ-0008, verify retained evidence, explicitly complete or reassign its two tasks, then submit `project.complete` and `project.archive` with committed receipts.

- [ ] **Step 7: Clean terminal staging through the governed cleanup path**

Process the four known terminal staged objects. Verify each is either evidence-checked quarantine or removed after retention policy; do not directly delete Dropbox files.

- [ ] **Step 8: Run fleet qualification twice**

Run the audit immediately after convergence and once more after a fresh provider listing. Both reports must qualify every active project and show no new attempts for retired convergence targets.

- [ ] **Step 9: Record final evidence and commit**

The evidence file must include:

- merge and deployment SHA;
- exact committed transaction IDs;
- before/after counts for each active project;
- fleet report output;
- full test count and dry-run result;
- confirmation that no human notification was enabled;
- remaining nonblocking historical debt, if any.

```bash
git add docs/superpowers/evidence/2026-09-12-workspace-lifecycle-rollout.md
git commit -m "docs: record workspace lifecycle rollout"
```

## Final completion gate

The plan is complete only when all of the following are simultaneously true:

- production health identifies the merged deployment SHA;
- PRJ-0007 has no obsolete revision-37 retry and no pending/exhausted current obligation;
- PRJ-0003 has zero clean heads with missing provider paths;
- every active project has a single `ARCHIVES/` root;
- every active zone exposes exactly one generated `00-CURRENT.md`;
- every path shown in generated state, handoff and current indexes exists;
- no completed phase owns an unfinished task;
- no unexplained terminal artifact remains in staging;
- two consecutive read-only fleet audits pass;
- all durable repairs have committed receipts.
