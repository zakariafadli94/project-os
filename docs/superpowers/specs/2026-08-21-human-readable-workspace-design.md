# Human-readable Project Workspace Design

## Goal

Implement DEC-HUMAN001 by making the normal Project OS workspace useful to a human reader first, without changing canonical state semantics or weakening recovery, receipts, revisions, events, or transaction safety.

## Scope

This first implementation is intentionally additive and low-risk. It introduces three generated root views for every project:

- `BRIEF.md` — why the project exists, its current scope/boundaries, and how success is currently represented.
- `DISCOVERY.md` — current understanding, accumulated research, accepted decisions, unresolved blockers, and useful next exploration.
- `ROADMAP.md` — current phase, current work, blockers, next actions, and completed work/deliverables.

The existing canonical/recovery views (`PROJECT.md`, `HANDOFF.md`, `STATE.md`, `PLAN.md`) remain available in this change so session recovery is not broken. Operational data remains authoritative under `.project-os`.

## Design choice

Generate the new human views entirely from the existing `ProjectState`. Do not add new transaction types or state fields in this slice. Where a concept is not yet explicitly captured (for example formal success criteria or open questions), the view says so instead of inventing content.

This keeps the change backward-compatible and lets every existing project benefit immediately.

## Human experience

### BRIEF

`BRIEF.md` answers:

1. What is this project trying to achieve?
2. What is the current scope or phase?
3. What durable constraints shape it?
4. What deliverables currently represent success?

Sparse projects remain readable: missing phases, constraints, or success criteria are stated plainly.

### DISCOVERY

`DISCOVERY.md` answers:

1. What do we currently understand about the project?
2. What research has been captured?
3. Which accepted decisions shape the direction?
4. What unresolved blockers exist?
5. What should we explore next?

Research and decisions link to their existing human-readable documents instead of duplicating their full bodies.

### ROADMAP

`ROADMAP.md` answers:

1. What phase are we in?
2. What is being worked on now?
3. What is blocked?
4. What comes next?
5. What has already been completed?

This view is derived from phases, tasks, next actions, and deliverables.

## Navigation

`PROJECT.md` remains compatible but becomes a clearer landing page by pointing readers first to `BRIEF`, `DISCOVERY`, and `ROADMAP`.

This change does not delete old generated files. Removing or relocating legacy human-visible operational views is a separate migration concern and should only happen after the new views prove sufficient for recovery and daily use.

## Implementation

- Add renderers: `src/render/brief.ts`, `src/render/discovery.ts`, `src/render/roadmap.ts`.
- Extend `workspaceProjectFile` to allow the three filenames.
- Materialize the three files from `ProjectRepository.writeHumanViews`.
- Update `renderProject` to promote the three human entry points.
- Add renderer and repository tests, including a sparse-project case matching PRJ-0003's current shape.

## Safety

No changes to:

- transaction schema;
- project state schema;
- transition semantics;
- revision/idempotency rules;
- event persistence;
- receipt-last semantics;
- RegistryGuard/ProjectGuard concurrency;
- webhook or authentication behavior.

A failure while writing any new human view must still prevent a committed receipt from being published, preserving existing receipt-last behavior.

## Validation

1. Run the full repository check suite.
2. Confirm the new views materialize in repository tests.
3. Validate sparse output using a project with only name/objective and no phase/research/tasks.
4. After deployment, rematerialize/trigger a safe project update and verify `BRIEF.md`, `DISCOVERY.md`, and `ROADMAP.md` appear in Obsidian for PRJ-0003.
5. Record the resulting Git commit and validation outcome canonically in PRJ-0002.
