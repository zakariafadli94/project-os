# IMP-ARTIFACT001 — Managed Document & Artifact Governance Design

## Status

Approved in chat on 2026-08-24 after two audit rounds. This package supersedes the narrower “stale artifact overwrite” framing. It builds a managed-document lifecycle for human/AI collaboration while preserving Project OS canonical-state, projection, recovery, and zero-extra-user-complexity guarantees.

## Goal

Make Project OS safe and practical for R&D document work where ChatGPT and humans can both create, revise, review, publish, classify, and reuse files in Dropbox/Obsidian without silent overwrite, accidental pollution of published deliverables, or loss of human edits.

The visible workspace must stay simple and clean. Version graphs, recovery copies, provider revisions, intents, and conflict evidence remain machine-managed under `.project-os`.

## Core distinction: system views are not artifacts

Project OS must distinguish two classes of human-visible files.

### System projection views

Examples:

- `BRIEF.md`
- `DISCOVERY.md`
- `ROADMAP.md`
- `PROJECT.md`
- `STATE.md`
- `PLAN.md`
- `HANDOFF.md`
- generated entity notes under `TASKS/`, `DECISIONS/`, `RESEARCH/`, `CONSTRAINTS/`, and canonical deliverable metadata notes

These are rebuildable projections of canonical Project OS state. They are readable in Obsidian but are not collaborative source documents.

If a system projection is modified externally, Project OS must preserve the unexpected bytes as recovery evidence under a hidden machine path and restore/regenerate the canonical projection. External edits must never become canonical project state implicitly.

### Managed documents and artifacts

These are real files used as sources, drafts, review candidates, or published outputs. They may be Markdown or arbitrary Dropbox files such as PDF, DOCX, XLSX, PPTX, CSV, images, or other supported project documents.

Managed documents have their own immutable version ledger separate from canonical project revision history.

## Visible workspace zones

Each active project workspace supports the following managed-document zones.

```text
PROJECT/
├── INPUTS/
├── REFERENCES/
│   └── UNCLASSIFIED/
├── WORKING/
├── REVIEW/
├── DELIVERABLES/
└── ARCHIVES/
```

Existing system-view/entity folders remain unchanged.

### `INPUTS/`

Purpose: zero-friction user drop zone.

The user may place source files here through Dropbox Desktop, Dropbox web, or another authorized Dropbox client. Project OS does not treat these files as final project organization.

Default deterministic ingestion behavior:

1. detect the new file through Dropbox change tracking;
2. preserve provider metadata and create managed-document/version evidence;
3. move the file to `REFERENCES/UNCLASSIFIED/` unless an explicit managed-document request already classifies it differently;
4. leave `INPUTS/` clean after successful ingestion.

The runtime must not guess a semantic category from a filename alone. ChatGPT may later classify the reference into a project-appropriate collection after inspecting it. This keeps the deterministic core free of model-dependent classification rules.

### `REFERENCES/`

Purpose: R&D sources and evidence.

References are physically organized into human-readable collections rather than a flat folder. Collection paths are project-specific, for example:

```text
REFERENCES/
├── CLIENT/
├── MARKET/
├── COMPETITORS/
├── CUSTOMERS/
├── TECHNICAL/
└── UNCLASSIFIED/
```

These names are examples, not hardcoded universal categories. Project OS validates safe collection paths but lets the project/ChatGPT choose the taxonomy.

A reference may later be reclassified by moving its visible file while retaining the same logical document identity and immutable version history.

External edits to an existing reference are preserved as a new external version rather than silently overwritten. References remain sources, not published deliverables.

### `WORKING/`

Purpose: active human + AI co-authoring.

A long-lived document such as `strategie-commerciale.md` remains one visible file while Project OS records a sequence of immutable versions behind it.

Typical lifecycle:

```text
V1 outline
V2 section 1
V3 section 2
V4 human edit in Obsidian
V5 ChatGPT continues from V4
...
```

External changes in `WORKING/` are legitimate. Project OS captures them as new versions with `source=external_human` and advances the working pointer.

AI writes must carry an invisible expected base-version token when available. If the working head changed since the content was prepared, the write fails as stale rather than overwriting the newer version.

### `REVIEW/`

Purpose: pre-publication candidate.

Moving a document from `WORKING` to `REVIEW` means construction is considered substantially complete and the focus changes to QA, consistency, evidence, formatting, and final corrections.

Edits in `REVIEW/` remain legitimate and create new candidate versions. They do not publish automatically.

`REVIEW` is not itself final approval. Final approval is the publish action that advances the published pointer and materializes the approved bytes into `DELIVERABLES/`.

