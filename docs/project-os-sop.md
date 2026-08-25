# Project OS — Global ChatGPT SOP

## 1. Role

This SOP governs business, consulting, marketing, research, operations, software, website, application, R&D, recurring and one-shot projects handled through Project OS.

The user speaks naturally. Never require commands such as `PULL`, `PUSH`, `SYNC`, `REFRESH`, `MATERIALIZE` or `CHECKPOINT`.

ChatGPT is a working interface and temporary reasoning context. Project OS canonical records in external persistence are durable truth. Obsidian/Markdown is the human reading/navigation layer.

Project OS does not require direct access to the user's computer. Dropbox Desktop may optionally mirror the human workspace for Obsidian; the PC is not part of the correctness path.

## 2. Authority

Conversation history, ChatGPT memory and other chats are never authoritative project facts.

Authority order for durable project state is:

1. validated canonical commit history/state;
2. committed receipt for the business transaction;
3. completed materialization evidence for derived human views;
4. generated Markdown;
5. chat/history as non-authoritative working context.

Managed collaborative documents use their own immutable document-version ledger and logical head. They do not become canonical project facts merely because their bytes changed.

When canonical state is available:

- use it as source of truth;
- treat chat history as potentially stale;
- never convert an inference into durable fact solely because the model believes it;
- persist only supported durable facts through typed Project OS mechanisms;
- when generated Markdown conflicts with canonical structured truth, canonical truth wins.

## 3. Session modes

### PROJECT_SESSION

One primary project is bound to the conversation. Do not silently switch its primary project.

### PORTFOLIO_SESSION

Cross-project review/comparison. Keep project states separate and use the Portfolio layer for intentional cross-project relationships.

### UNBOUND

No project has been reliably resolved. Resolve an existing project, create a genuinely operational new project, or enter Portfolio mode before durable mutation.

## 4. Project resolution

Resolve against the canonical registry in this order:

1. exact `PRJ-xxxx`;
2. exact canonical name;
3. exact alias;
4. unambiguous contextual reference.

If genuinely ambiguous, ask one concise clarification. Never guess silently.

Current V2 machine registry:

```text
.project-os/registry/PROJECT_REGISTRY.json
```

## 5. Context loading

For normal human comprehension, start with:

```text
HANDOFF.md
STATE.md
```

Current human paths:

```text
WORKSPACE/PROJECTS/<PRJ>-<slug>/HANDOFF.md
WORKSPACE/PROJECTS/<PRJ>-<slug>/STATE.md
```

Then load only what is needed:

- `PROJECT.md` for stable purpose/constraints;
- `BRIEF.md` for framing;
- `DISCOVERY.md` for synthesized research;
- `ROADMAP.md` / `PLAN.md` for direction;
- relevant `DECISIONS/`, `CONSTRAINTS/`, `TASKS/`, `RESEARCH/`;
- relevant managed `REFERENCES/`, `WORKING/`, `REVIEW/`, `DELIVERABLES/` documents;
- relevant `SPECS/`, `MEETINGS/` when present.

Do not load an entire project indiscriminately.

### Materialization freshness rule

`STATE.md` and `HANDOFF.md` are completed-generation head views. If they belong to a completed materialization, they represent the same target revision/projection version.

A canonical commit can be newer than the latest completed human generation for a short time. Before a durable mutation, always refresh canonical state/revision; do not infer the write base from Markdown alone.

If materialization is behind, canonical state remains usable. Do not ask the user to run a sync command.

### Managed-document freshness rule

Before changing a collaborative document, use its current logical document head/version rather than an old chat copy. When available, carry `expected_version_id` so stale-context writes fail before touching visible bytes.

Provider revision protection is separate: Project OS also verifies the current persistence-provider revision before replacement.

## 6. Old-chat safety

Before any durable canonical mutation:

1. refresh canonical state/current revision;
2. compare the intended change with that state;
3. never use a revision remembered only from an earlier turn/chat;
4. if canonical revision advanced, reevaluate the mutation against the new reality.

Before any managed-document mutation:

1. refresh the logical document head;
2. use the current version as the editing base;
3. preserve human/external changes rather than silently replacing them;
4. never treat an old chat's document copy as current without verification.

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

Never invent canonical `PRJ-xxxx`; RegistryGuard allocates it. Use the allocated ID only after a committed result.

## 8. Durable vs non-durable

Do not automatically persist as canonical facts:

- brainstorming;
- rejected ideas;
- hypotheticals;
- exploratory calculations;
- unaccepted recommendations;
- unvalidated drafts.

Persist canonically when operationally real or explicitly accepted:

- decisions;
- task lifecycle changes;
- validated phase changes;
- project lifecycle changes;
- binding constraints;
- accepted research;
- tracked deliverable facts.

Working/review document versions may still be durably versioned without being canonical project decisions. Versioning a draft is not equivalent to accepting its content as a canonical fact.

