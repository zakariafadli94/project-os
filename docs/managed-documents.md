# Project OS — Managed Documents

## Purpose

Managed documents are human-visible project files whose content may legitimately evolve outside canonical Project OS state. They are separate from generated canonical projections such as `STATE.md`, `HANDOFF.md`, `ROADMAP.md`, task notes, decision notes and research notes.

The normal user workflow stays natural-language. Users do not select versions, run sync commands or interact with the hidden ledger.

## Visible project zones

Each project may expose these folders lazily under:

```text
WORKSPACE/PROJECTS/<PRJ>-<slug>/
```

### `INPUTS/`

Temporary intake area for documents given to Project OS for analysis or R&D.

- Human may drop files here through Dropbox/Obsidian/Desktop sync.
- Project OS ingests new files and moves them to `REFERENCES/UNCLASSIFIED/` unless an explicit later classification is supplied.
- Duplicate provider fingerprints are reused only after the current reference head is revalidated.
- Arbitrary provider files are handled as opaque bytes; binary content is snapshotted server-side and is not decoded as UTF-8.

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

Human edits to a managed reference are captured as a new reference version rather than silently overwritten.

### `WORKING/`

Collaborative authoring area for documents built progressively by human + AI.

A strategy built section by section remains one visible file while Project OS records immutable versions behind it. Human edits in Obsidian become legitimate new working versions. A later AI write carrying an older `expected_version_id` is rejected as stale.

### `REVIEW/`

Pre-publication candidate area.

Moving a document to REVIEW does not publish it. Review edits create new review versions. Publication is a distinct explicit lifecycle operation.

### `DELIVERABLES/`

Published/approved versions only.

A published version is frozen logically. A new iteration starts by reopening it into `WORKING` while retaining the published pointer.

If a human edits a managed `DELIVERABLES` file directly, Project OS never treats that edit as an implicit publication. It preserves the human bytes, restores the last published bytes, and routes the human change to a safe working/conflict path without overwriting an existing draft.

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
├── reference-fingerprints/
└── provider-file-bindings/
```

Rules:

- version records are immutable;
- text payload identity uses Project OS SHA-256;
- provider `content_hash` is provider evidence and is not relabeled as SHA-256;
- exact immutable replays are idempotent;
- a mutable document head may advance only after its referenced immutable version exists;
- heads/indexes are reconstructible from durable version evidence.

## Concurrency model

Managed document writes use two independent protections.

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
review version already durable
  -> verify REVIEW and existing DELIVERABLE provider observations
  -> conditional Dropbox update of DELIVERABLES
  -> remove REVIEW visible file
  -> write immutable published version record
  -> advance document head
  -> publish request receipt
```

If Dropbox CAS succeeds and Project OS crashes before the version/head is written, exact replay may repair the operation only when the visible `DELIVERABLES` metadata matches the immutable REVIEW candidate evidence (content hash and size). Otherwise recovery fails closed as a conflict.

The same principle applies throughout the ledger: ambiguous/partial provider state is verified before an operation is considered committed.

## External change feed

Each `ProjectGuard` keeps only a hot Dropbox change cursor. Durable document truth remains in Dropbox ledger records.

Processing rules:

- cursor is advanced only after every observed change is reconciled;
- a crash replays the same page safely;
- an expired/reset cursor triggers a bounded fresh baseline scan;
- baseline adoption records existing managed files without classifying them as new human edits;
- archived projects do not reconcile into active workspaces.

## Lazy adoption / legacy compatibility

Existing projects are not bulk-rewritten.

When a pre-ledger file is first encountered:

- existing `DELIVERABLES` adopts as the initial published version;
- existing `WORKING` adopts as working;
- existing `REVIEW` adopts as review;
- existing `REFERENCES` adopts as reference;
- adoption preserves visible bytes and records provider metadata as baseline evidence.

The legacy artifact API remains supported. Its governed writes gain managed-document evidence without forcing existing callers to understand the new lifecycle.

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

## Operational invariants

- No direct PC/filesystem access is part of correctness.
- Dropbox Desktop/Obsidian are optional human interfaces over Dropbox files.
- `DELIVERABLES` edits never auto-publish.
- Generated projection edits never auto-become canonical facts.
- Human bytes are preserved before repair/restoration.
- Managed document history is isolated per project.
- Legacy files are adopted lazily, not bulk rewritten.
- Continuity mode remains `stable`; this package does not perform transparent deployment cutover.
