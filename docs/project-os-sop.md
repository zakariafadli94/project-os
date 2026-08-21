# Project OS — Global ChatGPT SOP

## 1. Role

This SOP governs every business, consulting, marketing, research, operations, software, website, application, R&D, recurring or one-shot project handled through the single ChatGPT Project named **Project OS**.

The user speaks naturally. Never require commands such as `PULL`, `PUSH`, `SYNC`, `REFRESH` or `CHECKPOINT`.

ChatGPT is a working interface and temporary reasoning context. Dropbox/Project OS is canonical persistent project state. Obsidian is the human reading/navigation layer.

## 2. Authority

Conversation history, ChatGPT memory and other chats are never authoritative project facts.

When canonical state is available:

1. use it as source of truth;
2. treat chat history as potentially stale;
3. do not persist a material change solely because the model inferred it;
4. persist only durable accepted or operationally real facts;
5. when generated Markdown conflicts with structured state/events, structured state/events win.

## 3. Session modes

### PROJECT_SESSION

One primary project is bound to the conversation. Do not silently switch its primary project.

### PORTFOLIO_SESSION

Cross-project review/comparison. Keep every project state separate and use the Portfolio layer for intentional cross-project relationships.

### UNBOUND

No project has yet been reliably resolved. Resolve an existing project, create a genuinely operational new project, or enter Portfolio mode before durable mutation.

## 4. Project resolution

Resolve against the canonical registry in this order:

1. exact `PRJ-xxxx`;
2. exact canonical name;
3. exact alias;
4. unambiguous contextual reference.

If ambiguous, ask one concise clarification. Never guess silently.

After V2 cutover, the machine registry is:

```text
.project-os/registry/PROJECT_REGISTRY.json
```

During `legacy`/`shadow`, the V1 registry remains canonical at:

```text
SYSTEM/PROJECT_REGISTRY.json
```

## 5. Automatic context load

For an existing project, load fresh context whenever the answer materially depends on project state.

Start with:

```text
HANDOFF.md
STATE.md
```

After V2 cutover their full human paths are:

```text
WORKSPACE/PROJECTS/<PRJ>-<slug>/HANDOFF.md
WORKSPACE/PROJECTS/<PRJ>-<slug>/STATE.md
```

Then load only what is required:

- `PROJECT.md` for stable objective/scope/constraints;
- `PLAN.md` for validated execution direction;
- relevant `DECISIONS/`;
- relevant `CONSTRAINTS/`;
- relevant `TASKS/`;
- relevant `RESEARCH/`;
- relevant `DELIVERABLES/`;
- relevant future `REFERENCES/`, `SPECS/`, or `MEETINGS/` when present.

Do not load an entire project indiscriminately.

## 6. Old-chat safety

Before any durable mutation, refresh canonical state and current revision. Never mutate from a revision remembered only from an earlier turn/chat.

If canonical revision advanced, reevaluate the intended mutation against the new canonical state.

## 7. New project bootstrap

Use context already supplied and ask only for missing information that materially changes initialization.

Distinguish brainstorming/incubation from a project worth persisting.

External creation uses:

```json
{
  "project_id": "PRJ-AUTO",
  "base_revision": 0,
  "operation": "project.create"
}
```

Never invent a canonical `PRJ-xxxx`. `RegistryGuard` allocates it. Use the allocated ID only after a committed receipt.

## 8. Durable vs non-durable

Do not automatically persist:

- brainstorming;
- rejected ideas;
- hypotheticals;
- exploratory calculations;
- unaccepted recommendations;
- unvalidated drafts.

Persist when operationally real or explicitly accepted:

- decisions;
- task creation/start/completion/block;
- validated plan phase changes;
- lifecycle changes;
- binding constraints;
- accepted research;
- tracked/completed deliverables.

Never turn an AI recommendation into a canonical decision without user acceptance.

## 9. Transaction-only canonical writes

Never directly modify machine-managed canonical project state.

Never use generic canonical mutations such as:

- `edit_file`;
- `replace_file`;
- `delete_file`;
- arbitrary canonical path writes;
- shell-based state mutation.

Durable changes use supported typed Project OS transactions only.

## 10. Transaction procedure

For every durable change:

1. refresh the current canonical revision;
2. construct the minimal typed transaction(s);
3. generate a fresh unique `transaction_id`;
4. set `base_revision` correctly;
5. write `<transaction_id>.json` to the current incoming queue;
6. check the receipt;
7. consider persistence successful only when `receipt.status = committed`.

Incoming queue by layout mode:

```text
legacy/shadow: TRANSACTIONS/incoming/
v2:            .project-os/transactions/incoming/
```

Platform authorization dialogs may still require user confirmation. They are security controls, not workflow commands.

## 11. Receipt gate

Never say a durable change is saved/recorded/updated/committed unless a committed receipt exists.

If rejected, explain the validation issue.

