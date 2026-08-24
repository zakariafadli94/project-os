# IMP-MATERIAL001 Projection Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace synchronous full-workspace materialization with an asynchronous, incremental, hash-aware projection engine that acknowledges canonical business commits quickly, publishes coherent human views, resumes safely after interruption, and remains reconstructible from Dropbox canonical truth.

**Architecture:** Keep immutable V2 canonical commit records as business truth. Add deterministic projection planning, a bounded Dropbox writer, a SQLite-backed per-project materialization ledger, immutable completed-generation evidence plus a repairable head, and Durable Object alarms for asynchronous execution. Non-critical views carry forward when semantic inputs are unchanged; `STATE.md` and `HANDOFF.md` are always physically rendered and verified for the completed target revision. Completed-generation evidence uses compact deltas between bounded periodic snapshots so large projects do not rewrite a full output manifest on every commit.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers Durable Objects with SQLite and Alarms, Dropbox V2 layout through `DropboxTransport`/`ResilientDropboxTransport`, Zod 4, Vitest 4 with the repository's existing `@cloudflare/vitest-pool-workers` integration, deterministic Dropbox fault injection.

**Spec:** `docs/superpowers/specs/2026-08-24-imp-material001-projection-engine-design.md`

## Global Constraints

- Immutable canonical commit records remain the business source of truth. A projection failure never rewinds or changes a committed business revision.
- Production layout remains `v2` and production continuity remains exactly `stable` throughout implementation and validation.
- The normal user/chat contract does not change. Do not add `SYNC`, `MATERIALIZE`, `REFRESH`, retry, generation-selection, version-selection, or workstation instructions.
- Project OS must not require direct PC/filesystem access, a local bridge, or a desktop daemon. Dropbox Desktop remains an optional human-side sync mechanism for Obsidian only.
- Dropbox is the only production persistence provider in this package. Do not implement SharePoint, Google Drive, S3, local-disk, vector-search, or multi-tenant infrastructure.
- `CURRENT_PROJECTION_VERSION` starts at `1`. Future renderer/projection changes must bump this explicit version instead of creating fake business revisions.
- `STATE.md` and `HANDOFF.md` are critical head views: every completed generation physically renders and verifies both from the same `ProjectState`, target revision, and projection version.
- Non-critical/entity notes may retain an older frontmatter revision when their semantic input is safely carried forward. Arbitrary note frontmatter is not authoritative project freshness.
- Completed-generation evidence is durable in Dropbox. SQLite materialization state is hot/rebuildable acceleration only.
- Completed-generation records use relative workspace paths plus a generation-level `workspace_location` (`active` or `archive`) so project archival does not require rewriting every output record merely because the workspace root moved.
- Completed-generation records are `snapshot` or `delta`. A delta points to its parent; a snapshot contains the full logical output index. Emit a new snapshot when there is no baseline, when projection version changes, or when the previous chain depth is `127`, bounding external reconstruction to at most 128 records.
- No transaction schema change is introduced solely for materialization.
- Existing `IMP-DROPRES001` resilient transport remains the provider retry layer; do not add a second independent Dropbox retry policy.
- Existing project-create receipt ownership remains unchanged: `RegistryGuard` publishes the standalone committed receipt after registry finalization; `ProjectGuard` must not race it.
- Do not migrate `@cloudflare/vitest-pool-workers` to the newly renamed package as part of this package; that tooling migration is unrelated scope.

## File Structure

Create focused materialization modules rather than expanding `ProjectRepository` or `ProjectGuard` into a single coordinator:

- `src/domain/materialization.ts` — validated durable completed-generation/head contracts.
- `src/materialization/hash.ts` — deterministic canonical JSON and SHA-256 helpers.
- `src/materialization/planner.ts` — semantic fingerprints, affected entity selection, render planning, projection version.
- `src/materialization/writer.ts` — bounded provider writes, precondition checks, critical verification.
- `src/materialization/ledger.ts` — SQLite hot target/progress/baseline state.
- `src/materialization/coordinator.ts` — target selection, recovery, coalescing, publication ordering, archive handling.
- `src/dropbox/layout.ts` — durable materialization evidence paths only.
- `src/dropbox/repository.ts` — read/write canonical derivatives and materialization evidence; no orchestration policy.
- `src/durable/project-guard.ts` — commit scheduling, alarm entrypoint, recovery integration.
- `src/index.ts` — periodic fleet reconciliation safety net; normal ingress remains unchanged.

---

### Task 1: Durable materialization evidence contract and Dropbox paths

**Files:**
- Create: `src/domain/materialization.ts`
- Modify: `src/dropbox/layout.ts`
- Modify: `src/dropbox/repository.ts`
- Create: `test/materialization-repository.spec.ts`

**Interfaces:**
- Produces `CURRENT_PROJECTION_VERSION`, `ProjectionOutputEvidence`, `CompletedMaterializationRecord`, `MaterializationHead`, `MaterializationGenerationRef`, `parseCompletedMaterializationRecord()`, and `parseMaterializationHead()`.
- Produces `machineMaterializationRoot()`, `machineMaterializationRecordPath()`, and `machineMaterializationHeadPath()`.
- Adds repository methods `readMaterializationHead()`, `readMaterializationRecord()`, `listMaterializationRecordRefs()`, `writeCompletedMaterializationRecord()`, `writeMaterializationHead()`, and `materializeCanonicalDerivatives()`.

- [ ] **Step 1: Write RED tests for immutable generation evidence and head ordering**

Create `test/materialization-repository.spec.ts` with a local `FakeTransport` matching the existing `DropboxTransport` test pattern. The first tests must import the missing APIs and prove:

```ts
import { describe, expect, it } from "vitest";
import {
  CURRENT_PROJECTION_VERSION,
  type CompletedMaterializationRecord,
  type MaterializationHead
} from "../src/domain/materialization";
import {
  machineMaterializationHeadPath,
  machineMaterializationRecordPath
} from "../src/dropbox/layout";
import { ProjectRepository } from "../src/dropbox/repository";

const completed: CompletedMaterializationRecord = {
  schema_version: "1.0",
  project_id: "PRJ-3101",
  target_revision: 7,
  projection_version: CURRENT_PROJECTION_VERSION,
  record_kind: "snapshot",
  parent: null,
  chain_depth: 0,
  workspace_location: "active",
  outputs: {
    "global:STATE": {
      relative_path: "STATE.md",
      input_hash: "a".repeat(64),
      content_hash: "b".repeat(64),
      source_revision: 7
    },
    "global:HANDOFF": {
      relative_path: "HANDOFF.md",
      input_hash: "c".repeat(64),
      content_hash: "d".repeat(64),
      source_revision: 7
    }
  },
  removed_outputs: [],
  total_output_count: 2,
  result_root_hash: "e".repeat(64),
  coalesced_revisions: [],
  source_event_id: "EVT-000007",
  completed_at: "2026-08-24T16:40:00+01:00"
};

const head: MaterializationHead = {
  schema_version: "1.0",
  project_id: completed.project_id,
  target_revision: completed.target_revision,
  projection_version: completed.projection_version,
  workspace_location: completed.workspace_location,
  record_path: machineMaterializationRecordPath(
    completed.project_id,
    completed.target_revision,
    completed.projection_version
  ),
  result_root_hash: completed.result_root_hash,
  completed_at: completed.completed_at
};
```