### `DELIVERABLES/`

Purpose: clean published outputs only.

A published deliverable is frozen. Future work happens in `WORKING` or `REVIEW`, never by intentionally mutating the published file in place.

If a user nevertheless edits a published deliverable in Obsidian/Dropbox:

1. Project OS detects that the provider revision no longer matches the published evidence;
2. it preserves the human-edited bytes as a new external version;
3. if the corresponding working path is free, it moves the edited file into `WORKING/` as the next draft;
4. if a different working draft already exists, it stores the external edit in hidden recovery/conflict evidence and marks the document as requiring reconciliation rather than overwriting the working draft;
5. it restores/materializes the last approved published version back into `DELIVERABLES/`;
6. the published pointer itself never advances because of a direct external edit.

Thus `DELIVERABLES/` stays clean while human edits are never discarded.

### `ARCHIVES/`

Purpose: human-facing archives where existing project governance already requires them. It is not the canonical version ledger. Canonical managed-document history is hidden under `.project-os`.

## Logical document identity

Visible path is not identity.

Each managed document receives a stable `document_id`. Reclassification, promotion, review, publication, reopening, or visible-path movement does not create a new logical document unless explicitly requested.

Work-product documents keep independent lifecycle pointers:

- `working_version_id` — optional;
- `review_version_id` — optional;
- `published_version_id` — optional.

Reference documents keep a current reference pointer and collection path.

This supports a published V18 while a new V19+ draft exists simultaneously in `WORKING`.

## Immutable version records

Every accepted content change creates an immutable `DocumentVersionRecord` containing at least:

- `schema_version`;
- `project_id`;
- `document_id`;
- `version_id`;
- `parent_version_id` when applicable;
- logical document kind (`reference` or `work_product`);
- lifecycle stage (`reference`, `working`, `review`, `published`, or recovered external edit);
- visible logical path at creation time;
- source (`project_os`, `external_human`, `input_ingest`, `legacy_artifact_api`);
- request ID when generated through Project OS;
- creation timestamp;
- immutable payload path;
- byte size when known;
- MIME/media type when known;
- canonical SHA-256 when Project OS has the bytes directly;
- provider content hash when supplied by Dropbox;
- provider file ID/revision/path when known;
- previous logical version pointer.

Version records are immutable and replay-safe.

## Immutable payload store

The ledger must not depend on Dropbox’s account-level revision-retention window as the permanent R&D history.

Each version therefore references an immutable payload stored under the project’s hidden machine namespace.

For Project-OS-generated text content, content-addressed SHA-256 payloads are used so exact duplicate bytes can be reused.

For arbitrary externally supplied/binary Dropbox files, Project OS may use a server-side immutable copy plus provider content hash without downloading the entire file into Worker memory. The record format must support both a canonical SHA-256 and a provider fingerprint so `IMP-PERSIST001` can later generalize the provider boundary.

No package requirement depends on Dropbox retaining old native revisions indefinitely.

## Mutable document head/checkpoint

A small repairable document head maps the logical document to its current lifecycle pointers and provider observations.

The head is an optimization/checkpoint, not the only historical truth. It can be rebuilt from immutable version records.

The head includes at least:

- `document_id`;
- `project_id`;
- document kind;
- current visible paths;
- current working/review/published/reference version IDs as applicable;
- last known Dropbox file IDs/revisions/content hashes for materialized visible copies;
- conflict/reconciliation status when an external edit cannot be promoted automatically.

## Optimistic concurrency and provider CAS

Project OS must protect two different stale-write windows.

### Logical base-version check

AI/Project OS writes may include `expected_version_id`. If supplied, it must match the current lifecycle head for the target stage before the write proceeds.

This prevents an old chat or stale plan from writing content based on V5 when the document has already advanced to V7.

The token is machine context. The user is never asked to type version IDs.

Legacy artifact requests without this token remain supported for compatibility, but they do not receive the full old-chat stale-planning guarantee.

### Dropbox revision compare-and-swap

The Dropbox transport gains a provider-neutral conditional-write shape implemented with Dropbox `WriteMode.update(rev)`. A replacement succeeds only when the latest known Dropbox `rev` still matches on the server.

If the provider rev changed between read/planning and upload, the operation fails closed and the changed provider file is reconciled as an external edit before any retry.

Plain `overwrite` must no longer be used for managed collaborative-document replacement.

## Change detection

Dropbox folder cursors are used as an incremental change feed.

