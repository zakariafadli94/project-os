# Project OS — Human Workspace Separation Design

Date: 2026-08-21
Status: Proposed for implementation after user review
Canonical project: PRJ-0002 — Project OS
Accepted architecture decision: DEC-WORKSPACE001

## 1. Problem

Project OS currently uses the Dropbox `PROJECT_OS/` root as both the machine persistence layer and the Obsidian Vault. This exposes `SYSTEM/`, `TRANSACTIONS/`, `RECEIPTS/` and per-project `.system/` data to the human workspace. It also causes Obsidian to index machine files and to show project notes in one mixed global graph.

The existing generated project tree is also too sparse for long-lived real projects because accepted research and deliverables are stored in structured state but are not materialized as rich Markdown notes.

The design goal is to preserve Project Guard's deterministic canonical state while making the Obsidian experience human-only, project-rich, graph-isolated, portable, and reconstructible from another computer or AI platform.

## 2. Chosen architecture

Split the Dropbox app folder into two explicit layers:

```text
PROJECT_OS/
├── WORKSPACE/                  # Human-facing; this is the Obsidian Vault
│   ├── PORTFOLIO/
│   └── PROJECTS/
└── .project-os/                # Machine-facing; outside the Vault
    ├── registry/
    ├── transactions/
    ├── receipts/
    └── projects/
```

Only `PROJECT_OS/WORKSPACE/` is opened in Obsidian.

### Human workspace

```text
WORKSPACE/
├── PORTFOLIO/
│   ├── DASHBOARD.md
│   ├── RELATIONSHIPS/
│   └── REVIEWS/
└── PROJECTS/
    └── PRJ-xxxx-slug/
        ├── PROJECT.md
        ├── STATE.md
        ├── PLAN.md
        ├── HANDOFF.md
        ├── DECISIONS/
        ├── CONSTRAINTS/
        ├── TASKS/
        ├── RESEARCH/
        ├── REFERENCES/
        ├── DELIVERABLES/
        ├── SPECS/
        ├── MEETINGS/
        ├── NOTES/
        ├── INBOX/
        └── ASSETS/
```

Folders are created lazily when they first contain something. Empty project hierarchies are not required.

### Machine layer

```text
.project-os/
├── registry/
│   ├── PROJECT_REGISTRY.json
│   └── PROJECT_INDEX.md-or-json
├── transactions/
│   ├── incoming/
│   ├── committed/
│   ├── rejected/
│   └── conflicts/
├── receipts/
└── projects/
    └── PRJ-xxxx/
        ├── manifest.json
        ├── state.json
        ├── events/
        └── snapshots/
```

The exact machine filenames may follow existing internal conventions, but they must remain outside `WORKSPACE/`.

## 3. Authority model

The split does not change canonical authority.

- Structured state, immutable events, registry state, revisions and receipts remain authoritative.
- Markdown under `WORKSPACE/` is a generated/materialized human view unless explicitly designated as human-authored content.
- Human edits inside machine-managed generated regions are not authoritative.
- `NOTES/`, `INBOX/`, selected `ASSETS/` metadata and future explicitly human-managed areas may contain non-canonical material.
- Durable facts still enter canonical state only through typed Project OS transactions.

## 4. Rich project note types

Project Guard must be able to materialize canonical entities as readable Markdown, not only store them in structured state.

Initial required generated types:

- decisions
- constraints
- tasks
- research
- deliverables

Planned extensible types:

- references
- specs
- meetings

Human-managed types:

- notes
- inbox
- assets or asset pointers

Generated notes use stable filenames based on canonical IDs, for example:

```text
DECISIONS/DEC-ARCH0001.md
RESEARCH/RES-CODE0001.md
DELIVERABLES/DEL-PORTPACK001.md
TASKS/TASK-PORTTEST001.md
```

This prevents title collisions across a project and keeps links stable if titles change.

## 5. Standard frontmatter

Every generated Markdown note in a project must include project-scoped metadata.

Minimum frontmatter:

```yaml
---
project_id: PRJ-0002
project_slug: project-os
project_name: Project OS
note_id: RES-CODE0001
note_type: research
canonical: true
revision: 19
---
```

Additional type-specific properties may be added, but these core fields remain stable.

The four root views `PROJECT.md`, `STATE.md`, `PLAN.md`, and `HANDOFF.md` also receive equivalent project metadata.

## 6. Obsidian graph isolation

A single Vault is retained, but project graphs are logically isolated.

Rules:

1. Every generated project note carries `project_id` frontmatter.
2. Project-local links must resolve to notes inside the same `PRJ-xxxx-slug` folder unless a cross-project relation is explicitly intended.
3. Cross-project links are not generated automatically from matching names, aliases, technologies or clients.
4. Intentional cross-project relationships are represented through `WORKSPACE/PORTFOLIO/RELATIONSHIPS/`.
5. Project graph views are filtered by project folder or `project_id` property.
6. The unfiltered Vault graph is treated as a Portfolio graph, not as a project graph.

The implementation should provide a documented Obsidian filter pattern for a project. Example path filter:

```text
path:"PROJECTS/PRJ-0002-project-os"
```

Property-based filtering can be used where supported by the installed Obsidian version.

## 7. Link strategy

Generated links should be path-safe and project-scoped.

Preferred link form inside a project:

```text
[[DECISIONS/DEC-ARCH0001|Canonical architecture]]
```

or an equivalent project-relative form that Obsidian resolves reliably.

Avoid bare links such as `[[PROJECT]]`, `[[STATE]]` or `[[DEC-ARCH0001]]` when they can become ambiguous across folders. Root-view links should be relative/path-qualified when necessary.

Portfolio links may explicitly address another project path.

## 8. Dropbox path abstraction

Application code must not scatter literal Dropbox paths.