Assert all of these behaviors:

- record path is `/PROJECT_OS/.project-os/projects/PRJ-3101/materializations/REV-000007-PV-0001.json`;
- identical record replay performs one immutable upload total;
- different bytes at the same generation path throw an immutable conflict;
- the head path is `/PROJECT_OS/.project-os/projects/PRJ-3101/materialization-head.json`;
- writing a completed record does not implicitly advance head;
- after the record exists, `writeMaterializationHead(head)` publishes the pointer;
- `readMaterializationHead()` and `readMaterializationRecord()` validate project/revision/version binding;
- `listMaterializationRecordRefs()` ignores unrelated filenames and returns parsed generation refs sorted by projection version then revision.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run test/materialization-repository.spec.ts
```

Expected: imports for materialization domain/path/repository methods fail because they do not exist.

- [ ] **Step 3: Add the validated materialization domain schema**

Create `src/domain/materialization.ts` with these public constants/types and Zod validation:

```ts
import { z } from "zod";

export const CURRENT_PROJECTION_VERSION = 1 as const;
export const MATERIALIZATION_SNAPSHOT_MAX_CHAIN_DEPTH = 127 as const;

const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const eventId = z.string().regex(/^EVT-[0-9]{6,}$/).nullable();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const positiveInt = z.number().int().positive();
const revision = z.number().int().nonnegative();

export const projectionOutputEvidenceSchema = z.strictObject({
  relative_path: z.string().min(1),
  input_hash: hash,
  content_hash: hash,
  source_revision: revision
});

export const materializationGenerationRefSchema = z.strictObject({
  target_revision: revision,
  projection_version: positiveInt
});

export const completedMaterializationRecordSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: projectId,
  target_revision: revision,
  projection_version: positiveInt,
  record_kind: z.enum(["snapshot", "delta"]),
  parent: materializationGenerationRefSchema.nullable(),
  chain_depth: z.number().int().min(0).max(MATERIALIZATION_SNAPSHOT_MAX_CHAIN_DEPTH),
  workspace_location: z.enum(["active", "archive"]),
  outputs: z.record(z.string().min(1), projectionOutputEvidenceSchema),
  removed_outputs: z.array(z.string().min(1)),
  total_output_count: z.number().int().nonnegative(),
  result_root_hash: hash,
  coalesced_revisions: z.array(revision),
  source_event_id: eventId,
  completed_at: timestamp
}).superRefine((value, ctx) => {
  if (value.record_kind === "snapshot" && (value.parent !== null || value.chain_depth !== 0)) {
    ctx.addIssue({ code: "custom", message: "snapshot materialization must have null parent and chain_depth=0" });
  }
  if (value.record_kind === "delta" && (value.parent === null || value.chain_depth < 1)) {
    ctx.addIssue({ code: "custom", message: "delta materialization requires parent and chain_depth>=1" });
  }
});

export const materializationHeadSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: projectId,
  target_revision: revision,
  projection_version: positiveInt,
  workspace_location: z.enum(["active", "archive"]),
  record_path: z.string().min(1),
  result_root_hash: hash,
  completed_at: timestamp
});

export type ProjectionOutputEvidence = z.infer<typeof projectionOutputEvidenceSchema>;
export type MaterializationGenerationRef = z.infer<typeof materializationGenerationRefSchema>;
export type CompletedMaterializationRecord = z.infer<typeof completedMaterializationRecordSchema>;
export type MaterializationHead = z.infer<typeof materializationHeadSchema>;

export function parseCompletedMaterializationRecord(input: unknown): CompletedMaterializationRecord {
  return completedMaterializationRecordSchema.parse(input);
}

export function parseMaterializationHead(input: unknown): MaterializationHead {
  return materializationHeadSchema.parse(input);
}
```

- [ ] **Step 4: Add machine paths and repository evidence methods**

In `src/dropbox/layout.ts`, add:

```ts
export function machineMaterializationRoot(projectId: string): string {
  return `${machineProjectRoot(projectId)}/materializations`;
}

export function machineMaterializationRecordPath(
  projectId: string,
  targetRevision: number,
  projectionVersion: number
): string {
  if (!Number.isSafeInteger(targetRevision) || targetRevision < 0) throw new Error(`Invalid materialization revision: ${targetRevision}`);
  if (!Number.isSafeInteger(projectionVersion) || projectionVersion < 1) throw new Error(`Invalid projection version: ${projectionVersion}`);
  return `${machineMaterializationRoot(projectId)}/REV-${targetRevision.toString().padStart(6, "0")}-PV-${projectionVersion.toString().padStart(4, "0")}.json`;
}

export function machineMaterializationHeadPath(projectId: string): string {
  return `${machineProjectRoot(projectId)}/materialization-head.json`;
}
```

Add those functions to `v2Paths`.

In `src/dropbox/repository.ts`, import the new parsers/types and implement:

```ts
async readMaterializationHead(projectId: string): Promise<MaterializationHead | null>;
async readMaterializationRecord(
  projectId: string,
  revision: number,
  projectionVersion: number
): Promise<CompletedMaterializationRecord | null>;
async listMaterializationRecordRefs(projectId: string): Promise<MaterializationGenerationRef[]>;
async writeCompletedMaterializationRecord(record: CompletedMaterializationRecord): Promise<void>;
async writeMaterializationHead(head: MaterializationHead): Promise<void>;
async materializeCanonicalDerivatives(
  record: CanonicalCommitRecord,
  options: CommitWriteOptions = {}
): Promise<void>;
```

`writeCompletedMaterializationRecord()` must use existing `safeAdd()`. `writeMaterializationHead()` must first read the referenced record and verify project/revision/version/root hash match before overwriting the small head pointer. `materializeCanonicalDerivatives()` writes event + machine snapshot and standalone receipt when `publishReceipt !== false`, but performs no human workspace writes.

- [ ] **Step 5: Run focused repository tests and existing commit repository tests**

Run:

```bash
npx vitest run test/materialization-repository.spec.ts test/commit-repository.spec.ts
```

Expected: all pass. Existing `materializeCommit()` behavior remains available for compatibility tests but is no longer the future ProjectGuard commit path.

- [ ] **Step 6: Commit Task 1**

Commit message:

```text
feat: add durable materialization evidence
```

---

### Task 2: Deterministic semantic fingerprints and incremental projection planner

**Files:**
- Create: `src/materialization/hash.ts`
- Create: `src/materialization/planner.ts`
- Create: `test/materialization-planner.spec.ts`

**Interfaces:**
- Produces `sha256Text()`, `sha256Canonical()`, `projectionIndexRootHash()`.
- Produces `ProjectionBaseline`, `PlannedProjectionOutput`, `ProjectionPlan`, and `planProjection(record, baseline, projectionVersion)`.
- Planner outputs workspace-relative paths; it does not call Dropbox.

- [ ] **Step 1: Write RED hash determinism and planner efficiency tests**

Create `test/materialization-planner.spec.ts`. Build revision 1 with `emptyProjectState()`, then apply real transactions with `applyTransaction()` to create a constraint, task, decision, research record, phase, and deliverable. Tests must prove:

```ts
expect(await sha256Canonical({ b: 2, a: 1 }))
  .toBe(await sha256Canonical({ a: 1, b: 2 }));
