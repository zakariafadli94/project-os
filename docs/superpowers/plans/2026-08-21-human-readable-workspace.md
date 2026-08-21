# Human-readable Project Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate BRIEF.md, DISCOVERY.md, and ROADMAP.md for every Project OS workspace and make them the preferred human entry points without changing canonical state semantics.

**Architecture:** Add three pure renderers over the existing `ProjectState`, extend workspace filename routing, and have `ProjectRepository.writeHumanViews` materialize them before any receipt is published. Keep PROJECT/HANDOFF/STATE/PLAN unchanged as recovery-compatible system views, except PROJECT gains human-navigation links.

**Tech Stack:** TypeScript 5.9, Vitest 4.1, Cloudflare Worker, Dropbox persistence.

**Spec:** `docs/superpowers/specs/2026-08-21-human-readable-workspace-design.md`

## Global Constraints

- Do not change transaction schema, project state schema, transitions, revision/idempotency semantics, events, receipts, RegistryGuard, ProjectGuard, webhook, or authentication.
- New views must be deterministic and generated only from current `ProjectState`.
- Missing information must be stated plainly; never invent success criteria, research, decisions, or open questions.
- Receipt-last behavior must remain intact if any human view write fails.
- Existing recovery views remain available in this slice.

---

### Task 1: Add human narrative renderers

**Files:**
- Create: `src/render/brief.ts`
- Create: `src/render/discovery.ts`
- Create: `src/render/roadmap.ts`
- Modify: `test/render.spec.ts`

**Interfaces:**
- Consumes: `ProjectState`, `renderProjectFrontmatter`, `MANAGED_NOTICE`.
- Produces: `renderBrief(state: ProjectState): string`, `renderDiscovery(state: ProjectState): string`, `renderRoadmap(state: ProjectState): string`.

- [ ] **Step 1: Write failing renderer tests**

Add imports for the three renderers and tests that assert:

```ts
const state = sampleState();
expect(renderBrief(state)).toContain("# Brief — Agency");
expect(renderBrief(state)).toContain("Launch the agency");
expect(renderBrief(state)).toContain("Launch — Go live");

expect(renderDiscovery(state)).toContain("# Discovery — Agency");
expect(renderDiscovery(state)).toContain("[[DECISIONS/DEC-ARCH0001|Canonical architecture]]");
expect(renderDiscovery(state)).toContain("Publish offer");

expect(renderRoadmap(state)).toContain("# Roadmap — Agency");
expect(renderRoadmap(state)).toContain("Launch — Go live");
expect(renderRoadmap(state)).toContain("Get approval — Waiting for client");
```

Also add a sparse state test:

```ts
const sparse = emptyProjectState("PRJ-0003", "Agence Growth externalisé", "agence-growth-externalise", "Étudier et valider une agence Growth externalisée");
expect(renderBrief(sparse)).toContain("Success criteria have not been formalized yet.");
expect(renderDiscovery(sparse)).toContain("No research has been captured yet.");
expect(renderRoadmap(sparse)).toContain("No roadmap phase has been defined yet.");
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- test/render.spec.ts`
Expected: FAIL because the three renderer modules do not exist yet.

- [ ] **Step 3: Implement `renderBrief`**

Use deterministic project frontmatter with `note_id: BRIEF` and `note_type: brief`. Render objective, current phase/scope, durable constraints, and deliverables as success signals. When there are no deliverables, render exactly `Success criteria have not been formalized yet.`

- [ ] **Step 4: Implement `renderDiscovery`**

Use frontmatter `DISCOVERY` / `discovery`. Render current understanding from the objective, research as Obsidian links `[[RESEARCH/<id>|<title>]]`, accepted decisions as `[[DECISIONS/<id>|<title>]]`, blocked task reasons as unresolved issues, and current phase next actions as what to explore next. Render exactly `No research has been captured yet.` when research is empty.

- [ ] **Step 5: Implement `renderRoadmap`**

