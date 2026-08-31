# Project OS — Managed Documents

## Purpose

Managed documents are human-visible project files whose content may legitimately evolve outside canonical Project OS state. They are separate from generated canonical projections such as `STATE.md`, `HANDOFF.md`, `ROADMAP.md`, task notes, decision notes and research notes.

The normal user workflow stays natural-language. Users do not select versions, run sync commands or interact with the hidden ledger.

## Visible project zones

Projection v2 eagerly exposes the managed-zone folder skeleton for every non-archived project under:

```text
WORKSPACE/PROJECTS/<PRJ>-<slug>/
```

The visible skeleton is:

```text
INPUTS/
REFERENCES/
REFERENCES/UNCLASSIFIED/
WORKING/
REVIEW/
DELIVERABLES/
```

This eager folder activation does **not** bulk-migrate or reinterpret historical content. Existing managed or legacy content is still adopted lazily and governed according to the rules below. No sentinel files, fake versions or implicit publications are created merely to expose the folders.

Normal human filenames may contain spaces and Unicode characters. Project OS still rejects traversal, control characters, unsafe path segments and characters that are not portable through Dropbox Desktop / common desktop filesystems.

### `INPUTS/`

Temporary active intake area for documents given to Project OS for analysis or R&D.

The operating invariant is:

> If a file is visible in `INPUTS/`, its source ingestion has not yet reached a verified terminal state.

- Human may drop files here through Dropbox/Obsidian/Desktop sync.
- Normal ingestion is trigger-first: a valid Dropbox webhook durably hands off provider-change work, then the Dropbox change feed identifies the actual changed paths.
- Project OS ingests ordinary files into `REFERENCES/UNCLASSIFIED/` unless machine-verifiable governed provenance supplies a structural route.
- A machine-verifiable cross-project referral is routed under `REFERENCES/REFERRALS/<source_project_id>/`; a referral-looking Markdown file without governed provenance remains ordinary `UNCLASSIFIED` evidence.
- Duplicate provider fingerprints are reused only after the current reference head and complete intake postcondition are revalidated.
- Arbitrary provider files are handled as opaque bytes; binary content is snapshotted server-side and is not decoded as UTF-8.
- Deleting an INPUT before governed capture completes is treated as a legitimate withdrawal and is not automatically resurrected.
- Successful technical ingestion removes the source file from `INPUTS/`, but it does **not** accept research, a decision, a task, a referral claim or any other canonical business fact.
- Empty input directories may remain. Current Dropbox deletion semantics are recursive, so Project OS does not perform a list-then-folder-delete cleanup that could remove a concurrently added human file.

Each input has a durable technical lifecycle:

```text
DETECTED
  -> SNAPSHOTTED
  -> REFERENCE_COMMITTED
  -> SOURCE_REMOVED
  -> COMPLETE
```

Terminal alternatives are:

```text
DUPLICATE_CLEANED
WITHDRAWN
CONFLICT
```

An intermediate version/head is never sufficient proof of completion. Replay verifies the whole file-level postcondition and safely converges missing effects. In particular, an already-proven reference plus a stale source copy resumes source cleanup rather than returning a generic `ignored` result. Divergent or ambiguous evidence fails closed as `CONFLICT` and preserves the source.

### `REFERENCES/`

Durable source library used for R&D and retrieval.

```text
REFERENCES/
├── UNCLASSIFIED/
├── REFERRALS/
│   └── <source_project_id>/
├── CLIENT/
├── MARKET/
├── COMPETITORS/
└── ... project-specific collections
```

Project OS does not invent semantic taxonomy during low-level ingestion. New ordinary material lands in `UNCLASSIFIED` and can later be classified into an explicit collection while retaining the same logical `document_id` and immutable history.

Structural `REFERRALS` routing is allowed only when source/target provenance is machine-verifiable through governed Project OS delivery evidence. Routing a referral is source capture, not acceptance of its recommendation.

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
OPERATING.md
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
├── intakes/
│   └── <INTAKE>.json
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
- each accepted managed-document request writes an immutable durable intent before provider/business effect and an immutable receipt after completion;
- each INPUT intake record tracks its technical source-ingestion phase independently from canonical business revision;
- a terminal intake state proves technical source handling only; it never implies business acceptance.