```

Then prove these planner behaviors:

- initial/no-baseline plan includes every global view and every existing entity output;
- `STATE` and `HANDOFF` are marked `critical: true`;
- after a `task.start`, the changed entity set contains that task but no unrelated decisions/research/deliverables;
- after the same `task.start`, `BRIEF` is carried forward because its semantic input did not change despite project revision changing;
- `ROADMAP`, `PLAN`, `STATE`, and `HANDOFF` are re-rendered for that task change;
- `decision.accept` changes the decision note plus `DISCOVERY` and `HANDOFF`, but not `BRIEF`;
- `constraint.add` changes the constraint note, `BRIEF`, and `PROJECT`;
- `research.add` changes the research note but does not rewrite `DISCOVERY` until discovery synthesis actually references it;
- `deliverable.*` changes only that deliverable entity plus `ROADMAP` among non-critical aggregate views;
- a projection-version change with unchanged business revision creates a full snapshot plan and renders every output without creating a domain event;
- all output keys and relative paths are deterministic regardless of object insertion order.

- [ ] **Step 2: Run focused planner tests and verify RED**

Run:

```bash
npx vitest run test/materialization-planner.spec.ts
```

Expected: missing materialization hash/planner modules.

- [ ] **Step 3: Implement canonical hashing**

Create `src/materialization/hash.ts`:

```ts
export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export async function sha256Canonical(value: unknown): Promise<string> {
  return sha256Text(canonicalJson(value));
}

