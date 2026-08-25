# Project OS — Managed Documents

## Purpose

Managed documents are human-visible project files whose content may legitimately evolve outside canonical Project OS state. They are separate from generated canonical projections such as `STATE.md`, `HANDOFF.md`, `ROADMAP.md`, task notes, decision notes and research notes.

The normal user workflow stays natural-language. Users do not select versions, run sync commands or interact with the hidden ledger.

## Visible project zones

Each project may expose these folders lazily under:

```text
WORKSPACE/PROJECTS/<PRJ>-<slug>/
```

Normal human filenames may contain spaces and Unicode characters. Project OS still rejects traversal, control characters, unsafe path segments and characters that are not portable through Dropbox Desktop / common desktop filesystems.

### `INPUTS/`

Temporary intake area for documents given to Project OS for analysis or R&D.

- Human may drop files here through Dropbox/Obsidian/Desktop sync.
- Project OS ingests new files and moves them to `REFERENCES/UNCLASSIFIED/` unless an explicit later classification is supplied.
- Duplicate provider fingerprints are reused only after the current reference head is revalidated.
- Arbitrary provider files are handled as opaque bytes; binary content is snapshotted server-side and is not decoded as UTF-8.
- Deleting an INPUT before ingestion is treated as a legitimate withdrawal.

### `REFERENCES/`

Durable source library used for R&D and retrieval.

```text
REFERENCES/
├── UNCLASSIFIED/
├── CLIENT/
├── MARKET/
├── COMPETITORS/
└── ... project-specific collections
```

Project OS does not invent semantic taxonomy during low-level ingestion. New material lands in `UNCLASSIFIED` and can later be classified into an explicit collection while retaining the same logical `document_id` and immutable history.

Human edits to a managed reference are captured as a new reference version rather than silently overwritten. Provider-file bindings preserve reference identity even when a Dropbox copy/move assigns a new provider file ID.

Current bounded limitation: Dropbox deleted-entry metadata does not reliably carry the prior file ID. Reference deletion is therefore not automatically reconstructed by path guesswork; Project OS fails conservative rather than risk binding a deleted reference to the wrong logical document.

### `WORKING/`

Collaborative authoring area for documents built progressively by human + AI.

A strategy built section by section remains one visible file while Project OS records immutable versions behind it. Human edits in Obsidian become legitimate new working versions. A later AI write carrying an older `expected_version_id` is rejected as stale.

If an active managed WORKING file is deleted externally, Project OS restores the same active immutable version rather than silently dropping the logical draft or creating a fake new version.

### `REVIEW/`

Pre-publication candidate area.

Moving a document to REVIEW does not publish it. Review edits create new review versions. Publication is a distinct explicit lifecycle operation.

If the active REVIEW file is deleted externally, Project OS restores the same review candidate from immutable evidence.

### `DELIVERABLES/`

Published/approved versions only.

A published version is frozen logically. A new iteration starts by reopening it into `WORKING` while retaining the published pointer.

If a human edits an **already managed** `DELIVERABLES` file directly, Project OS never treats that edit as an implicit publication. It preserves the human bytes, restores the last published bytes, and routes the human change to a safe working/conflict path without overwriting an existing draft.

If a published file is deleted externally, the frozen published version is restored from immutable payload evidence and its logical published pointer does not advance.

A previously unknown file appearing in `DELIVERABLES/**` is different: it is a strict final-zone mutation. Project OS requires durable governed provenance before a published bootstrap is allowed. Without that provenance, MutationGate preserves the bytes as an external mutation candidate and creates **no** published pointer.

Detailed final-zone/operator contract: `docs/mutation-gate.md`.

## Generated projections are different

Files such as:

```text
PROJECT.md
BRIEF.md
DISCOVERY.md
ROADMAP.md
STATE.md
PLAN.md
HANDOFF.md
TASKS/
DECISIONS/
CONSTRAINTS/
RESEARCH/
```

are generated or canonical-derived views. They are not collaborative managed documents.

If an unexpected external edit is detected on a generated projection, the edited bytes are preserved in hidden recovery evidence before projection remains fail-closed or restores canonical content. The external edit never becomes canonical state merely because it was made in Obsidian.

## Hidden durable ledger

Managed-document durable evidence lives outside the Obsidian workspace:

```text
.project-os/projects/<PRJ>/documents/
├── heads/
│   └── <DOC>.json
├── versions/
│   └── <DOC>/
│       └── <VER>.json
├── payloads/
│   ├── sha256/
│   │   └── <sha256>
│   └── provider/
│       └── <DOC>/<VER>/payload
├── requests/
│   └── <REQUEST>/
│       ├── intent.json
│       └── receipt.json
├── reference-fingerprints/
└── provider-file-bindings/
```

Rules:

- version records are immutable;
- text payload identity uses Project OS SHA-256;
- provider `content_hash` is provider evidence and is not relabeled as SHA-256;
- exact immutable replays are idempotent;
- a mutable document head may advance only after its referenced immutable version exists;
- heads/indexes are reconstructible from durable version evidence;
- head reconstruction follows the active causal tip and does not resurrect consumed WORKING/REVIEW stages after publication;
- provider observations are rebuilt from selected immutable versions when complete evidence exists;
- each accepted managed-document request writes an immutable durable intent before provider/business effect and an immutable receipt after completion.