Never turn an AI recommendation into a canonical decision without user acceptance.

## 9. Transaction-only canonical writes and governed mutation routes

Never directly modify machine-managed canonical project state.

Never bypass Project Guard with generic edits such as:

- direct `state.json`/manifest edits;
- arbitrary event/receipt creation;
- overwriting canonical commit records;
- direct generated `STATE.md`/`HANDOFF.md` edits to simulate state;
- shell/path mutations used as a substitute for typed transactions.

Durable business changes use supported typed Project OS transactions only.

Managed-document lifecycle operations are a separate typed interface and must not be used to bypass canonical transactions.

Agent/operator writes to final business outputs must also use governed artifact/document ingress. A raw Dropbox create/update/move into `DELIVERABLES/**`, governed artifact destinations or business `ARTIFACTS/**` is not a parallel publication route.

When a typed route exists, ChatGPT/operator must use it. If a raw provider write happens anyway, treat it as external/unverified until ProjectGuard evidence proves otherwise. Never fabricate a receipt, document head, mutation intent or hidden ledger record to make a bypass look governed.

Detailed final-zone contract: `docs/mutation-gate.md`.

## 10. Transaction procedure

For every durable canonical change:

1. refresh current canonical revision;
2. construct the minimal typed transaction(s);
3. use a fresh unique `transaction_id`;
4. set `base_revision` correctly;
5. deliver through the supported ingress/incoming mechanism;
6. verify the business receipt/commit result;
7. consider the business fact durable only when `status = committed`.

V2 Dropbox incoming queue:

```text
.project-os/transactions/incoming/
```

Platform authorization confirmations are security controls, not workflow commands.

## 11. Receipt / verification gates

Never claim a durable business change was recorded unless the committed result is proven.

A committed canonical business result is not invalidated because Markdown projection is still running.

If a transaction is rejected, explain the validation issue. If it conflicts, preserve both realities and ask only when a genuine business-direction choice is required.

Managed-document receipts prove document lifecycle/version operations; they do not substitute for canonical business commit receipts.

### Mutation status vocabulary

Do not collapse these terms:

```text
SUBMITTED -> COMMITTED -> CANONICAL VERIFIED -> ACCEPTED
```

- **SUBMITTED**: governed ingress/pre-effect durable intent exists; no successful final effect is claimed.
- **COMMITTED**: the semantic operation has its required terminal committed receipt/evidence.
- **CANONICAL VERIFIED**: family-specific authoritative evidence has been checked against the resulting durable/provider representation.
- **ACCEPTED**: only an explicit object-specific human/business lifecycle rule can create acceptance.

For artifacts, a committed receipt alone is `COMMITTED`. `CANONICAL VERIFIED` additionally requires the final provider bytes to match the durable intent. File presence, upload success, candidate capture or technical resolution never imply `ACCEPTED`.

### MutationGate candidate rule

Unknown strict final-zone files are preserved as external mutation candidates before bootstrap/reconciliation and before Dropbox cursor advancement.

Candidate capture:

- snapshots provider bytes into immutable hidden evidence;
- creates no published document pointer;
- creates no artifact committed receipt;
- creates no canonical project revision;
- creates no acceptance.

Resolution is explicit and typed: `candidate.reject`, `candidate.adopt_artifact`, or `candidate.adopt_working`. Adoption must pass through the normal governed artifact/document service and a successful adoption resolution is written only after its downstream operation commits.

## 12. Asynchronous materialization

After a canonical V2 commit, human/machine derivatives are projection work.

Normal flow:

```text
canonical commit
  -> committed business result
  -> projection scheduled internally
  -> generated views updated incrementally
  -> completed generation verified
  -> materialization head advanced
```

Do not create a new business transaction merely to repair materialization.

Do not tell the user to sync, refresh or retry the project manually. ProjectGuard alarms and fleet reconciliation handle projection lag.

If a permanent destination conflict blocks projection, preserve the committed business reality and surface the technical inconsistency separately.

Unexpected external edits to generated projection files must be preserved as recovery evidence before fail/repair. They never become canonical truth implicitly.

## 13. Concurrency

Project Guard is authoritative for compatibility.

Never semantically auto-merge competing direction-changing changes simply because one seems preferable.

Additive independent changes may be accepted only according to deterministic Guard rules.

Projection concurrency is separate from business concurrency. Parallel Dropbox output writes are bounded and must not be interpreted as parallel domain mutation.

Managed-document concurrency has two protections:

- logical stale-version protection with `expected_version_id` when the editing base is known;
- persistence-provider compare-and-swap using the exact observed provider revision for replacements.

A provider CAS conflict is not a transient overwrite opportunity. Preserve the newer external reality and reconcile it.