export async function projectionIndexRootHash(
  outputs: ReadonlyMap<string, ProjectionOutputEvidence>
): Promise<string> {
  return sha256Canonical([...outputs.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
```

Import `ProjectionOutputEvidence` from the domain module.

- [ ] **Step 4: Implement exact semantic input builders**

In `src/materialization/planner.ts`, define a project identity used by every projection input:

```ts
const identity = (state: ProjectState) => ({
  project_id: state.project_id,
  slug: state.slug,
  name: state.name
});
```

Non-critical global input objects must match renderer dependencies while intentionally excluding global revision/updated timestamp:

```ts
const briefInput = (state: ProjectState) => ({
  ...identity(state),
  objective: state.objective,
  framing: {
    scope: state.framing.scope,
    out_of_scope: state.framing.out_of_scope,
    stakeholders: state.framing.stakeholders,
    success_criteria: state.framing.success_criteria,
    open_questions: state.framing.open_questions
  },
  constraints: Object.values(state.constraints)
    .sort((a, b) => a.constraint_id.localeCompare(b.constraint_id))
    .map(({ constraint_id, title, description }) => ({ constraint_id, title, description }))
});

const discoveryInput = (state: ProjectState) => {
  const researchIds = new Set([
    ...state.discovery.confirmed_findings.flatMap((finding) => finding.research_ids),
    ...state.discovery.provisional_findings.flatMap((finding) => finding.research_ids)
  ]);
  return {
    ...identity(state),
    discovery: state.discovery,
    research_titles: [...researchIds].sort().map((id) => ({ id, title: state.research[id]?.title ?? id })),
    accepted_decisions: Object.values(state.decisions)
      .filter((decision) => decision.status === "accepted")
      .sort((a, b) => a.decision_id.localeCompare(b.decision_id))
      .map(({ decision_id, title }) => ({ decision_id, title }))
  };
};

const roadmapInput = (state: ProjectState) => ({
  ...identity(state),
  current_phase_id: state.current_phase_id,
  phases: Object.values(state.plan_phases)
    .sort((a, b) => a.phase_id.localeCompare(b.phase_id))
    .map(({ phase_id, title, objective, next_actions, status }) => ({ phase_id, title, objective, next_actions, status })),
  tasks: Object.values(state.tasks)
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map(({ task_id, title, status, blocked_reason }) => ({ task_id, title, status, blocked_reason })),
  deliverables: Object.values(state.deliverables)
    .sort((a, b) => a.deliverable_id.localeCompare(b.deliverable_id))
    .map(({ deliverable_id, title, status }) => ({ deliverable_id, title, status }))
});

const projectInput = (state: ProjectState) => ({
  ...identity(state),
  status: state.status,
  objective: state.objective,
  aliases: state.aliases,
  constraints: Object.values(state.constraints)
    .sort((a, b) => a.constraint_id.localeCompare(b.constraint_id))
    .map(({ constraint_id, title, description }) => ({ constraint_id, title, description }))
});

const planInput = (state: ProjectState) => ({
  ...identity(state),
  phases: Object.values(state.plan_phases)
    .sort((a, b) => a.phase_id.localeCompare(b.phase_id))
    .map(({ phase_id, title, objective, next_actions, status }) => ({ phase_id, title, objective, next_actions, status })),
  tasks: Object.values(state.tasks)
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map(({ task_id, title, status, phase_id }) => ({ task_id, title, status, phase_id }))
});
```

Entity input hashes use project identity plus the exact entity record. Deliverable input additionally includes the titles of its referenced decisions because `renderDeliverable()` dereferences those titles.

All input hashes are:

```ts
await sha256Canonical({ projection_version: projectionVersion, semantic_input: value });
```

Critical `STATE`/`HANDOFF` input hashes additionally include `target_revision`; both are always rendered.

- [ ] **Step 5: Implement incremental entity selection and rendering**

Define exact logical keys/relative paths:

```ts
const GLOBAL_PATHS = {
  BRIEF: "BRIEF.md",
  DISCOVERY: "DISCOVERY.md",
  ROADMAP: "ROADMAP.md",
  PROJECT: "PROJECT.md",
  PLAN: "PLAN.md",
  STATE: "STATE.md",
  HANDOFF: "HANDOFF.md"
} as const;

const entityPath = (folder: string, id: string) => `${folder}/${id}.md`;
```

For same-version incremental plans, only entity operations below are candidates for entity re-render:

```ts
switch (record.transaction.operation) {
  case "decision.accept":
  case "decision.supersede":
    return [{ folder: "DECISIONS", id: record.transaction.payload.decision_id }];
  case "task.create":
  case "task.start":
  case "task.complete":
  case "task.block":
    return [{ folder: "TASKS", id: record.transaction.payload.task_id }];
  case "constraint.add":
    return [{ folder: "CONSTRAINTS", id: record.transaction.payload.constraint_id }];
  case "research.add":
    return [{ folder: "RESEARCH", id: record.transaction.payload.research_id }];
  case "deliverable.create":
  case "deliverable.start":
  case "deliverable.revise":
  case "deliverable.submit_review":
  case "deliverable.accept":
  case "deliverable.supersede":
  case "deliverable.abandon":
  case "deliverable.add":
  case "deliverable.complete":
    return [{ folder: "DELIVERABLES", id: record.transaction.payload.deliverable_id }];
  default:
    return [];
}
```

Initial/no-baseline and projection-version-change plans enumerate every current decision, constraint, task, research record, and deliverable.

For each potential non-critical output, compare the new semantic `input_hash` with baseline evidence. If equal, do not render and leave baseline evidence carried forward. If different/missing, render once, compute `content_hash`, and add a `PlannedProjectionOutput` with `source_revision = record.new_revision`.

- [ ] **Step 6: Run planner tests and rendering regression suites**

Run:

```bash
npx vitest run test/materialization-planner.spec.ts test/render-human-views.spec.ts test/sop-rendering.spec.ts
```

If one of those existing rendering filenames differs in the repository, use the exact current rendering test filenames discovered by `ls test | grep -E 'render|sop'`; do not create a second duplicate suite merely to satisfy this command.

Expected: planner tests green and existing rendered Markdown bytes unchanged.

- [ ] **Step 7: Commit Task 2**

Commit message:

```text
feat: add incremental projection planner
```

---

### Task 3: Bounded projection writer with preconditions and critical verification

**Files:**
- Create: `src/materialization/writer.ts`
- Create: `test/materialization-writer.spec.ts`
- Modify: `src/env.ts`

**Interfaces:**
- Produces `MaterializationOutputConflictError`, `parseProjectionConcurrency()`, `WorkspaceProjectionWriter`.
- `WorkspaceProjectionWriter.materialize(plan, options)` returns verified evidence for changed outputs and invokes `onOutputVerified(key, evidence)` after each successful output.

- [ ] **Step 1: Write RED writer behavior tests**

Create `test/materialization-writer.spec.ts` with an instrumented in-memory `DropboxTransport`. Tests must prove:

- missing destination uses `add`;
- destination already at desired `content_hash` is idempotent with zero upload;
- when baseline evidence exists, a destination whose current hash is neither baseline nor desired throws `MaterializationOutputConflictError` and is not overwritten;
- bootstrap without baseline may overwrite an existing known machine-managed note only when it contains the exact `MANAGED_NOTICE` marker;
- bootstrap refuses to overwrite an untracked file without the managed marker;
- non-critical output upload success is accepted without an unnecessary read-back;
- critical `STATE` and `HANDOFF` are downloaded and hash-verified after upload;
- one worker failure preserves callbacks for outputs already verified;
- maximum concurrent upload operations never exceeds configured limit;
- `parseProjectionConcurrency(undefined) === 4`, accepts `1..4`, and rejects `0`, `5`, non-integers, and non-numeric values.

Use a concurrency probe like:

```ts
let inFlight = 0;
let maxInFlight = 0;
async function instrumentedUpload() {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await Promise.resolve();
  inFlight -= 1;
}
```

- [ ] **Step 2: Run writer tests and verify RED**

Run:

```bash
npx vitest run test/materialization-writer.spec.ts
```

Expected: writer module does not exist.

- [ ] **Step 3: Implement bounded concurrency and provider precondition logic**

Create `src/materialization/writer.ts` with:

```ts
export function parseProjectionConcurrency(value?: string): number {
  if (value === undefined || value === "") return 4;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 4) {
    throw new Error(`Invalid PROJECT_OS_PROJECTION_CONCURRENCY: ${value}`);
  }
  return parsed;
}
```

Add to `Env`:

```ts
PROJECT_OS_PROJECTION_CONCURRENCY?: string;
```

`WorkspaceProjectionWriter` must wrap the supplied transport with `ResilientDropboxTransport`. It receives a workspace root separately from relative output paths.

For each changed output, use this exact decision order:

1. Download current destination when a precondition/verification is required.
2. If current hash equals desired hash, return desired evidence without upload.
3. If baseline evidence exists and current is non-null but its hash differs from baseline `content_hash`, throw `MaterializationOutputConflictError`.
4. If no baseline evidence and current exists, require `current.includes(MANAGED_NOTICE)` before overwrite.
5. Upload `add` when missing, otherwise `overwrite`.
6. For critical outputs, immediately download and require hash equals desired `content_hash`.
7. Invoke progress callback only after the output is verified/idempotent.

Process non-critical changed outputs first through a bounded worker pool. Only after that stage succeeds, process critical outputs (`STATE`, `HANDOFF`) through the same bounded mechanism. Do not publish generation evidence in this class.

- [ ] **Step 4: Run writer tests plus Dropbox resilience suites**

Run:

```bash
npx vitest run test/materialization-writer.spec.ts test/dropbox-read-resilience.spec.ts test/dropbox-read-failclosed.spec.ts test/dropbox-write-resilience.spec.ts
```

Use the exact existing write-resilience filename if it differs. Expected: all pass; writer relies on existing resilient transport semantics.

- [ ] **Step 5: Commit Task 3**

Commit message:

```text
feat: add bounded projection writer
```

---

### Task 4: SQLite hot ledger for requested, active, and completed projection state

**Files:**
- Create: `src/materialization/ledger.ts`
- Create: `test/materialization-ledger.spec.ts`

**Interfaces:**
- Produces `initializeMaterializationSchema(storage)`, `MaterializationLedger`, `MaterializationTarget`, `MaterializationLedgerStatus`.
- Ledger is synchronous/transactional where possible and never writes Dropbox.

- [ ] **Step 1: Write RED ledger tests using real Durable Object SQLite**

Use `runInDurableObject` from `cloudflare:test` with a `PROJECT_GUARD` stub so tests operate on actual SQLite-backed Durable Object storage:

```ts
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MaterializationLedger, initializeMaterializationSchema } from "../src/materialization/ledger";

it("coalesces queued revisions before a target starts", async () => {
  const stub = env.PROJECT_GUARD.getByName("PRJ-3201");
  await runInDurableObject(stub, async (_instance, state) => {
    initializeMaterializationSchema(state.storage);
    const ledger = new MaterializationLedger(state.storage);
    ledger.requestTarget({ revision: 2, projection_version: 1 });
    ledger.requestTarget({ revision: 3, projection_version: 1 });
    ledger.requestTarget({ revision: 5, projection_version: 1 });
    const target = ledger.beginNextTarget();
    expect(target).toMatchObject({ revision: 5, projection_version: 1, coalesced_revisions: [2, 3, 4] });
  });
});
```

Additional tests:

- once target 5 is active, request 6 does not mutate active target 5;
- after completing 5, `beginNextTarget()` selects 6;
- a projection-version change at the same business revision is considered pending work;
- `recordVerifiedOutput()` survives a second ledger instance over the same storage;
- failed attempt status does not advance local completed head;
- `completeTarget()` atomically applies delta evidence to the current output baseline, removes deleted keys, updates local head, clears active progress, and leaves a newer requested target queued;
- `restoreExternalBaseline()` replaces local output baseline/head from externally reconstructed evidence;
- `status()` exposes head/requested/active revisions and counts without file content.

- [ ] **Step 2: Run ledger tests and verify RED**

Run:

```bash
npx vitest run test/materialization-ledger.spec.ts
```

Expected: ledger module missing.

- [ ] **Step 3: Implement SQLite tables**

`initializeMaterializationSchema(storage)` must execute:

```sql
CREATE TABLE IF NOT EXISTS materialization_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  head_revision INTEGER,
  head_projection_version INTEGER,
  requested_revision INTEGER,
  requested_projection_version INTEGER,
  active_revision INTEGER,
  active_projection_version INTEGER,
  active_coalesced_json TEXT NOT NULL DEFAULT '[]',
  active_status TEXT,
  last_error TEXT
);
INSERT OR IGNORE INTO materialization_control (singleton) VALUES (1);

