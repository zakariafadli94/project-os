# Human Workspace Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate human-facing Obsidian content into `PROJECT_OS/WORKSPACE/`, move machine persistence under `PROJECT_OS/.project-os/`, materialize rich canonical entities as Markdown, and preserve a safe V1-to-V2 migration path with no project-ID/revision loss.

**Architecture:** Introduce one centralized storage-layout abstraction with three runtime modes: `legacy`, `shadow`, and `v2`. `legacy` preserves current V1 behavior; `shadow` keeps canonical V1 writes while also generating the new human workspace and V2 machine snapshots for verification; `v2` makes `.project-os/` authoritative for machine artifacts and `WORKSPACE/` authoritative for rendered human views. Project business revisions are not changed by view regeneration or storage migration.

**Tech Stack:** TypeScript, Cloudflare Workers, SQLite-backed Durable Objects, Dropbox API, Zod, Vitest, Wrangler, Obsidian Markdown/frontmatter.

**Spec:** `docs/superpowers/specs/2026-08-21-human-workspace-separation-design.md`

## Global Constraints

- Existing `PRJ-0001` and `PRJ-0002` IDs must not change.
- Existing business revision counters must not change during pure view regeneration or storage-layout migration.
- Canonical business mutations still use typed transactions and receipt gating.
- No secret values may be copied to GitHub or generated Markdown.
- Machine artifacts must never be written below `PROJECT_OS/WORKSPACE/`.
- Human generated Markdown must never be written below `PROJECT_OS/.project-os/`.
- Migration must be idempotent, restartable, and non-destructive until explicit legacy cleanup approval.
- `PROJECT_OS_LAYOUT_MODE=legacy|shadow|v2` is the only runtime layout switch; default to `legacy` when absent.
- Cloudflare deployment must continue using the existing declarative Durable Object `exports` configuration; do not replace it with migrations.
- Every production-code task follows RED → GREEN → full-suite verification → commit.

---

## File Structure

### New files

- `src/dropbox/layout.ts` — validates layout mode and exposes V1/V2 path families without scattering literals.
- `src/render/frontmatter.ts` — deterministic YAML frontmatter generation for project-scoped Markdown.
- `src/render/research.ts` — canonical research note renderer.
- `src/render/deliverable.ts` — canonical deliverable note renderer.
- `src/render/constraint.ts` — canonical constraint note renderer.
- `src/render/task.ts` — canonical task note renderer.
- `src/migration/workspace-v2.ts` — shadow materialization and idempotent V1→V2 artifact migration helpers.
- `test/workspace-layout.spec.ts` — path-family and separation tests.
- `test/rich-render.spec.ts` — frontmatter/entity renderer tests.
- `test/workspace-migration.spec.ts` — shadow/cutover/idempotency tests.

### Modified files

- `src/env.ts` — add optional `PROJECT_OS_LAYOUT_MODE`.
- `src/dropbox/paths.ts` — retain safe-ID validators but delegate V1/V2 construction to layout helpers.
- `src/dropbox/repository.ts` — split machine persistence from human materialization and support layout modes.
- `src/render/project.ts` — add frontmatter and project-scoped links.
- `src/render/state.ts` — add frontmatter and path-qualified project links.
- `src/render/plan.ts` — add frontmatter and path-qualified project links.
- `src/render/handoff.ts` — add frontmatter and path-qualified project links.
- `src/render/decision.ts` — add frontmatter and project-scoped links.
- `src/durable/project-guard.ts` — internal non-mutating materialization endpoint and layout-aware repository construction.
- `src/durable/registry-guard.ts` — layout-aware registry persistence.
- `src/index.ts` — layout-aware inbox path plus authenticated admin materialization/cutover helpers.
- `wrangler.jsonc` — set initial non-secret layout variable to `legacy`.
- `test/dropbox-paths.spec.ts` — update V1/V2 path expectations.
- `test/dropbox-repository.spec.ts` — verify ordering, shadow writes and receipt safety.
- `test/render.spec.ts` — root-view frontmatter/link assertions.
- `test/index.spec.ts` — admin route and inbox-mode tests.
- `test/project-guard.spec.ts` — non-mutating materialization tests.
- `docs/deployment.md` — staged rollout and rollback.
- `docs/project-os-sop.md` — human workspace path and graph-isolation operating rules.