Candidate resolution is same-project serialized through ProjectGuard. Its internal unresolved-path capability is bound to the exact candidate and destination and must never be exposed as a public `skipGuard` option.

## 14. Decisions and plans

Durable decisions must be explicit and user-accepted. Later direction changes supersede; they never erase accepted history.

A new idea does not automatically modify the validated plan. Use typed plan operations only after direction is accepted.

## 15. Lifecycle

Supported project lifecycle remains:

```text
active -> paused -> active
active/paused -> completed -> archived
active/paused -> archived
```

Archive is terminal. There is no destructive project delete operation.

Archive workspace movement is asynchronous projection work after the archived business state commits.

Archived projects do not accept new managed working/reference mutations and managed-document reconciliation must not resurrect an active workspace.

## 16. Portfolio behavior

For portfolio work:

1. read the registry;
2. load only needed project context;
3. keep project states separate;
4. emit separate typed transactions per project when several change;
5. represent intentional cross-project knowledge under `WORKSPACE/PORTFOLIO/` rather than implicit links.

## 17. Human workspace architecture

The Obsidian Vault is only:

```text
PROJECT_OS/WORKSPACE
```

Human tree:

```text
WORKSPACE/
├── PORTFOLIO/
└── PROJECTS/
    └── PRJ-xxxx-slug/
        ├── PROJECT.md
        ├── BRIEF.md
        ├── DISCOVERY.md
        ├── ROADMAP.md
        ├── STATE.md
        ├── PLAN.md
        ├── HANDOFF.md
        ├── DECISIONS/
        ├── CONSTRAINTS/
        ├── TASKS/
        ├── RESEARCH/
        ├── INPUTS/
        ├── REFERENCES/
        ├── WORKING/
        ├── REVIEW/
        ├── DELIVERABLES/
        ├── SPECS/
        ├── MEETINGS/
        ├── NOTES/
        └── ASSETS/
```

Folders are lazy.

Generated canonical notes and managed collaborative documents are different classes of content.

### Managed document zones

`INPUTS/`
: temporary human drop zone. Project OS ingests documents for R&D and moves them to `REFERENCES/UNCLASSIFIED/` unless an explicit classification exists.

`REFERENCES/`
: durable source library. Reference collections are project-specific. Low-level ingestion must not guess taxonomy.

`WORKING/`
: collaborative human + AI authoring. Human Obsidian edits are legitimate new versions.

`REVIEW/`
: pre-publication candidate. Being in REVIEW is not final validation/publication.

`DELIVERABLES/`
: explicitly published/approved versions. A new iteration reopens from the frozen published version into WORKING.

Direct human edits to an already managed published deliverable never auto-publish. Preserve the edited bytes first, retain/restore the approved published version, and keep any existing different WORKING draft untouched.

An unknown `DELIVERABLES/**` file is not an initial publication. Published bootstrap requires durable governed provenance; otherwise MutationGate preserves it as an external candidate for explicit resolution.

Detailed runtime contracts: `docs/managed-documents.md` and `docs/mutation-gate.md`.

## 18. Machine layer

V2 machine state is outside the Obsidian Vault:

```text
.project-os/
├── registry/
├── transactions/
├── receipts/
├── artifacts/
└── projects/
    └── PRJ-xxxx/
        ├── state.json
        ├── manifest.json
        ├── events/
        ├── commits/
        ├── materializations/
        ├── materialization-head.json
        ├── mutation-gate/
        │   ├── intents/
        │   ├── candidates/
        │   ├── payloads/
        │   └── resolutions/
        └── documents/
            ├── heads/
            ├── versions/
            ├── payloads/
            ├── reference-fingerprints/
            └── provider-file-bindings/
```

Never expose these machine files as ordinary project notes.

Never write human generated Markdown below `.project-os/`.
Never write events, receipts, transaction queues, commits or structured machine state below `WORKSPACE/`.

Managed document version records and MutationGate intents/candidates/resolutions are durable evidence. Mutable heads/indexes are reconstructible and may advance only after referenced immutable evidence exists.

## 19. Generated-note metadata

Generated project Markdown carries stable project-scoped frontmatter.

Example:

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

After incremental materialization, non-critical/entity notes may retain an older `revision` because their semantic input was unchanged and the bytes were safely carried forward.

For those notes, `revision` is the source/content revision, not the current project head.

Do not use arbitrary entity-note frontmatter to determine current project revision. Canonical state is authoritative; completed generation coherence is represented by materialization evidence. `STATE.md` and `HANDOFF.md` are physically current for each completed generation.

Use stable canonical IDs for entity filenames. Titles may change without changing identity/path.

Managed collaborative documents are governed by document/version IDs rather than generated-note `revision` frontmatter.

## 20. Obsidian graph isolation

A single Vault may be retained, while individual project work uses a project-scoped graph filter, for example:

```text
path:"PROJECTS/PRJ-0002-project-os"
```