CREATE TABLE IF NOT EXISTS materialization_outputs (
  output_key TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_revision INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS materialization_attempt_outputs (
  output_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  projection_version INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  status TEXT NOT NULL
);
```

Do not store rendered Markdown content in SQLite.

- [ ] **Step 4: Implement target/coalescing rules**

`requestTarget()` keeps the highest requested revision for the same projection version. A higher projection version replaces the requested projection version and targets the supplied current canonical revision.

`beginNextTarget()`:

- returns current active target unchanged if one exists;
- returns `null` when requested target equals completed local head;
- otherwise starts the latest requested target;
- when same projection version and `requested_revision > head_revision + 1`, records the missing intermediate revisions in `coalesced_revisions`;
- never preempts an already active target. This deliberately avoids writing one incomplete target and then treating those bytes as an unexplained conflict for a newer target.

`completeTarget()` uses `storage.transactionSync()` to update baseline outputs/head and clear active rows atomically.

- [ ] **Step 5: Run ledger tests and verify GREEN**

Run:

```bash
npx vitest run test/materialization-ledger.spec.ts
```

Expected: all pass.

- [ ] **Step 6: Commit Task 4**

Commit message:

```text
feat: add materialization sqlite ledger
```

---

### Task 5: Materialization coordinator, compact generation records, recovery, and head repair

**Files:**
- Create: `src/materialization/coordinator.ts`
- Create: `test/materialization-coordinator.spec.ts`
- Modify: `src/dropbox/repository.ts`

**Interfaces:**
- Produces `MaterializationCoordinator.requestTarget()`, `reconcile()`, `runNext()`, `runUntilIdle()`, and `status()`.
- Produces `rebuildProjectionBaseline(repository, head)` and compact snapshot/delta generation publication.

- [ ] **Step 1: Write RED coordinator tests with fake repository/writer/ledger ports**

Create `test/materialization-coordinator.spec.ts` around public interfaces, not private implementation methods. Prove:

1. no baseline -> first completed generation is `snapshot`, `chain_depth=0`, and includes the full logical output index;
2. next same-version task-only generation is `delta` and includes only changed evidence (`STATE`, `HANDOFF`, task, affected aggregates) rather than every carried-forward output;
3. delta `result_root_hash` equals the root hash of the full logical baseline after applying delta;
4. when previous `chain_depth === 127`, next completed record is a fresh `snapshot` with `chain_depth=0`;
5. completed record is written before head; injected failure on head write leaves immutable record present;
6. reconciliation sees the existing immutable record and repairs head without calling writer again;
7. missing hot ledger state reconstructs baseline by following parent records backward to a snapshot and verifying final root hash;
8. broken/missing parent or root mismatch fails closed;
9. crash after N outputs resumes verified attempt outputs and writes/verifies only missing or uncertain outputs;
10. requested revisions 72,73,74,75 with no active target project only 75 and record `[72,73,74]` as coalesced;
11. projection version 2 at canonical revision 75 creates a new snapshot at revision 75 without any new canonical commit;
12. exact replay when head already equals target/version performs zero writer uploads and zero new generation/head writes.

- [ ] **Step 2: Run coordinator tests and verify RED**

Run:

```bash
npx vitest run test/materialization-coordinator.spec.ts
```

Expected: coordinator module missing.

- [ ] **Step 3: Implement external baseline reconstruction**

In `src/materialization/coordinator.ts`, implement:

```ts
export interface ProjectionBaseline {
  head: MaterializationHead;
  outputs: Map<string, ProjectionOutputEvidence>;
  chain_depth: number;
}
```

`rebuildProjectionBaseline()`:

1. reads the head's referenced completed record;
2. walks `parent` links until a `snapshot` is reached, rejecting more than 128 records;
3. reverses the collected chain;
4. starts from snapshot outputs, then applies each delta's `removed_outputs` and `outputs`;
5. after each record, requires `outputs.size === total_output_count` and recomputed `projectionIndexRootHash(outputs) === result_root_hash`;
6. returns final map/head/chain depth.

If head is missing, `reconcile()` calls `listMaterializationRecordRefs(projectId)`, filters to `CURRENT_PROJECTION_VERSION` and revisions `<= canonicalRevision`, selects the highest revision, validates its chain, and repairs head. Do not treat a malformed record as valid evidence.

- [ ] **Step 4: Implement coordinator run ordering**

For one active target:

```text
read canonical commit record
-> materialize canonical derivatives (event/snapshot/receipt ownership preserved)
-> load/rebuild baseline
-> plan desired human projection
-> resume/execute changed non-critical outputs
-> execute/verify STATE + HANDOFF
-> build full logical output index
-> create snapshot or compact delta record
-> write immutable completed-generation record
-> write materialization head
-> atomically update hot ledger completed baseline
-> schedule newer requested target if one exists
```

A delta record contains only evidence whose logical output evidence changed plus `removed_outputs`; parent chain reconstructs carried-forward entries. A snapshot contains the full output index. This compact record choice prevents large projects from writing a full manifest every revision while keeping reconstruction bounded.

- [ ] **Step 5: Preserve project-create receipt ownership**

When target commit operation is `project.create`, coordinator calls:

```ts
await repository.materializeCanonicalDerivatives(record, { publishReceipt: false });
```

All other committed operations use default receipt publication. `RegistryGuard.finishAllocatedCreate()` remains the sole publisher of standalone create receipt after registry write.

- [ ] **Step 6: Run coordinator/repository tests**

Run:

```bash
npx vitest run test/materialization-coordinator.spec.ts test/materialization-repository.spec.ts test/commit-repository.spec.ts
```

Expected: all pass.

- [ ] **Step 7: Commit Task 5**

Commit message:

```text
feat: add resumable materialization coordinator
```

---

### Task 6: Decouple ProjectGuard business commit from human materialization and drive alarms

**Files:**
- Modify: `src/durable/project-guard.ts`
- Create: `test/materialization-project-guard.spec.ts`

**Interfaces:**
- ProjectGuard keeps existing `/transaction`, `/artifact`, and `/materialize` contracts.
- Adds internal `POST /reconcile-materialization` and `GET /materialization-status` routes for Worker/internal-admin use.
- Adds `alarm(alarmInfo?: AlarmInvocationInfo): Promise<void>`.

- [ ] **Step 1: Write RED ProjectGuard commit-decoupling tests**

Create `test/materialization-project-guard.spec.ts` using `installDropboxMock`, `env.PROJECT_GUARD.getByName()`, `runDurableObjectAlarm`, `runInDurableObject`, and `evictDurableObject` from `cloudflare:test`.

Prove:

- a normal transaction returns `status: committed` after immutable commit record exists even when a fault is configured for a subsequent workspace upload;
- immediately after the transaction response, no completed materialization head is required for business receipt validity;
- `runDurableObjectAlarm(stub)` converges the workspace/head once provider fault is removed/retryable;
- exact transaction replay before/after materialization returns the same committed receipt and no second business revision;
- a failed workspace projection does not invoke rollback and does not change canonical revision;
- ProjectGuard SQL `project_state` is persisted before returning business receipt;
- after `evictDurableObject(stub)`, the scheduled/alarm path can continue from SQLite/Dropbox evidence;
- `/materialize` still performs a synchronous `runUntilIdle()` for the existing admin migration route and returns `{ project_id, revision, materialized: true }` only after head reaches current target/version.

- [ ] **Step 2: Run focused ProjectGuard test and verify RED**

Run:

```bash
npx vitest run test/materialization-project-guard.spec.ts
```

Expected: no materialization coordinator/alarm integration exists.

- [ ] **Step 3: Construct one shared Dropbox client plus repository/writer/coordinator**

In `ProjectGuard` constructor:

1. keep layout parsing;
2. create one raw `DropboxClient`;
3. construct `ProjectRepository(rawClient, layoutMode)`;
4. initialize materialization SQL tables;
5. construct `MaterializationLedger`;
6. construct `WorkspaceProjectionWriter(rawClient, parseProjectionConcurrency(env.PROJECT_OS_PROJECTION_CONCURRENCY))`;
7. construct `MaterializationCoordinator` for V2 mode.

Do not enable the new engine for legacy layout paths.

- [ ] **Step 4: Change the V2 commit critical path**

Replace this current sequence:

```ts
await this.repository.writeCommitRecord(record);
await this.repository.materializeCommit(record, { publishReceipt: ... });
this.persistCommit(result.state, receipt);
```

with:

```ts
await this.repository.writeCommitRecord(record);
this.persistCommit(result.state, receipt);
await this.requestMaterializationSafely(result.state.revision);
```

`requestMaterializationSafely()` must catch scheduling/ledger errors, log structured failure, and never convert an already-written canonical commit into an HTTP failure. It requests `(revision, CURRENT_PROJECTION_VERSION)` and ensures an immediate alarm exists using `ctx.storage.getAlarm()` / `setAlarm(Date.now())`.

Keep registry status synchronization behavior unchanged in this package.

- [ ] **Step 5: Remove human materialization from canonical reconciliation**

Replace `materializeRecoveredRecord()` with recovery behavior that:

```ts
this.persistCommit(record.state, record.receipt);
await this.requestMaterializationSafely(record.new_revision);
```

It must not call `repository.materializeCommit()` or `writeHumanViews()`.

In `replayStatusSideEffects()`, remove direct `archiveHumanWorkspace()` execution for `project.archive`; archive movement becomes coordinator-owned. Keep registry status synchronization.

- [ ] **Step 6: Add alarm behavior with bounded retry semantics**

Implement:

```ts
async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
  if (this.layoutMode !== "v2") return;
  try {
    const result = await this.materializationCoordinator.runNext();
    if (result.more_work) await this.ctx.storage.setAlarm(Date.now());
  } catch (error) {
    if (error instanceof MaterializationOutputConflictError) {
      console.error("Project OS materialization blocked", structuredMaterializationError(error));
      return;
    }
    if ((alarmInfo?.retryCount ?? 0) >= 5) {
      console.error("Project OS materialization deferred after alarm retries", structuredMaterializationError(error));
      await this.ctx.storage.setAlarm(Date.now() + 300_000);
      return;
    }
    throw error;
  }
}
```

This uses Cloudflare's alarm retry behavior for short failures, then explicitly reschedules after five minutes so a long provider outage does not permanently exhaust automatic recovery.

- [ ] **Step 7: Implement internal reconcile/status and admin materialize compatibility**

`POST /reconcile-materialization`:

- reconcile canonical commits;
- request current state revision/current projection version if head lags;
- ensure alarm scheduled;
- return compact status.

`GET /materialization-status` returns no file content, only project ID, canonical revision, projection version, materialized head, requested target, active target, blocked error, and output counts.

Existing `POST /materialize` calls `runUntilIdle()` synchronously and keeps its external response shape for `materializeExistingProjects()`.

- [ ] **Step 8: Run ProjectGuard, recovery, commit, and rollback regression suites**

Run:

```bash
npx vitest run \
  test/materialization-project-guard.spec.ts \
  test/commit-repository.spec.ts \
  test/commit-record.spec.ts \
  test/rollback-project-guard.spec.ts \
  test/recovery.spec.ts