`src/dropbox/paths.ts` remains the single source for path construction. It will define separate path families for:

- machine registry
- machine transactions
- machine receipts
- machine per-project state/events
- human workspace project views
- human portfolio views

No transaction payload may supply an arbitrary destination path.

## 9. Rendering architecture

Existing renderer modules remain focused by note type.

Add or extend renderers for:

- research
- deliverable
- constraint
- task
- standard frontmatter

Materialization should be centralized so a committed state transition regenerates the required human views consistently.

Rendering must remain deterministic: identical structured state produces identical Markdown apart from explicitly allowed timestamps if any.

## 10. Migration strategy

Migration must not be a manual Dropbox rearrangement.

### Phase A — Code compatibility

Deploy code capable of reading the existing V1 paths while writing the new layout in a controlled migration mode.

No destructive move occurs in this phase.

### Phase B — Shadow materialization

For each existing project, generate the new `WORKSPACE/PROJECTS/...` views from current structured state while leaving old V1 content intact.

Verify:

- project IDs and revisions match;
- decision counts match;
- research and deliverable structured entries are represented;
- generated root views match current canonical state;
- no receipt or event history is lost.

### Phase C — Machine-state relocation

Relocate/re-materialize machine-owned registry, transaction, receipt and per-project persistence under `.project-os/` using deterministic code or an explicit migration routine.

The migration must be idempotent and restartable.

### Phase D — Cutover

After verification:

- Worker reads/writes only the new machine paths;
- Obsidian Vault target changes to `PROJECT_OS/WORKSPACE/`;
- new project materialization uses only `WORKSPACE/PROJECTS/`;
- Portfolio views use `WORKSPACE/PORTFOLIO/`.

### Phase E — Legacy cleanup

Legacy V1 paths are removed only after a successful clean-room recovery test and explicit user approval. Until then, they remain available as rollback material.

## 11. Rollback requirements

Before cutover, rollback is simply disabling migration mode because legacy paths remain untouched.

After cutover but before legacy cleanup, rollback must be possible by deploying the previous known-good Worker version and restoring the prior path configuration.

No V1 machine history is deleted as part of the initial migration.

The migration must never create a committed receipt unless the corresponding canonical write and required registry update have succeeded.

## 12. Compatibility and revision safety

- Existing `PRJ-0001` and `PRJ-0002` identities remain unchanged.
- Existing project revision counters remain unchanged by pure view regeneration.
- A migration of storage layout is infrastructure work, not a fake business-state mutation.
- New durable business changes occurring during migration must still serialize through Project Guard.
- Migration routines must be idempotent and safe to retry after Worker interruption.
- Transaction idempotency semantics remain unchanged.

## 13. Tests required before deployment

New tests must be written before production code for the changed behavior.

At minimum:

1. project root views render standard frontmatter;
2. research entries render to `RESEARCH/<id>.md`;
3. deliverables render to `DELIVERABLES/<id>.md`;
4. tasks and constraints render to project-scoped folders if included in the first implementation increment;
5. generated links are project-relative/path-qualified and do not resolve across project folders accidentally;
6. machine path helpers never place registry, events, receipts or transactions under `WORKSPACE/`;
7. human path helpers never place rendered project content under `.project-os/`;
8. old V1 projects can be read during compatibility mode;
9. shadow materialization produces equivalent project state views;
10. migration can be run twice without duplicate/lost state;
11. interrupted migration can resume;
12. no committed receipt is emitted on partial persistence failure;
13. the existing full `npm run check` suite remains green.

## 14. Deployment and validation

Implementation should occur on an isolated feature branch and pass GitHub CI before production deployment.

Production validation sequence:

1. deploy compatibility/shadow mode;
2. verify health endpoint;
3. shadow-materialize PRJ-0001 and PRJ-0002;
4. compare views and structured state;
5. inspect `WORKSPACE/` locally in Dropbox;
6. open `WORKSPACE/` as an Obsidian Vault and validate navigation;
7. validate project graph isolation for both projects;
8. cut over machine paths;
9. create a new test project through the normal transaction flow;
10. run the clean-room portability test from a fresh session/platform;
11. retain legacy V1 paths until explicit cleanup approval.

## 15. Security

The migration must not copy secret values into Markdown or GitHub.

Documentation may contain secret names and regeneration/setup procedures only.

Machine files remain Dropbox-private and outside Obsidian indexing. This separation reduces accidental exposure through screenshots, exports, graph plugins or human browsing.

## 16. Portability requirement

A future operator or AI platform with access to the canonical Dropbox folder and GitHub repository must be able to:

1. identify all projects from the registry;
2. open `WORKSPACE/` and understand human project state;
3. find detailed research, decisions, tasks and deliverables without chat history;
4. locate the corresponding source-code components in GitHub;
5. reproduce the deployment using documented secret names and setup steps;
6. continue durable work using typed transactions and receipt gating.

No dependency on a specific ChatGPT conversation is allowed.

## 17. Alternatives considered

### One Vault per project

Provides perfect graph isolation but creates operational friction, weakens portfolio navigation and complicates cross-project review. Rejected as the default architecture.

### Keep the current root as the Vault and hide folders

Obsidian exclusions or CSS can reduce visual clutter, but machine and human concerns remain physically coupled and portability remains fragile. Rejected as insufficient separation.

### One human Vault plus separate machine subtree

Chosen. It preserves one control plane and one Portfolio view while creating a clean security and indexing boundary between human content and machine state.

## 18. Non-goals for the first implementation increment

The first increment does not need to implement every possible future project content type. It must establish the durable architecture, path split, frontmatter contract, graph isolation rules, and materialize the currently canonical rich types needed by real projects.

Additional specialized note types can be added later without changing the workspace/machine boundary.