Project OS keeps a hot cursor for the active workspace tree and processes additions/modifications/deletions after Dropbox webhook notifications and scheduled reconciliation. Cursors are acceleration state and may be rebuilt.

The change feed must:

- filter machine-generated/self-observed writes by matching recorded provider revision/content evidence;
- detect external changes under `INPUTS`, `REFERENCES`, `WORKING`, `REVIEW`, and `DELIVERABLES`;
- detect external modifications of managed system projection files and send them to the projection-repair path;
- ignore irrelevant workspace paths safely;
- handle cursor reset/expiry with a bounded full rescan and baseline rebuild;
- remain project-isolated.

## Crash-safe operation sequence

A managed Project OS write follows a recoverable sequence:

1. validate request/project/path/lifecycle transition;
2. resolve logical document and current head;
3. enforce expected base version when provided;
4. create/reuse immutable desired payload;
5. persist durable intent/request evidence;
6. obtain latest provider metadata for the visible path;
7. reconcile unexpected provider changes before proceeding;
8. perform conditional provider write (`update(rev)`) or strict add;
9. verify returned/provider metadata;
10. write immutable version record;
11. advance repairable document head;
12. write committed artifact/document receipt.

A crash after the visible provider write but before version/head/receipt publication must be recoverable on exact replay by matching request ID, intended content evidence, provider metadata, and immutable payload. No duplicate logical version or data loss is allowed.

## Lifecycle operations

The existing `POST /v1/artifacts` API remains compatible.

A new managed-document lifecycle API may be introduced for explicit operations while keeping user-facing chat natural:

- create/update working content;
- promote working -> review;
- publish review -> deliverables;
- reopen published -> working;
- classify/reclassify a reference collection;
- inspect current document status/version tokens.

The user never needs technical commands. ChatGPT translates natural-language intent into these internal operations.

### Legacy direct artifact writes

Existing artifact requests and governed routes must continue to work.

When a legacy governed route resolves directly into `DELIVERABLES`, Project OS treats the write as a legacy direct publication and still records immutable document/version evidence. This preserves old/current chats without forcing a migration ceremony.

New workflows should prefer `WORKING -> REVIEW -> publish`.

## Publication semantics

Publication never mutates an old version record.

Publishing a review candidate:

1. verifies the review head is current;
2. records a new published version or promotes the exact review payload as the published version according to deterministic version rules;
3. advances `published_version_id` only after durable immutable evidence exists;
4. materializes the published payload into `DELIVERABLES/`;
5. records provider revision/content evidence;
6. leaves older published versions queryable in the ledger.

Reopening a published document creates/updates a working pointer based on the published version without changing the published pointer.

## Human modification rules by zone

| Zone / surface | External human modification policy |
|---|---|
| system projection views | preserve hidden recovery evidence, restore canonical projection |
| `INPUTS` | ingest and move to `REFERENCES/UNCLASSIFIED` by default |
| `REFERENCES` | capture as new reference version, keep as current reference |
| `WORKING` | capture as new legitimate working version |
| `REVIEW` | capture as new legitimate review candidate |
| `DELIVERABLES` | preserve edit as draft/conflict, restore last published version, never auto-publish |

## Reference organization

`REFERENCES` must never be a permanent flat thousand-file directory.

Physical collection paths are first-class metadata on reference heads. They may be multi-level but must pass safe-path validation and a bounded depth/length policy.

`UNCLASSIFIED` is a temporary deterministic fallback, not the final target taxonomy.

Project OS does not hardcode a universal taxonomy because sales, software, legal, research, and other projects require different human organization. ChatGPT chooses/revises collection paths from project context.

`IMP-INDEX001` later adds cross-cutting structured/full-text indexing and tags so one physical reference can be discoverable through multiple concepts without duplicating it across folders.

## Duplicate handling

Exact duplicate reference/input bytes should not create duplicate logical content when provider/canonical content evidence proves equality.

At minimum:

- same path + same provider/content fingerprint => idempotent;
- repeated input identical to an existing managed reference may be consumed as a duplicate observation;
- different bytes at the same logical reference path become a new version, not a silently renamed independent source;
- deduplication never crosses client/project isolation boundaries by default.

## Binary and large-file posture

The managed-document ledger is format-agnostic.

This package must support external arbitrary Dropbox files without decoding them as UTF-8 by using metadata and server-side copy for immutable snapshots whenever possible.

The existing JSON artifact API may remain text-oriented for generated inline content. Building a general binary upload API, document conversion pipeline, OCR system, or content extraction engine is not required here.

ChatGPT can access managed Dropbox documents through the authorized Dropbox integration; `IMP-INDEX001` later improves indexed retrieval.