```

Use exact current recovery/rollback integration filenames if different. Expected: business commit/replay semantics stay unchanged while human materialization is asynchronous.

- [ ] **Step 9: Commit Task 6**

Commit message:

```text
feat: decouple commits from human materialization
```

---

### Task 7: Periodic reconciliation safety net and archive-safe materialization

**Files:**
- Modify: `src/index.ts`
- Modify: `src/materialization/coordinator.ts`
- Modify: `src/dropbox/repository.ts`
- Create: `test/materialization-reconcile.spec.ts`
- Create: `test/materialization-archive.spec.ts`

**Interfaces:**
- Produces `reconcileMaterializations(env)` in Worker scope with bounded project concurrency.
- Coordinator supports `workspace_location: active|archive` without changing logical relative output keys.

- [ ] **Step 1: Write RED scheduled reconciliation tests**

Create `test/materialization-reconcile.spec.ts` proving:

- registry with three projects calls each ProjectGuard `/reconcile-materialization`;
- one project's reconcile failure is counted/logged but does not prevent other projects from being checked;
- fleet reconciliation concurrency never exceeds 4;
- scheduled handler still processes transaction/artifact inbox work and materialization reconciliation in the same cron execution;
- no user-facing endpoint or manual command is required.

Use an exported helper:

```ts
export interface MaterializationReconcileSummary {
  scanned: number;
  scheduled: number;
  current: number;
  failed: number;
}