Use frontmatter `ROADMAP` / `roadmap`. Render current phase title/objective, active work, blockers, phase next actions, completed tasks, and deliverables. Render exactly `No roadmap phase has been defined yet.` when no current phase exists.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- test/render.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/render/brief.ts src/render/discovery.ts src/render/roadmap.ts test/render.spec.ts
git commit -m "feat: add human project narrative views"
```

---

### Task 2: Materialize and promote the human views

**Files:**
- Modify: `src/dropbox/layout.ts`
- Modify: `src/dropbox/repository.ts`
- Modify: `src/render/project.ts`
- Modify: `test/dropbox-repository.spec.ts`
- Modify: `test/render.spec.ts`

**Interfaces:**
- Consumes: renderers from Task 1.
- Produces: `workspaceProjectFile(..., "BRIEF.md" | "DISCOVERY.md" | "ROADMAP.md")` support and materialized files in every workspace.

- [ ] **Step 1: Write failing workspace tests**

In `test/dropbox-repository.spec.ts`, extend the shadow-mode test with:

```ts
expect(transport.files.has("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0001-agency/BRIEF.md")).toBe(true);
expect(transport.files.has("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0001-agency/DISCOVERY.md")).toBe(true);
expect(transport.files.has("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0001-agency/ROADMAP.md")).toBe(true);
```

Add a receipt-safety case where `transport.failOnceOn = "/BRIEF.md"` and assert the receipt is absent after failure.

In `test/render.spec.ts`, assert `renderProject(state)` contains:

```ts
expect(renderProject(state)).toContain("[[BRIEF|Brief]]");
expect(renderProject(state)).toContain("[[DISCOVERY|Discovery]]");
expect(renderProject(state)).toContain("[[ROADMAP|Roadmap]]");
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- test/render.spec.ts test/dropbox-repository.spec.ts`
Expected: FAIL because the workspace path union and repository writes do not include the new views.

- [ ] **Step 3: Extend workspace filenames**

Change `workspaceProjectFile` filename union to:

```ts
"PROJECT.md" | "STATE.md" | "PLAN.md" | "HANDOFF.md" | "BRIEF.md" | "DISCOVERY.md" | "ROADMAP.md"
```

- [ ] **Step 4: Materialize new views**

Import the three renderers in `src/dropbox/repository.ts` and add these writes inside `writeHumanViews`, before receipt publication:

```ts
await this.transport.upload(workspaceProjectFile(state.project_id, state.slug, "BRIEF.md"), renderBrief(state), "overwrite");
await this.transport.upload(workspaceProjectFile(state.project_id, state.slug, "DISCOVERY.md"), renderDiscovery(state), "overwrite");
await this.transport.upload(workspaceProjectFile(state.project_id, state.slug, "ROADMAP.md"), renderRoadmap(state), "overwrite");
```

- [ ] **Step 5: Promote human navigation in PROJECT.md**

Add a `## Start here` section near the top with:

```md
- [[BRIEF|Brief]] — what this project is and what success means.
- [[DISCOVERY|Discovery]] — what we know, learned and still need to explore.
- [[ROADMAP|Roadmap]] — what is happening now and what comes next.
```

Retain current objective, aliases, constraints, frontmatter, and machine-managed notice.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- test/render.spec.ts test/dropbox-repository.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/dropbox/layout.ts src/dropbox/repository.ts src/render/project.ts test/dropbox-repository.spec.ts test/render.spec.ts
git commit -m "feat: materialize human workspace views"
```

---

### Task 3: Full verification and validation readiness

**Files:**
- No required code changes unless verification exposes a defect.

**Interfaces:**
- Consumes: completed Tasks 1-2.
- Produces: a branch ready for review/deployment and later PRJ-0003 validation.

- [ ] **Step 1: Run the complete repository check**

Run: `npm run check`
Expected: Wrangler types succeed, TypeScript typecheck passes, and all Vitest tests pass.

- [ ] **Step 2: Inspect the diff for safety boundaries**

Confirm the diff does not touch:

```text
src/domain/transaction.ts
src/domain/project-state.ts
src/domain/transitions.ts
src/durable/
src/webhook/
```

Confirm no secrets or credentials appear in added content.

- [ ] **Step 3: Verify sparse output behavior**

Use the sparse renderer test matching PRJ-0003 revision 1 to confirm the generated views are useful when there is only a project objective and no research/tasks/phase yet.

- [ ] **Step 4: Commit any verification-only fixes**

If verification required a correction, commit only the minimal fix with a descriptive message. Otherwise make no extra commit.

- [ ] **Step 5: Record branch head SHA for deployment/validation handoff**

Capture the final branch commit SHA. After deployment and successful PRJ-0003 materialization, record that exact SHA and validation outcome canonically in PRJ-0002.