## Project-state relationship

Managed-document versions do not increment canonical project business revision merely because a draft file changes in `WORKING` or a reference is reclassified.

Project canonical state remains authoritative for project lifecycle/tasks/decisions/research metadata. Document ledger history is a separate durable history domain keyed to the same project ID.

When a document lifecycle change corresponds to an explicit domain decision/deliverable lifecycle event already represented in canonical project state, higher-level chat orchestration may also issue the appropriate typed project transaction. The document system itself must not silently invent project-state mutations.

## Security and isolation

- all machine document evidence lives under the bound project’s machine root;
- safe path validation prevents traversal and reserved-system-root bypass;
- managed operations cannot cross projects;
- provider file IDs/revisions are treated as opaque provider metadata;
- user edits are preserved before repair whenever possible;
- ambiguous/conflicting state fails closed rather than overwriting either side;
- no direct PC filesystem access is introduced.

## Performance principles

- use Dropbox `rev`, `content_hash`, file ID, and size metadata to avoid unnecessary downloads;
- use folder cursors/change feeds rather than recursive full scans on every maintenance cycle;
- use server-side move/copy for arbitrary files where byte transfer is unnecessary;
- write immutable evidence once;
- keep hot cursor/head caches reconstructible;
- bound reconciliation concurrency;
- avoid duplicating binary payloads when content fingerprints prove equality;
- defer full search/index performance to `IMP-INDEX001` and formal load budgets to `IMP-PERF001`.

## Observability hooks

Emit structured signals sufficient for later `IMP-OBSERVE001`, including:

- project/document/version/request IDs;
- lifecycle operation;
- old/new stage;
- expected/current logical version;
- provider old/new rev when available;
- external edit detected;
- input ingested/classified;
- publish/reopen event;
- duplicate/idempotent outcome;
- conflict reason;
- recovery/resume outcome;
- provider calls/retries where available.

Do not log document contents.

## Compatibility and migration

- current visible system view paths remain unchanged;
- existing artifact routes remain valid;
- existing `/v1/artifacts` requests remain accepted;
- existing files without ledger records are bootstrapped lazily on first managed write/reconcile rather than bulk rewritten;
- existing `DELIVERABLES` files may become baseline published versions when first adopted;
- no user/chat command migration is required;
- Obsidian continues to consume Dropbox-synchronized files normally;
- continuity mode remains `stable` in production.

## Acceptance criteria

The implementation must deterministically prove at least:

1. A working document can be built over many versions while remaining one visible file.
2. A human Obsidian/Dropbox edit in `WORKING` becomes a new external version and the next Project OS write can use it as the new base.
3. An AI write carrying an old `expected_version_id` fails without overwriting a newer human version.
4. Dropbox conditional update rejects a provider-revision race between metadata observation and upload.
5. A `REVIEW` candidate can be edited repeatedly without publishing.
6. Publication advances only after immutable version evidence exists and yields a clean `DELIVERABLES` file.
7. Reopening a published deliverable creates a working draft while leaving the published version unchanged.
8. Direct external modification of `DELIVERABLES` is captured, the published pointer does not advance, and the published file is restored; when safe, the edit appears as a working draft.
9. If a different working draft already exists, a direct deliverable edit is preserved as hidden conflict evidence and neither draft is silently overwritten.
10. External modification of a system projection is preserved as hidden recovery evidence and the canonical projection is restored.
11. New `INPUTS` files are ingested and leave `INPUTS` clean, defaulting to `REFERENCES/UNCLASSIFIED` until classified.
12. References can be reclassified into nested safe collection paths without changing logical document identity or losing version history.
13. Arbitrary external binary files can be version-captured via provider metadata/server-side immutable copy without UTF-8 decoding.
14. Exact request replay is idempotent and creates no duplicate logical version.
15. Crash after visible-file write but before head/receipt publication is recovered on replay without data loss.
16. Legacy artifact writes still work and gain version evidence.
17. Cross-project/path escape attempts fail closed.
18. Dropbox cursor reset/loss can rebuild the watch baseline without treating every Project OS-owned file as a new human edit.
19. Production user/chat workflow remains unchanged and no direct PC access is introduced.

## Roadmap relationship

This package remains roadmap item 9. It does not add a new package.

After `IMP-ARTIFACT001`, the approved product roadmap continues with schema/model/persistence/index/observability/security/performance/deployment/UX/maintenance work. `IMP-INDEX001` owns rich retrieval/index semantics; `IMP-PERSIST001` owns formal provider abstraction; `IMP-PERF001` owns measured scale budgets.