export async function reconcileMaterializations(env: Env): Promise<MaterializationReconcileSummary>;
```

- [ ] **Step 2: Write RED archive tests**

Create `test/materialization-archive.spec.ts` proving:

1. active project completes a generation with `workspace_location: "active"`;
2. `project.archive` business commit returns before archive projection is required;
3. materializer updates changed generated views using the archived state, then moves the active workspace root to `ARCHIVE` exactly once;
4. completed archive generation records `workspace_location: "archive"` while logical relative paths remain `STATE.md`, `HANDOFF.md`, `TASKS/...` rather than rewriting every evidence path;
5. critical files are verified at archive destination after move;
6. replay when archive exists and active workspace is absent is idempotent;
7. archive destination plus still-present active workspace remains a fail-closed inconsistency;
8. later materialization retry never recreates an active workspace for archived state.

- [ ] **Step 3: Run new reconciliation/archive tests and verify RED**

Run:

```bash
npx vitest run test/materialization-reconcile.spec.ts test/materialization-archive.spec.ts
```

Expected: fleet reconcile and archive coordinator behavior missing.

- [ ] **Step 4: Add bounded fleet reconciliation to scheduled handler**

In `src/index.ts`, implement `reconcileMaterializations(env)` by reading the existing RegistryGuard `/registry` response and calling each project's internal reconcile route with a bounded worker pool of 4. Reuse a small generic bounded-loop helper rather than `Promise.all(registry.projects.map(...))`.

Change scheduled handler to start both jobs:

```ts
ctx.waitUntil(Promise.all([
  processInbox(env),
  reconcileMaterializations(env)
]).then(([inbox, materialization]) => {
  console.info("Project OS scheduled maintenance completed", { inbox, materialization });
}));
```

Each reconciliation failure is isolated per project and included in summary; do not reject the entire fleet pass because one project is blocked.

- [ ] **Step 5: Implement archive staging/move/verification in coordinator**

For archived target:

- if archive root does not exist and active root exists, writer stages changed outputs under active root, then calls existing `archiveHumanWorkspace(state)` once;
- after move, verify `STATE.md` and `HANDOFF.md` at archive root against desired hashes;
- publish completed generation with `workspace_location: "archive"`;
- if archive root already exists and active root is absent, write/verify any required changed output directly under archive root;
- if both roots exist, propagate existing archive inconsistency error and do not advance head.

Keep projection evidence paths relative so the move does not manufacture a full-output delta.

- [ ] **Step 6: Run reconciliation/archive plus existing inbox/archive suites**

Run:

```bash
npx vitest run \
  test/materialization-reconcile.spec.ts \
  test/materialization-archive.spec.ts \
  test/admin-process-inbox.spec.ts \
  test/inbox-isolation.spec.ts