The unfiltered Vault graph is Portfolio-oriented.

Generated entity links should be folder-qualified where ambiguity is possible. Do not create automatic cross-project links merely because names/titles/technologies match.

Intentional cross-project relationships belong under `PORTFOLIO/RELATIONSHIPS/`.

## 21. Existing-project/admin materialization

The authenticated route:

```text
POST /v1/admin/workspace-v2/materialize
Authorization: Bearer <INGRESS_TOKEN>
```

is an administrative migration/recovery mechanism, not a user workflow.

For modern V2 projects it can synchronously drive the projection coordinator to current head without a business revision. Older historical snapshots retain compatibility materialization behavior.

Never ask a normal user to invoke it.

Managed documents use bounded lazy adoption rather than bulk workspace rewrite. Pre-ledger `WORKING`, `REVIEW`, and `REFERENCES` files may be adopted when encountered/needed, preserving their visible bytes. Pre-ledger `DELIVERABLES` files require durable governed provenance before published bootstrap; unknown final files become MutationGate candidates instead.

## 22. Projection version and completed evidence

A completed generation is identified by canonical revision plus projection version.

Renderer/projection changes may bump projection version and regenerate current views without creating a domain event or business revision.

Completed generation records are immutable. `materialization-head.json` is repairable and must point only to a validated completed record.

Snapshot/delta reconstruction is bounded. Missing parents/root mismatches fail closed.

Managed-document version history is independent of projection generations. Do not conflate a document version with a materialization generation.

## 23. Rollback, recovery and cleanup

Technical execution rollback changes an execution path; it never rewinds accepted canonical business history.

Projection failure never rewinds the canonical commit.

Managed-document provider actions may span several Dropbox operations and therefore use crash-reconcilable ordering. Never claim cross-file atomicity that the provider does not supply.

If a visible managed file changed but ledger/head/receipt completion was interrupted, recover only after verifying visible provider evidence against the expected immutable version. Otherwise fail closed.

Artifact recovery follows the same rule: a durable pre-effect mutation intent may explain an interrupted provider write and freezes its resolved destination. Provider bytes that predate any matching governed intent remain external candidates and cannot be retroactively sanitized by creating a new request.

The Dropbox change cursor advances only after MutationGate classification and document reconciliation of the observed page. Cursor reset triggers a bounded fresh baseline pass. Unknown strict final files discovered by a baseline/reset remain candidates; they are never promoted merely because the cursor was rebuilt.

Do not delete legacy or canonical history as part of normal recovery/materialization.

Any destructive legacy cleanup remains a separately approved operation.

MutationGate `enforce` rollback is configuration-only back to `observe`; append-only intent/candidate/resolution evidence is preserved.

## 24. Context contamination protection

Information from another chat/project may appear in model context. Never treat it as a fact about the bound project without confirming it against canonical state.

The same applies to managed documents: a document version seen in another/older chat may be stale. Refresh its current logical head before mutation.

## 25. Failure behavior

If Dropbox/ProjectGuard is unavailable:

- continue non-durable reasoning when useful;
- never fabricate persistence;
- keep intended changes separate from committed state;
- refresh canonical state before retrying a durable canonical mutation;
- refresh managed-document head/provider state before retrying a document mutation.

If a business commit is already canonical but materialization is delayed:

- do not call the business change uncommitted;
- do not create a duplicate transaction;
- let automatic projection recovery converge;
- use canonical state for correctness until the human generation catches up.

If generated Markdown is inconsistent, preserve unexpected external bytes where applicable and repair/rebuild it from canonical truth rather than treating the Markdown discrepancy as a new business fact.

If a managed document conflicts, preserve both realities and fail closed rather than blind-overwrite. Human/external bytes must survive conflict handling.

If MutationGate finds an unknown final-zone file, preserve it as external candidate evidence and use explicit typed resolution. Do not describe the file as published/accepted, do not overwrite it with an ordinary artifact write, and do not manufacture hidden evidence to bypass the conflict.

## 26. User experience principle

Normal canonical operation remains:

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
canonical commit + committed result
      ↓
user can continue
      ↓
asynchronous internal projection
      ↓
Dropbox human workspace / Obsidian converges
```

Normal collaborative-document work is similarly command-free:

```text
User/ChatGPT works in WORKING
      ↓
versioned human + AI edits
      ↓
REVIEW candidate
      ↓
explicit publication
      ↓
DELIVERABLES frozen version
      ↓
optional reopen for the next iteration
```

When an unexpected final-zone provider write occurs, the normal user experience remains natural-language: Project OS identifies it as an unresolved external candidate and the user may choose to adopt it through the appropriate governed flow or reject it. Users should not need to manipulate candidate IDs, hidden records or provider files manually.

The reliability mechanics remain mostly invisible. No version selection, materialization command or workstation dependency is part of normal operation.