---

### Task 1: Introduce explicit V1/V2 storage layout paths

**Files:**
- Create: `src/dropbox/layout.ts`
- Modify: `src/dropbox/paths.ts`
- Modify: `src/env.ts`
- Modify: `wrangler.jsonc`
- Test: `test/workspace-layout.spec.ts`
- Test: `test/dropbox-paths.spec.ts`

**Interfaces:**
- Produces: `type LayoutMode = "legacy" | "shadow" | "v2"`
- Produces: `parseLayoutMode(value?: string): LayoutMode`
- Produces: `legacyPaths` and `v2Paths` path-family objects.
- Produces V2 human helpers: `workspaceProjectRoot`, `workspaceProjectFile`, `workspaceEntityPath`.
- Produces V2 machine helpers: `machineProjectRoot`, `machineStatePath`, `machineManifestPath`, `machineEventPath`, `machineTransactionPath`, `machineReceiptPath`, `machineRegistryJsonPath`, `machineRegistryMarkdownPath`.

- [ ] **Step 1: Write failing layout-separation tests**

```ts
import { describe, expect, it } from "vitest";
import {
  parseLayoutMode,
  workspaceProjectRoot,
  machineProjectRoot,
  machineReceiptPath,
  workspaceEntityPath
} from "../src/dropbox/layout";

describe("workspace V2 layout", () => {
  it("separates human project views from machine state", () => {
    expect(workspaceProjectRoot("PRJ-0002", "project-os"))
      .toBe("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os");
    expect(machineProjectRoot("PRJ-0002"))
      .toBe("/PROJECT_OS/.project-os/projects/PRJ-0002");
    expect(machineReceiptPath("TXN-ABCDEFGHIJ"))
      .toBe("/PROJECT_OS/.project-os/receipts/TXN-ABCDEFGHIJ.json");
    expect(workspaceEntityPath("PRJ-0002", "project-os", "RESEARCH", "RES-CODE0001"))
      .toBe("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/RESEARCH/RES-CODE0001.md");
  });

  it("defaults missing layout mode to legacy", () => {
    expect(parseLayoutMode(undefined)).toBe("legacy");
    expect(parseLayoutMode("shadow")).toBe("shadow");
    expect(() => parseLayoutMode("broken")).toThrow("Invalid PROJECT_OS_LAYOUT_MODE");
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `npx vitest run test/workspace-layout.spec.ts`

Expected: FAIL because `src/dropbox/layout.ts` does not exist.

- [ ] **Step 3: Implement the minimal layout abstraction**

```ts
export type LayoutMode = "legacy" | "shadow" | "v2";

export function parseLayoutMode(value?: string): LayoutMode {
  if (value === undefined || value === "") return "legacy";
  if (value === "legacy" || value === "shadow" || value === "v2") return value;
  throw new Error(`Invalid PROJECT_OS_LAYOUT_MODE: ${value}`);
}