The Durable Object SQLite tables are hot acceleration only. Loss of the local `document_requests` cache must not allow the same `request_id` to be rebound to a different document operation.

## Concurrency and idempotency model

Managed document writes use independent protections.

### Durable request identity

`request_id` is bound to the exact normalized managed-document payload through immutable external intent evidence before an effect is performed.

- exact replay may reuse the durable receipt;
- reuse of the same `request_id` with a different payload is rejected;
- losing local SQLite request rows does not remove this binding.

### Logical stale-context protection

When a caller knows the version it edited from, it supplies `expected_version_id`.

If the logical head changed, Project OS returns a stale-version conflict before touching visible content.

### Provider compare-and-swap

Dropbox writes that replace an existing managed file use the exact observed Dropbox `rev` as a conditional update precondition. A concurrent Dropbox/Obsidian change causes a provider CAS conflict rather than a blind overwrite.

Project OS serializes same-project operations through `ProjectGuard`, but provider CAS remains necessary because external actors can edit Dropbox independently.

## Crash recovery

Cross-file publication cannot be a single Dropbox transaction, so Project OS uses crash-reconcilable ordering rather than claiming false atomicity.

For a normal republish:

```text
immutable request intent
  -> review version already durable
  -> verify REVIEW and existing DELIVERABLE provider observations
  -> conditional Dropbox update of DELIVERABLES
  -> remove REVIEW visible file
  -> write immutable published version record
  -> advance document head
  -> write immutable request receipt
```

If Dropbox CAS succeeds and Project OS crashes before the version/head is written, exact replay may repair the operation only when the visible `DELIVERABLES` metadata matches the immutable REVIEW candidate evidence (content hash and size). Otherwise recovery fails closed as a conflict.

If `HEAD.json` is lost while immutable history and visible managed content remain, status/mutation paths rebuild the logical head from the active causal history before proceeding. Reconstruction fails closed on ambiguous multiple active tips.

The same principle applies throughout the ledger: ambiguous/partial provider state is verified before an operation is considered committed.

## External change feed

Each `ProjectGuard` keeps only a hot Dropbox change cursor. Durable document truth remains in Dropbox ledger records.

Processing rules:

- MutationGate classifies strict final-zone files **before** bootstrap/reconciliation and before cursor advancement;
- cursor is advanced only after every observed change is reconciled;
- a crash replays the same page safely;
- an expired/reset cursor triggers a bounded fresh baseline scan;
- baseline adoption may record collaborative legacy files without classifying them as new human edits;
- baseline/reset may bootstrap final published content only when durable governed provenance proves it;
- unknown `DELIVERABLES/**` files become external mutation candidates and are never implicitly published;
- durable provider-file bindings are honored during baseline rebuild so copied references do not become duplicate logical documents;
- archived projects do not reconcile into active workspaces.

## Lazy adoption / legacy compatibility

Existing projects are not bulk-rewritten.

When a pre-ledger file is first encountered:

- existing `WORKING` may adopt as working;
- existing `REVIEW` may adopt as review;
- existing `REFERENCES` may adopt as reference;
- existing `DELIVERABLES` does **not** adopt as published from path presence alone;
- a final `DELIVERABLES` file may bootstrap as published only when accepted legacy artifact/document evidence or another governed recovery proof explains the exact provider content;
- otherwise the final file is preserved as a MutationGate external candidate for explicit resolution;
- permitted adoption preserves visible bytes and records provider metadata as baseline evidence.

The legacy artifact API remains supported. Its governed writes gain managed-document evidence without forcing existing callers to understand the new lifecycle. A real pre-effect governed artifact intent can explain an interrupted legacy artifact write; an unknown baseline file cannot impersonate that intent.

## Internal API surface

ProjectGuard exposes internal managed-document operations through:

```text
POST /document
GET  /document-status?document_id=<DOC-...>
POST /reconcile-documents
```

The public authenticated worker route for lifecycle mutations is:

```text
POST /v1/documents
Authorization: Bearer <INGRESS_TOKEN>
```

`/document-status` returns compact logical state and intentionally omits file contents and provider-internal metadata.

Mutation candidate list/status/resolution routes are documented in `docs/mutation-gate.md`.

## Operational invariants

- No direct PC/filesystem access is part of correctness.
- Dropbox Desktop/Obsidian are optional human interfaces over Dropbox files.
- An already governed `DELIVERABLES` edit never auto-publishes a new version.
- An unknown `DELIVERABLES` file never becomes an initial published version from path presence alone.
- Generated projection edits never auto-become canonical facts.
- Human/external bytes are preserved before repair/restoration or candidate resolution.
- Managed document history and request identity are isolated per project.
- Collaborative legacy files may be adopted lazily; strict final files require governed provenance.
- Durable history/intent/receipt evidence survives loss of hot SQLite rows.
- Continuity mode remains `stable`; managed-document/MutationGate work does not perform transparent deployment cutover.