```

Also run the existing project archive lifecycle test file discovered in `test/`.

- [ ] **Step 7: Commit Task 7**

Commit message:

```text
feat: reconcile and archive materializations safely
```

---

### Task 8: End-to-end fault proofs, write-amplification assertions, and structured signals

**Files:**
- Create: `test/materialization-faults.spec.ts`
- Modify: `test/helpers/mock-dropbox.ts`
- Modify: `src/materialization/coordinator.ts`
- Modify: `src/durable/project-guard.ts`

**Interfaces:**
- Extends Dropbox mock with per-path upload counters/concurrency counters only; existing tests remain compatible.
- Emits structured materialization attempt fields through `console.info/error` without a new metrics backend.

- [ ] **Step 1: Extend the deterministic Dropbox mock for exact write accounting**

Without changing existing default behavior, return additional instrumentation from `installDropboxMock()`:

```ts
return {
  files,
  calls,
  spy,
  uploadCalls,
  downloadCalls,
  maxConcurrentUploads: () => maxConcurrentUploads
};
```

`uploadCalls` and `downloadCalls` must include exact Dropbox path so tests can assert no unrelated file was touched.

- [ ] **Step 2: Write the package acceptance fault suite**

Create `test/materialization-faults.spec.ts` with deterministic cases matching the approved spec:

- baseline materialization -> task-only transaction -> assert unrelated decision/research/deliverable entity paths receive zero uploads;
- same test -> assert `BRIEF.md` receives zero upload while `STATE.md`/`HANDOFF.md` receive current-revision uploads;
- exact completed-generation replay -> assert zero additional workspace uploads and zero new generation record;
- fail after several non-critical outputs -> retry -> only missing/uncertain outputs are touched;
- fail after `STATE` upload before `HANDOFF` -> head remains prior generation; retry ends with both critical files from same revision/version;
- fail after immutable generation record but before head -> retry repairs head with zero workspace rewrite;
- destroy hot materialization tables inside `runInDurableObject` while preserving canonical Dropbox evidence -> reconcile rebuilds baseline and converges;
- queue four rapid canonical revisions before running alarm -> latest safe target is selected and all canonical commit records remain present;
- bump projection version in a test-only planner/coordinator instance at unchanged canonical revision -> derived views refresh without domain revision/event;
- permanent unexpected destination content -> materialization blocked, canonical receipt remains committed, head does not advance;
- transient Dropbox failures remain recovered by resilient transport/alarm behavior;
- bounded concurrency instrumentation never exceeds configured limit.

- [ ] **Step 3: Add structured attempt logs**

At one coordinator attempt completion/failure, emit a single structured object with these stable field names:

```ts
{
  project_id,
  target_revision,
  projection_version,
  generation_id,
  source_transaction_id,
  source_event_id,
  outputs_planned,
  outputs_carried_forward,
  outputs_rendered,
  outputs_skipped_content_hash,
  outputs_uploaded,
  outputs_verified,
  retry_count,
  coalesced_revisions,
  duration_ms,
  final_state
}
```

Do not log Markdown contents, secrets, Dropbox tokens, or artifact bodies.

- [ ] **Step 4: Run acceptance fault suite and all reliability regression suites**

Run:

```bash
npx vitest run test/materialization-faults.spec.ts
npm test
```

Expected: full suite green. Record final test count in PR notes; do not hard-code an expected total in source.

- [ ] **Step 5: Commit Task 8**

Commit message:

```text
test: prove projection recovery and efficiency
```

---

### Task 9: Documentation, compatibility proof, CI, deploy dry-run, and production validation

**Files:**
- Create: `docs/materialization.md`
- Modify: `docs/commit-consistency.md`
- Modify: `docs/deployment.md`
- Modify: `docs/project-os-sop.md`
- Modify: `docs/superpowers/specs/2026-08-24-imp-material001-projection-engine-design.md` (status only after implementation evidence exists)

**Interfaces:**
- Documents operational truth; no new user commands.

- [ ] **Step 1: Write materialization operations documentation**

Create `docs/materialization.md` documenting:

```text
canonical commit record = business truth
materialization head = latest proven complete human projection
SQLite materialization ledger = rebuildable hot progress
completed generation record = immutable external projection checkpoint
```

Document:

- normal async flow;
- `input_hash` vs `content_hash`;
- source revision semantics for carried-forward notes;
- snapshot/delta completed-generation chain and 128-record reconstruction bound;
- head repair;
- alarm retry behavior and five-minute deferred retry after built-in retry exhaustion;
- fleet cron reconciliation safety net;
- archive flow;
- projection version bump procedure;
- recovery after hot-state loss;
- permanent destination conflict behavior;
- exact paths for materialization record/head;
- explicit statement that no direct PC access is required.

- [ ] **Step 2: Update canonical commit/recovery/deployment docs**

`docs/commit-consistency.md` must state that after `IMP-MATERIAL001`:

```text
commit record may be newer than machine snapshots/human workspace/materialization head;
that lag is expected and recoverable, not a business rollback condition.
```

`docs/deployment.md` must include a production-safe validation procedure that checks exact merge commit deployment, health, continuity `stable`, canonical revision, materialization head convergence, and no-write carry-forward evidence.

`docs/project-os-sop.md` must continue telling operators never to directly edit machine-managed canonical files and must not introduce manual sync steps for normal users.

- [ ] **Step 3: Run static and full verification**

Run exactly:

```bash
npm run check
npx wrangler deploy --dry-run
```

Both must succeed on the final implementation head.

- [ ] **Step 4: Self-review the implementation against every spec acceptance criterion**

Create a PR comment/checklist mapping each spec criterion to a concrete test name or production-validation step. Specifically verify no gaps for:

- task-only unrelated entity zero-upload;
- `BRIEF` carry-forward;
- exact replay zero writes;
- mid-generation resume;
- safe coalescing;
- `STATE/HANDOFF` completion gate;
- transient failure isolation;
- commit path decoupling;
- hot-state reconstruction;
- projection-version refresh without business revision;
- generation record before head;
- unchanged user/chat behavior;
- archive idempotency.

If any item lacks a deterministic test, add the missing test before marking the PR ready.

- [ ] **Step 5: Final implementation commit**

Commit message:

```text
docs: document projection engine operations
```

- [ ] **Step 6: PR/CI gate**

Update the implementation PR body with:

- final head SHA;
- `npm run check` result and total tests;
- Wrangler dry-run result;
- changed-file summary;
- statement that production continuity remains `stable`;
- statement that no PC/filesystem access and no user workflow change were introduced.

Mark ready only after final CI is green on that exact head.

- [ ] **Step 7: Production deployment gate**

Merge only after CI. Verify the deployment workflow is for the exact merge commit and that all deployment steps including production health succeed.

Production-safe evidence must prove:

1. a canonical revision can temporarily be ahead of materialization head and automatically converge;
2. at least one non-critical unchanged output is carried forward with no upload;
3. completed `STATE.md` and `HANDOFF.md` show the same canonical revision and correspond to the same materialization record;
4. exact replay does not create a second business revision;
5. continuity remains `stable`.

- [ ] **Step 8: Canonical Project OS closure**

After exact production proof, use normal receipt-gated Project OS transactions to:

1. record `RES-IMPMATERIAL001` with PR/CI/merge/deploy/projection evidence;
2. complete `TASK-IMPMATERIAL001`;
3. create `TASK-IMPARTIFACT001` from the approved roadmap;
4. start `TASK-IMPARTIFACT001`.

Do not directly edit machine-managed `STATE.md`, `HANDOFF.md`, manifest, or canonical state files.

---

## Plan Self-Review

### Spec coverage

- Async post-commit projection: Tasks 5–6.
- Semantic input fingerprints and content hashes: Tasks 2–3.
- Revision-bearing frontmatter carry-forward: Task 2.
- Critical `STATE/HANDOFF` same-target verification: Tasks 2–3, 5, 8.
- Durable completed-generation evidence/head ordering: Tasks 1 and 5.
- Efficient evidence at scale: Task 5 uses delta records plus bounded snapshots instead of a full manifest every commit.
- Per-output resumability: Tasks 4–5 and fault proof Task 8.
- Hot-state loss recovery: Tasks 5, 6, 8.
- Coalescing: Tasks 4–5, fault proof Task 8.
- Bounded provider concurrency: Task 3 and fault proof Task 8.
- Provider boundary/no PC access: global constraints and module boundaries.
- Projection-version rematerialization without business revision: Tasks 2, 5, 8.
- Archive safety: Task 7.
- Structured signals: Task 8.
- Existing recovery/rollback/inbox compatibility: Tasks 6–8.
- CI/dry-run/production/canonical closure: Task 9.

### Placeholder scan

The plan contains no `TODO`, `TBD`, “implement later”, or unspecified error-handling steps. Where exact existing test filenames may vary, the plan explicitly instructs discovery of the repository's current filename rather than inventing a duplicate suite.

### Type/interface consistency

- `ProjectionOutputEvidence` is defined once in Task 1 and reused by hashing, planner, ledger, coordinator, and writer.
- `CURRENT_PROJECTION_VERSION` is defined once in Task 1 and consumed everywhere else.
- Planner works with relative workspace paths; coordinator supplies active/archive root; completed evidence stores relative path plus generation-level location.
- Repository owns durable external evidence; ledger owns hot SQL progress; coordinator owns orchestration; writer owns provider writes.
- ProjectGuard schedules/coalesces targets but does not make SQLite materialization state business truth.