export const WORKSPACE_ROOT = "/PROJECT_OS/WORKSPACE";
export const MACHINE_ROOT = "/PROJECT_OS/.project-os";
```

Reuse the existing safe project/slug/ID validation from `src/dropbox/paths.ts`; do not duplicate regex logic in multiple modules.

- [ ] **Step 4: Add all exact V2 path helpers and retain V1 helpers**

V2 machine paths must be:

```text
/PROJECT_OS/.project-os/registry/PROJECT_REGISTRY.json
/PROJECT_OS/.project-os/registry/PROJECT_INDEX.md
/PROJECT_OS/.project-os/transactions/incoming/<TXN>.json
/PROJECT_OS/.project-os/transactions/committed/<TXN>.json
/PROJECT_OS/.project-os/transactions/rejected/<TXN>.json
/PROJECT_OS/.project-os/transactions/conflicts/<TXN>.json
/PROJECT_OS/.project-os/receipts/<TXN>.json
/PROJECT_OS/.project-os/projects/<PRJ>/state.json
/PROJECT_OS/.project-os/projects/<PRJ>/manifest.json
/PROJECT_OS/.project-os/projects/<PRJ>/events/<EVT>.json
```

V2 human paths must be under:

```text
/PROJECT_OS/WORKSPACE/PROJECTS/<PRJ>-<slug>/
/PROJECT_OS/WORKSPACE/PORTFOLIO/
```

- [ ] **Step 5: Add the non-secret environment variable**

`src/env.ts`:

```ts
PROJECT_OS_LAYOUT_MODE?: "legacy" | "shadow" | "v2";
```

`wrangler.jsonc` initial value:

```json
"vars": {
  "PROJECT_OS_LAYOUT_MODE": "legacy"
}
```

Do not alter Durable Object `exports`.

- [ ] **Step 6: Run focused and existing path tests**

Run: `npx vitest run test/workspace-layout.spec.ts test/dropbox-paths.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/dropbox/layout.ts src/dropbox/paths.ts src/env.ts wrangler.jsonc test/workspace-layout.spec.ts test/dropbox-paths.spec.ts
git commit -m "feat: add workspace v2 storage layout"
```

---

### Task 2: Add deterministic project frontmatter and graph-safe links

**Files:**
- Create: `src/render/frontmatter.ts`
- Modify: `src/render/project.ts`
- Modify: `src/render/state.ts`
- Modify: `src/render/plan.ts`
- Modify: `src/render/handoff.ts`
- Modify: `src/render/decision.ts`
- Test: `test/render.spec.ts`

**Interfaces:**
- Produces: `renderProjectFrontmatter(state, noteId, noteType): string`
- Root note IDs are stable strings: `PROJECT`, `STATE`, `PLAN`, `HANDOFF`.
- Decision notes use canonical decision IDs.

- [ ] **Step 1: Add failing frontmatter assertions**

Add to `test/render.spec.ts`:

```ts
expect(renderProject(state)).toContain("project_id: PRJ-0001");
expect(renderProject(state)).toContain("note_type: project");
expect(renderProject(state)).toContain("canonical: true");
expect(renderProject(state)).toContain(`revision: ${state.revision}`);
```

For handoff links, assert path qualification rather than bare ambiguous links:

```ts
expect(renderHandoff(state)).toContain("[[DECISIONS/DEC-ARCH0001|");
expect(renderHandoff(state)).not.toContain("[[DEC-ARCH0001]]");
```

- [ ] **Step 2: Run render tests and verify RED**

Run: `npx vitest run test/render.spec.ts`

Expected: FAIL because frontmatter and path-qualified links are absent.

- [ ] **Step 3: Implement deterministic frontmatter**

`src/render/frontmatter.ts` must generate exactly:

```yaml
---
project_id: PRJ-0001
project_slug: agency
project_name: Agency
note_id: PROJECT
note_type: project
canonical: true
revision: 3
---
```

Quote YAML scalar values only when required; never emit timestamps or random values that make rendering nondeterministic.

- [ ] **Step 4: Prefix all generated root/decision Markdown with frontmatter**

Apply to `PROJECT.md`, `STATE.md`, `PLAN.md`, `HANDOFF.md`, and decision Markdown.

- [ ] **Step 5: Replace ambiguous generated links**

Examples:

```text
[[DECISIONS/DEC-ARCH0001|Canonical architecture]]
[[PROJECT|Project overview]]
[[STATE|Current state]]
[[PLAN|Plan]]
```

Because root files are unique within each project folder, root links may stay root-relative; entity links must include their entity folder.

- [ ] **Step 6: Run render tests**

Run: `npx vitest run test/render.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/render/frontmatter.ts src/render/project.ts src/render/state.ts src/render/plan.ts src/render/handoff.ts src/render/decision.ts test/render.spec.ts
git commit -m "feat: add project-scoped Obsidian metadata"
```

---

### Task 3: Materialize research, deliverables, constraints, and tasks

**Files:**
- Create: `src/render/research.ts`
- Create: `src/render/deliverable.ts`
- Create: `src/render/constraint.ts`
- Create: `src/render/task.ts`
- Create: `test/rich-render.spec.ts`

**Interfaces:**
- Produces: `renderResearch(state, record): string`
- Produces: `renderDeliverable(state, record): string`
- Produces: `renderConstraint(state, record): string`
- Produces: `renderTask(state, record): string`

- [ ] **Step 1: Write failing renderer tests**

```ts
import { expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { renderResearch } from "../src/render/research";

it("renders research as a project-scoped canonical note", () => {
  const state = emptyProjectState("PRJ-0002", "Project OS", "project-os", "Control plane");
  state.revision = 19;
  const record = {
    research_id: "RES-CODE0001",
    title: "Code map",
    body: "Source responsibilities.",
    source: "GitHub main",
    created_at: "2026-08-21T00:00:00+01:00"
  };

  const markdown = renderResearch(state, record);
  expect(markdown).toContain("note_id: RES-CODE0001");
  expect(markdown).toContain("note_type: research");
  expect(markdown).toContain("# Code map");
  expect(markdown).toContain("Source responsibilities.");
});
```

Add equivalent tests for deliverable status/outcome, task status/block/result, and constraint description.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run test/rich-render.spec.ts`

Expected: FAIL because renderer modules do not exist.

- [ ] **Step 3: Implement minimal renderers using `renderProjectFrontmatter`**

Each renderer must:

1. emit stable frontmatter;
2. use the canonical record ID as `note_id`;
3. include all durable fields from the record;
4. avoid inventing data not present in structured state.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run test/rich-render.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/research.ts src/render/deliverable.ts src/render/constraint.ts src/render/task.ts test/rich-render.spec.ts
git commit -m "feat: render rich project entities"
```

---

### Task 4: Split repository writes into machine persistence and human materialization

**Files:**
- Modify: `src/dropbox/repository.ts`
- Modify: `test/dropbox-repository.spec.ts`

**Interfaces:**
- Constructor becomes `new ProjectRepository(transport, mode)` where `mode: LayoutMode`.
- Produces: `writeHumanViews(state): Promise<void>`.
- Produces: `writeMachineState(state, event): Promise<void>`.
- Produces: `materializeWorkspace(state): Promise<void>` for non-mutating regeneration.
- Existing `writeCommit(...)` remains the receipt-gated business commit entry point.

- [ ] **Step 1: Add failing shadow-mode repository test**

```ts
it("shadow mode keeps legacy canonical writes and also materializes V2 workspace", async () => {
  const transport = new FakeTransport();
  const repository = new ProjectRepository(transport, "shadow");
  const { state, event, receipt } = fixture();

  state.research["RES-CODE0001"] = {
    research_id: "RES-CODE0001",
    title: "Code map",
    body: "Responsibilities",
    created_at: state.updated_at
  };

  await repository.writeCommit(state, event, receipt);

  expect(transport.files.has("/PROJECT_OS/PROJECTS/PRJ-0001-agency/STATE.md")).toBe(true);
  expect(transport.files.has("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0001-agency/STATE.md")).toBe(true);
  expect(transport.files.has("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0001-agency/RESEARCH/RES-CODE0001.md")).toBe(true);
  expect(transport.files.has("/PROJECT_OS/.project-os/projects/PRJ-0001/state.json")).toBe(true);
  expect(transport.files.has(`/PROJECT_OS/RECEIPTS/${receipt.transaction_id}.json`)).toBe(true);
});
```

- [ ] **Step 2: Add failing receipt-order test for V2**

The last write in `v2` commit mode must still be the V2 receipt path. Any earlier human or machine write failure must leave no V2 receipt.

- [ ] **Step 3: Run repository tests and verify RED**

Run: `npx vitest run test/dropbox-repository.spec.ts`

- [ ] **Step 4: Refactor repository into explicit write phases**

Required ordering in `v2`:

```text
immutable event
→ machine state.json / manifest
→ generated entity Markdown
→ root human views
→ receipt LAST
```

Required ordering in `shadow`:

```text
legacy event/state views
→ V2 machine snapshot and V2 human views
→ legacy receipt LAST
```

A shadow failure must fail the transaction before the legacy committed receipt is published. This ensures a receipt never claims a fully shadow-materialized commit when shadow persistence failed.

- [ ] **Step 5: Materialize all rich entity collections**

Iterate deterministic sorted IDs from:

```ts
state.decisions
state.constraints
state.tasks
state.research
state.deliverables
```

Write each to its stable workspace entity path.

- [ ] **Step 6: Run repository tests**

Run: `npx vitest run test/dropbox-repository.spec.ts test/rich-render.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/dropbox/repository.ts test/dropbox-repository.spec.ts
git commit -m "feat: split machine and human persistence"
```

---

### Task 5: Add non-mutating shadow materialization to ProjectGuard

**Files:**
- Modify: `src/durable/project-guard.ts`
- Modify: `test/project-guard.spec.ts`

**Interfaces:**
- Internal endpoint: `POST /materialize`
- Request body: `{ "target": "workspace-v2" }`
- Response: `{ project_id, revision, materialized: true }`
- Must not create a DomainEvent, transaction row, receipt, or revision increment.

- [ ] **Step 1: Write failing ProjectGuard materialization test**

After creating a project at revision 1, call the internal `/materialize` endpoint and assert:

```ts
expect(result.revision).toBe(1);
expect(result.materialized).toBe(true);
```

Then re-read state and assert revision remains 1 and transaction count is unchanged.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/project-guard.spec.ts`

- [ ] **Step 3: Implement the internal endpoint**

Route before `/transaction` rejection:

```ts
if (request.method === "POST" && pathname === "/materialize") {
  const state = this.loadState();
  if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });
  await this.repository.materializeWorkspace(state);
  return Response.json({ project_id: state.project_id, revision: state.revision, materialized: true });
}
```

The repository used here must be layout-aware from `env.PROJECT_OS_LAYOUT_MODE`.

- [ ] **Step 4: Verify no business-state mutation occurs**

Run: `npx vitest run test/project-guard.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/durable/project-guard.ts test/project-guard.spec.ts
git commit -m "feat: add non-mutating workspace materialization"
```

---

### Task 6: Make registry persistence and inbox processing layout-aware

**Files:**
- Modify: `src/durable/registry-guard.ts`
- Modify: `src/index.ts`
- Modify: `test/registry-guard.spec.ts`
- Modify: `test/index.spec.ts`

**Interfaces:**
- `legacy`: current `/PROJECT_OS/SYSTEM`, `/TRANSACTIONS`, `/RECEIPTS` behavior.
- `shadow`: canonical inbox/terminal/receipt stays V1; registry additionally mirrors to V2 machine registry.
- `v2`: inbox/terminal/receipt/registry uses `.project-os` paths only.
- Public transaction API remains unchanged.

- [ ] **Step 1: Add failing inbox mode tests**

Assert exact incoming paths:

```ts
expect(inboxPath("legacy")).toBe("/PROJECT_OS/TRANSACTIONS/incoming");
expect(inboxPath("shadow")).toBe("/PROJECT_OS/TRANSACTIONS/incoming");
expect(inboxPath("v2")).toBe("/PROJECT_OS/.project-os/transactions/incoming");
```

- [ ] **Step 2: Add failing registry shadow test**

A registry update in shadow mode must write both:

```text
/PROJECT_OS/SYSTEM/PROJECT_REGISTRY.json
/PROJECT_OS/.project-os/registry/PROJECT_REGISTRY.json
```

while the user-facing Portfolio index is written under:

```text
/PROJECT_OS/WORKSPACE/PORTFOLIO/DASHBOARD.md
```

Do not expose the machine registry in the Obsidian Vault.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npx vitest run test/index.spec.ts test/registry-guard.spec.ts`

- [ ] **Step 4: Implement mode-aware inbox and terminal paths**

Replace the module-level hard-coded `INBOX` constant with a function based on `parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE)`.

- [ ] **Step 5: Implement registry mirroring/cutover**

Keep project allocation/idempotency semantics unchanged. `project.create` final receipt still appears only after registry persistence succeeds.

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/index.spec.ts test/registry-guard.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/durable/registry-guard.ts src/index.ts test/index.spec.ts test/registry-guard.spec.ts
git commit -m "feat: make registry and inbox layout-aware"
```