The Durable Object SQLite tables are hot coordination/acceleration state. The managed-document change-job store is intentionally durable SQLite state so a provider cursor may advance only after every relevant change on that page has an idempotent continuation job. Loss of the local `document_requests` cache must not allow the same `request_id` to be rebound to a different document operation.

## Visible logical document identity

Project-OS-authored Markdown work products expose their authoritative logical identity directly in YAML frontmatter:

```yaml
---
project_id: PRJ-0003
document_id: DOC-08B3524AC1CB4D6AE7079816
---
```

The hidden Managed Documents ledger remains authoritative. `document_id` identifies the logical document; it is not a task ID, decision ID, provider file ID or immutable version ID. Existing metadata such as `task_id` may coexist with it. A visible `project_id` or `document_id` that disagrees with the governed head is treated as an identity conflict and is never silently adopted. Reconciliation permits missing identity only for historical/pre-feature Markdown so deployment does not trigger a bulk rewrite.

For a Project-OS-authored Markdown write, ordering is deliberate: validate the caller-supplied SHA-256 against the caller bytes, resolve the authoritative logical identity, enrich the Markdown, compute SHA-256 of the enriched bytes, then store and materialize those exact enriched bytes. The immutable version record therefore hashes the same bytes that recovery can later replay. Non-Markdown content and managed REFERENCES remain byte-preserving.

WORKING → REVIEW → DELIVERABLES promotion does not change `document_id`; new immutable versions change `version_id`. Initial compatibility allocation may still derive a `DOC-...` value from `project_id + initial logical_path`, but after the head exists the stored `document_id` is authoritative. A future governed rename must mutate `logical_path` while preserving that identity; IMP-DOCIDENTITY001 does not introduce a rename API.

The legacy artifact API follows the same rule for governed Markdown routed to `DELIVERABLES/`: visible bytes and immutable payload evidence contain the authoritative identity. Historical documents are enriched lazily on a governed rewrite/republication rather than mass-rewritten during deployment. REVIEW active-head/supersession cleanup is a separate lifecycle concern.

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

### INPUTS crash recovery

INPUT ingestion is a multi-effect operation and is replayed from durable intake evidence:

- crash after `DETECTED`: preserve/reuse the deterministic intake and create the immutable source snapshot;
- crash after `SNAPSHOTTED`: reuse the snapshot and finish governed reference creation;
- crash after visible reference creation: verify/reuse the exact destination rather than duplicating it;
- crash after `REFERENCE_COMMITTED`: verify source identity/revision and remove the stale source;
- crash after source deletion but before the terminal marker: verify absence plus durable reference evidence and close the intake;
- if a newer source revision appears during cleanup, preserve it and surface `CONFLICT`.

The terminal invariant is the complete provider/ledger postcondition, not the existence of one intermediate record.

## External change feed and trigger handoff

Dropbox webhooks are the primary production trigger for provider changes. The webhook payload is only a notification that changes exist; Project OS resolves exact changes from the Dropbox change feed.

After signature verification, the production webhook synchronously awaits a durable notification handoff to `DropboxChangeGuard` before returning HTTP 200. Duplicate webhook notifications are coalesced into durable generations. A failed generation stays pending, records its failure and re-arms for retry.

Each `ProjectGuard` owns its managed-document cursor and durable per-change job store. Processing rules are:

- MutationGate classification remains the first semantic observer of every stored change;
- each fetched change-feed page is converted into deterministic per-change jobs;
- the page cursor advances only after all relevant page entries are durably registered as idempotent jobs;
- individual jobs may complete after cursor advancement because their continuation is already durable;
- a failed job remains pending and visible through `jobs_pending` / `job_failures`; it is not collapsed into generic `ignored`;
- replayed pages deduplicate already-registered jobs;
- an expired/reset cursor rebuilds a bounded baseline and atomically registers that page before replacing the old cursor;
- baseline adoption may record collaborative legacy files without classifying them as new human edits;
- baseline/reset may bootstrap final published content only when durable governed provenance proves it;
- unknown `DELIVERABLES/**` files become external mutation candidates and are never implicitly published;
- durable provider-file bindings are honored during baseline rebuild so copied references do not become duplicate logical documents;
- archived projects do not reconcile into active workspaces.

Scheduled maintenance still handles transaction/artifact inbox work and materialization reconciliation, but it does **not** invoke managed-document provider-root reconciliation as a hidden periodic INPUTS scanner. Provider-change ingestion correctness is trigger-first.