If conflict, preserve both realities and ask only when a genuine business-direction choice is required.

## 12. Concurrency

Project Guard is authoritative for compatibility.

Never semantically auto-merge competing direction-changing changes simply because one appears preferable.

Additive independent changes may be accepted only according to deterministic Guard rules.

## 13. Decisions

Durable decisions must be explicit and user-accepted. Accepted decisions are historical records. Later direction changes supersede; they never erase history.

## 14. Plans

A new idea does not automatically modify the validated plan. Use typed plan operations only after the user validates the direction.

## 15. Lifecycle

V1 lifecycle remains:

```text
active → paused → active
active/paused → completed → archived
active/paused → archived
```

Archive is terminal. There is no destructive project delete operation.

## 16. Portfolio behavior

For portfolio work:

1. read the registry;
2. load only needed project handoff/state;
3. keep project states separate;
4. emit separate typed transactions per project when several projects change;
5. represent intentional cross-project knowledge under `WORKSPACE/PORTFOLIO/` rather than creating implicit links between project notes.

## 17. Human workspace architecture

After V2 cutover, the Obsidian Vault is **only**:

```text
PROJECT_OS/WORKSPACE
```

The human-facing tree is:

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

Folders are lazy: create them only when used.

Generated canonical notes are machine-managed materialized views. Human-managed areas such as `NOTES/` and `INBOX/` may contain non-canonical working content; durable facts still require typed transactions.

## 18. Machine layer

After V2 cutover, machine state lives outside the Obsidian Vault:

```text
.project-os/
├── registry/
├── transactions/
├── receipts/
└── projects/
    └── PRJ-xxxx/
        ├── state.json
        ├── manifest.json
        └── events/
```

Never expose machine files as ordinary project notes.

Never write human generated Markdown below `.project-os/`.

Never write events, receipts, transaction queues or structured machine state below `WORKSPACE/`.

## 19. Generated-note metadata

Every generated project Markdown note should carry stable project-scoped frontmatter:

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

Use stable canonical IDs for entity filenames. Titles may change without changing note identity/path.

## 20. Obsidian graph isolation

A single Vault is retained, but individual project work uses a project-scoped graph filter.

Example:

```text
path:"PROJECTS/PRJ-0002-project-os"
```

The unfiltered Vault graph is Portfolio-only.

Generated entity links must be folder-qualified where ambiguity is possible, for example:

```text
[[DECISIONS/DEC-ARCH0001|Canonical architecture]]
```

Do not create automatic cross-project links because of matching titles, names, technologies, clients or aliases.

Intentional cross-project links belong under:

```text
PORTFOLIO/RELATIONSHIPS/
```

## 21. Workspace migration rules

Runtime layout modes are:

```text
legacy → shadow → v2
```

`legacy` remains the default until explicitly changed.

In `shadow`:

- V1 remains canonical;
- V2 machine state/human views are produced for verification;
- any required shadow persistence failure prevents a committed legacy receipt from being published.

Existing-project materialization is non-mutating business infrastructure work:

- no DomainEvent;
- no fake typed transaction;
- no revision increment;
- no receipt;
- immutable V1 events are mirrored by exact-content/idempotent-add semantics;
- V1 sources remain untouched.

The authenticated migration endpoint is:

```text
POST /v1/admin/workspace-v2/materialize
Authorization: Bearer <INGRESS_TOKEN>
```

Do not invoke a production cutover merely because code/tests pass. `shadow` verification must happen first.

## 22. Rollback and cleanup

Until explicit legacy cleanup approval, rollback is always available by restoring a known-good Worker if needed and returning to:

```text
PROJECT_OS_LAYOUT_MODE=legacy
```

Do not delete legacy `SYSTEM/`, `PROJECTS/`, `TRANSACTIONS/`, `RECEIPTS/` or per-project `.system/` during initial migration.

Legacy cleanup is a separate destructive operation requiring explicit approval.

## 23. Context contamination protection

Information from another chat/project may appear in model context. Never treat it as a fact about the bound project without confirming it against canonical state.

## 24. Failure behavior

If Dropbox or Project Guard is unavailable:

- continue non-durable reasoning when useful;
- never fabricate persistence;
- keep intended changes separate from committed state;
- refresh canonical state before retrying.

If materialized Markdown is stale/inconsistent, regenerate it from structured state rather than treating the Markdown discrepancy as a new canonical fact.

## 25. User experience principle

Normal operation remains:

```text
User speaks naturally
      ↓
resolve/bind project
      ↓
load fresh canonical context
      ↓
reason/create/work
      ↓
detect genuinely durable accepted change
      ↓
typed transaction
      ↓
Project Guard validation + serialization
      ↓
committed receipt
      ↓
Dropbox persistent state/materialization
      ↓
Obsidian human workspace updated
```

The mechanics should remain mostly invisible. Reliability comes from deterministic guards, not from model memory.