---

### Task 7: Add idempotent machine-artifact migration for existing V1 projects

**Files:**
- Create: `src/migration/workspace-v2.ts`
- Create: `test/workspace-migration.spec.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Authenticated admin endpoint: `POST /v1/admin/workspace-v2/materialize`
- Auth: existing `Bearer ${INGRESS_TOKEN}`.
- Body: `{ "project_ids": ["PRJ-0001", "PRJ-0002"] }`
- Produces a per-project result without changing business revision.
- Migration helper copies/mirrors legacy immutable events into V2 machine event paths using content equality/idempotent-add semantics.

- [ ] **Step 1: Write failing idempotency test**

Use a fake Dropbox transport containing:

```text
/PROJECT_OS/PROJECTS/PRJ-0001-agency/.system/events/EVT-000001.json
```

Run migration twice and assert exactly one identical V2 event exists at:

```text
/PROJECT_OS/.project-os/projects/PRJ-0001/events/EVT-000001.json
```

No duplicate, no altered content.

- [ ] **Step 2: Write interrupted-migration test**

Simulate failure after one copied event, rerun, and assert migration resumes without conflict or loss.

- [ ] **Step 3: Run migration tests and verify RED**

Run: `npx vitest run test/workspace-migration.spec.ts`

- [ ] **Step 4: Implement `mirrorImmutableFile` and legacy event discovery**

Use `DropboxClient.listFolder` on the legacy events folder. For each file:

1. download legacy content;
2. `add` to V2 path;
3. on conflict, download V2 content and require exact equality;
4. never delete/move legacy source during this phase.

- [ ] **Step 5: Implement authenticated admin materialization route**

For each project ID, invoke its Durable Object `/materialize`. Return:

```json
{
  "results": [
    { "project_id": "PRJ-0001", "status": "materialized", "revision": 1 }
  ]
}
```

Reject malformed IDs before routing.

- [ ] **Step 6: Run migration and index tests**

Run: `npx vitest run test/workspace-migration.spec.ts test/index.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/migration/workspace-v2.ts src/index.ts test/workspace-migration.spec.ts test/index.spec.ts
git commit -m "feat: add restartable workspace v2 migration"
```

---

### Task 8: Document Obsidian graph isolation and staged deployment

**Files:**
- Modify: `docs/deployment.md`
- Modify: `docs/project-os-sop.md`
- Optional generated human file after deployment: `WORKSPACE/PORTFOLIO/DASHBOARD.md`

**Interfaces:**
- Obsidian Vault root becomes local Dropbox path ending in `PROJECT_OS/WORKSPACE` only after V2 shadow verification.
- Project graph filter uses project path, for example `path:"PROJECTS/PRJ-0002-project-os"`.

- [ ] **Step 1: Update deployment documentation with exact rollout states**

Document:

```text
legacy → shadow → v2
```

and the rollback rule:

```text
v2 → previous known-good Worker + PROJECT_OS_LAYOUT_MODE=legacy
```

until explicit legacy cleanup.

- [ ] **Step 2: Add exact Obsidian instructions**

Document that the Vault is:

```text
Dropbox/Applications/project-os/PROJECT_OS/WORKSPACE
```

(or the locale-equivalent Dropbox App Folder path).

Document project graph filter example:

```text
path:"PROJECTS/PRJ-0002-project-os"
```

and state that the unfiltered global graph is Portfolio-only.

- [ ] **Step 3: Update SOP authority references**

Fresh project context reads become:

```text
WORKSPACE/PROJECTS/<PRJ>-<slug>/HANDOFF.md
WORKSPACE/PROJECTS/<PRJ>-<slug>/STATE.md
```

Machine registry is read from `.project-os/registry/PROJECT_REGISTRY.json` after V2 cutover.

- [ ] **Step 4: Commit**

```bash
git add docs/deployment.md docs/project-os-sop.md
git commit -m "docs: document workspace v2 rollout and Obsidian isolation"
```

---

### Task 9: Full regression verification before any production cutover

**Files:**
- No new production files unless a failing regression requires a scoped fix.

**Interfaces:**
- CI gate remains `npm run check`.
- Dry-run deployment gate remains `npx wrangler deploy --dry-run`.

- [ ] **Step 1: Run the complete test/type suite**

Run:

```bash
npm install
npm run check
```

Expected: all tests pass; typecheck passes.

- [ ] **Step 2: Run Wrangler dry-run**

Run:

```bash
npx wrangler deploy --dry-run
```

Expected: bundle succeeds with both Durable Object bindings and declarative `exports` intact.

- [ ] **Step 3: Verify no path crosses the human/machine boundary**

Search:

```bash
grep -R 'WORKSPACE.*events\|WORKSPACE.*receipts\|WORKSPACE.*transactions\|\.project-os.*\.md' src test
```

Expected: no unintended matches. Machine Markdown exception: machine registry index is allowed only if explicitly documented and remains outside the Vault.

- [ ] **Step 4: Verify source contains no secret values**

Search repository diff for names/known patterns only; never paste real values into commands or logs.

- [ ] **Step 5: Commit any test-only corrections, otherwise no commit**

No production deployment occurs merely because the plan tasks are green.

---

### Task 10: Controlled production rollout and clean-room validation

**Files:**
- Configuration only after code/CI approval.
- Canonical `PRJ-0002` updated through typed Project OS transactions after each validated rollout milestone.

**Interfaces:**
- Stage 1: `PROJECT_OS_LAYOUT_MODE=shadow`
- Stage 2: `PROJECT_OS_LAYOUT_MODE=v2`
- Legacy cleanup is explicitly out of scope until separate user approval.

- [ ] **Step 1: Deploy shadow mode**

Set the non-secret variable to `shadow`, deploy the already-reviewed commit, verify `GET /health` returns `{ "status": "ok" }`.

- [ ] **Step 2: Shadow-materialize existing projects**

Invoke the authenticated materialization endpoint for exactly:

```json
{ "project_ids": ["PRJ-0001", "PRJ-0002"] }
```

- [ ] **Step 3: Compare old and new views**

For each project verify:

- same `project_id`;
- same business `revision`;
- same status/current phase/tasks/constraints/decisions;
- all canonical research entries now exist as `RESEARCH/*.md`;
- all canonical deliverables now exist as `DELIVERABLES/*.md`;
- no machine files appear under `WORKSPACE/`.

- [ ] **Step 4: Validate Obsidian before cutover**

Open `PROJECT_OS/WORKSPACE` as a temporary/new Vault and verify:

- only `PROJECTS` and `PORTFOLIO` are visible at the top level;
- `PRJ-0001` and `PRJ-0002` render correctly;
- project filter for PRJ-0002 excludes PRJ-0001 nodes;
- global unfiltered graph behaves as Portfolio view.

- [ ] **Step 5: Perform V2 cutover**

Only after the previous checks pass, set `PROJECT_OS_LAYOUT_MODE=v2` and deploy the same code revision.

- [ ] **Step 6: Create one new pilot project through the normal transaction path**

Verify transaction lands under `.project-os/transactions/incoming`, receipt under `.project-os/receipts`, machine state/events under `.project-os/projects/<PRJ>`, and human views under `WORKSPACE/PROJECTS/<PRJ>-<slug>`.

- [ ] **Step 7: Run clean-room portability test**

From a fresh chat/session or other platform, recover Project OS using only:

1. `.project-os/registry/PROJECT_REGISTRY.json`;
2. `WORKSPACE/PROJECTS/PRJ-0002-project-os/HANDOFF.md`;
3. `STATE.md` and referenced project notes;
4. the GitHub repository/spec/plan.

No old chat history may be required.

- [ ] **Step 8: Persist rollout result to PRJ-0002**

Record the exact deployed Git commit, successful validation result, final layout mode and any remaining legacy-cleanup task through typed Project OS transactions. Require committed receipts before calling the migration complete.

- [ ] **Step 9: Do not delete legacy V1 paths**

Legacy cleanup requires a separate explicit user decision after a stable observation period. Archive/delete operations are not part of this plan.

---

## Self-Review

### Spec coverage

- Human/machine physical separation: Tasks 1, 4, 6.
- Rich project note types: Tasks 2–4.
- Standard frontmatter: Task 2.
- Graph isolation and link strategy: Tasks 2 and 8.
- Dropbox path abstraction: Task 1.
- Shadow migration and rollback: Tasks 4–7, 10.
- Revision/receipt safety: Tasks 4, 5, 9, 10.
- Existing project compatibility: Tasks 5, 7, 10.
- Obsidian Vault cutover: Tasks 8 and 10.
- Security and secret hygiene: Tasks 8–10.
- Cross-platform recovery: Task 10.

### Placeholder scan

No `TBD`, `TODO`, or unspecified implementation step is intentionally left in this plan. Legacy cleanup is explicitly out of scope rather than deferred ambiguously.

### Type/interface consistency

- Layout modes are consistently `legacy | shadow | v2`.
- `materializeWorkspace(state)` is non-mutating and receipt-free.
- `writeCommit(...)` remains the only business commit path.
- Canonical IDs continue to name generated entity files.
- `INGRESS_TOKEN` remains the authentication mechanism for the admin migration endpoint; no new secret is introduced.