## Explicit historical INPUTS recovery

Historical stale `INPUTS/` content is repaired through an authenticated, explicitly scoped administrative operation. It is not a recurring correctness mechanism.

The public admin route is:

```text
POST /v1/admin/recover-inputs
Authorization: Bearer <INGRESS_TOKEN>
Content-Type: application/json

{"project_ids":["PRJ-0002","PRJ-0003"]}
```

Rules:

- `project_ids` must be a non-empty explicit list;
- every requested ID is validated against RegistryGuard before any selected project recovery begins;
- only selected projects are dispatched;
- each selected ProjectGuard recursively enumerates only its own `INPUTS/` root;
- discovered files use the same `InputIntakeService` as normal trigger-driven ingestion;
- already-proven partial intake converges missing safe cleanup;
- divergent/ambiguous evidence stays visible and reports `CONFLICT`;
- archived projects are not resurrected;
- the operation returns structured per-project counts for `scanned`, `completed`, `duplicate_cleaned`, `conflicts`, `withdrawn` and `failed`;
- the route is never called by scheduled maintenance.

A referral-looking historical Markdown file without governed referral provenance is ordinary `UNCLASSIFIED` evidence. Technical recovery does not create a task, decision, accepted research record or other canonical business fact.

## Eager zone skeleton / lazy content adoption / legacy compatibility

Existing project content is not bulk-rewritten. Projection v2 only ensures the empty managed-zone skeleton and exposes the current operating contract. Historical files remain in place unless a governed Managed Documents operation or explicit recovery rule adopts them.

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
POST /recover-inputs
```

The public authenticated worker route for lifecycle mutations is:

```text
POST /v1/documents
Authorization: Bearer <INGRESS_TOKEN>
```

The explicit historical recovery route is:

```text
POST /v1/admin/recover-inputs
Authorization: Bearer <INGRESS_TOKEN>
```

`/document-status` returns compact logical state and intentionally omits file contents and provider-internal metadata.

Mutation candidate list/status/resolution routes are documented in `docs/mutation-gate.md`.

## Operational invariants

- No direct PC/filesystem access is part of correctness.
- Dropbox Desktop/Obsidian are optional human interfaces over Dropbox files.
- The PV2 managed-zone skeleton is eager for non-archived projects; historical content adoption remains lazy.
- A visible INPUT file means its technical ingestion has not reached a verified terminal state.
- Normal INPUT ingestion is provider-triggered; periodic full-project INPUTS scanning is not a correctness path.
- Successful INPUT ingestion preserves immutable/governed reference evidence before deleting the active inbox copy.
- Technical source ingestion never implies canonical business acceptance.
- Harmless empty INPUTS directories may remain because current Dropbox folder deletion is recursively destructive rather than atomic empty-only cleanup.
- An already governed `DELIVERABLES` edit never auto-publishes a new version.
- An unknown `DELIVERABLES` file never becomes an initial published version from path presence alone.
- Generated projection edits never auto-become canonical facts.
- Human/external bytes are preserved before repair/restoration or candidate resolution.
- Managed document history and request identity are isolated per project.
- Collaborative legacy files may be adopted lazily; strict final files require governed provenance.
- Durable history/intent/receipt evidence survives loss of hot SQLite rows.
- Continuity mode remains `stable`; managed-document/MutationGate work does not perform transparent deployment cutover.

## Persistence boundary compatibility

Managed-document services and repositories consume the provider-neutral persistence runtime. Base reads/writes/list/move/delete operations are provider-independent, while conditional write, server-side copy, directory provisioning and incremental change feed are explicit capabilities. Dropbox-specific transport/errors/retry do not belong in managed-document Core code.

The durable schema remains exactly `1.0`. Existing provider observations still serialize Dropbox V1 fields (`file_id`, `rev`, `content_hash`, `size`), and provider-derived document/version identity remains unchanged. The compatibility seam converts neutral runtime metadata back to those historical values and fails closed when it cannot reproduce valid Dropbox V1 evidence.

`content_hash` in schema-1.0 records remains the Dropbox content-hash value; it is not renamed or reinterpreted as a generic SHA-256. Generalized durable provider kinds, revision/hash token structures, migrations/upcasters or alternate providers belong to IMP-SCHEMA001, not managed-document runtime refactoring.
