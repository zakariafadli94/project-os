# IMP-DOCIDENTITY001 — Managed Document Identity Visibility and Stable Rename Design

## Status

Design validated section-by-section with the user on 2026-08-30.

This specification records the accepted architecture for `IMP-DOCIDENTITY001`. It does **not** authorize runtime implementation, production deployment, historical backfill, or canonical task completion. Implementation requires a separately reviewed implementation plan and the normal TDD, CI, production-proof, and canonical-closure gates.

Baseline:

- Project OS canonical project: `PRJ-0002`
- Canonical revision at design start: `119`
- Task: `TASK-IMPDOCIDENTITY001`
- Source baseline: `main` at `003458c1dc11996f704c1f57b9f5bcda223de908`
- Field input: `PRJ-0002/INPUTS/REFERRAL-PRJ0003-DOCUMENT-IDENTITY-VISIBILITY-IMPROVEMENT-20260830.md`
- Source observation project: `PRJ-0003 — Agence Growth externalisé`

## 1. Problem

Project OS already assigns stable internal Managed Document identities (`document_id`) and immutable version identities (`version_id`), but the human Markdown files in `WORKING/`, `REVIEW/`, and `DELIVERABLES/` do not consistently expose `document_id`.

This makes the internal identity model invisible at the exact surface where users and operators work. A user can see a project ID, task ID, file name, or provider path without being able to identify the Managed Document logical identity represented by that file.

The existing work-product identity function also derives `document_id` from `project_id + logical_path`. That is adequate for initial creation but incorrectly makes the human path behave like identity after creation. The accepted direction is stronger: **a Managed Document keeps the same `document_id` when it is renamed**.

## 2. Goals

`IMP-DOCIDENTITY001` must:

1. make `project_id` and `document_id` visible and trustworthy in human Markdown Managed Documents;
2. keep `document_id` stable across `WORKING -> REVIEW -> DELIVERABLES`, reopen, version changes, and governed rename;
3. make `logical_path` mutable without making identity mutable;
4. prevent historical logical paths from being silently reassigned to another document;
5. make governed rename crash-safe and concurrency-safe across all active work-product representations;
6. detect forged or mismatched human-visible identities rather than silently accepting them;
7. remain compatible with legacy unstamped Managed Documents without mass rewriting history;
8. preserve immutable historical versions and current provider-neutral schema/compatibility rules;
9. preserve the natural-language user workflow and current Managed Document API compatibility except for the new rename operation.

## 3. Non-goals

This package does not:

- redesign reference-document identity;
- expose Dropbox `file_id` as business identity;
- put `version_id` into human Markdown frontmatter;
- automatically accept manual Dropbox/Obsidian renames as logical renames;
- rewrite all historical documents;
- recycle historical document paths for unrelated documents;
- redesign MutationGate, provider abstraction, or schema evolution;
- introduce vector search or indexing work owned by `IMP-INDEX001`;
- require direct local filesystem access.

The first implementation scope is **work products only**: `WORKING`, `REVIEW`, and `DELIVERABLES`.

## 4. Identity model

The identity model is:

| Field | Meaning | Mutability |
| --- | --- | --- |
| `project_id` | owning project | immutable |
| `document_id` | logical Managed Document identity | immutable |
| `logical_path` | current human logical path/name | mutable through governed rename |
| `version_id` | immutable observable document version | new value per version/change |
| `task_id`, `decision_id`, etc. | associated business entities | independent of document identity |
| provider `file_id` | provider object identity/evidence | provider-specific, never business identity |

### 4.1 Initial ID allocation

For compatibility, newly created work products **continue to use the existing deterministic initial allocation** based on:

```text
project_id + first logical_path
```

Once allocated, the ID is permanent. Later `logical_path` changes **must not recompute the document ID**.

Existing `document_id` values are never rewritten or reallocated.

### 4.2 Stable lifecycle identity

For one logical document:

```text
WORKING -> REVIEW -> DELIVERABLES
   ^                        |
   +-------- reopen --------+
```

all stages use the same `document_id`. New content or a rename creates new `version_id` values but never a new logical document identity.

## 5. Durable path claims

Project OS introduces an append-only logical path claim family for work products.

Conceptually:

```text
(project_id, normalized_logical_path) -> document_id
```

A committed path claim is immutable after creation.

Recommended record semantics:

```ts
interface ManagedDocumentPathClaim {
  schema_version: "1.0";
  project_id: string;
  normalized_logical_path: string;
  first_seen_logical_path: string;
  document_id: string;
  claimed_at: string;
  source: "initial_create" | "governed_rename" | "legacy_adoption";
}
```

The exact storage filename is an implementation detail, but lookup must be deterministic and bounded.

### 5.1 Path normalization

Claims use the same safe relative-path validation as Managed Documents plus provider-equivalent path comparison.

For Dropbox, equality must account for Dropbox path semantics, including case-insensitive collisions and Unicode normalization. The implementation must not rely on a naive ASCII-only lowercase transform as the sole collision guard. If the provider contract lacks a reusable path-equivalence helper, the implementation may add one at the provider compatibility boundary.

### 5.2 Claim invariants

- A normalized logical path can be permanently claimed by only one `document_id` for the lifetime of the project.
- Reclaiming the same path for the same `document_id` is idempotent.
- Claiming an already claimed path for another `document_id` fails closed.
- The current path is the `ManagedDocumentHead.logical_path`.
- Every prior committed claim for the same document is a historical alias/reservation.
- A historical alias may be used again only by the same document via governed rename.
- A historical alias is never silently reactivated by `working.write`; attempting to create/write through a non-current alias fails with a dedicated historical-path conflict and requires an explicit rename back.
- A rename request that fails before any provider effect must not create a permanent historical alias merely because it attempted a destination.

This prevents path reuse from creating ambiguous identity histories without poisoning unused paths after harmless precondition failures.

## 6. Human-visible frontmatter contract

Project OS owns two identity fields in human Markdown Managed Documents:

```yaml
project_id: PRJ-0003
document_id: DOC-08B3524AC1CB4D6AE7079816
```

These are controlled metadata, not user-authored business claims.

### 6.1 Required behavior

For Project OS-governed work-product writes:

- if `project_id` is absent, Project OS inserts it;
- if `document_id` is absent, Project OS inserts it;
- if either field is present with the expected value, it is preserved;
- if either controlled field is present with a different value, the write fails closed with an identity mismatch;
- duplicate controlled keys, ambiguous YAML values, or unsupported controlled-field structures fail closed;
- `version_id` is **not** injected into human Markdown;
- other frontmatter fields remain user/document-owned and are preserved.

### 6.2 Minimal frontmatter transformation

The implementation must avoid broad YAML reserialization.

For Markdown text:

1. if the document has no leading frontmatter block, prepend a minimal block containing the controlled fields;
2. if a leading frontmatter block exists, scan it for the controlled top-level scalar keys;
3. validate existing controlled values;
4. insert only missing controlled lines;
5. preserve unrelated frontmatter lines, comments, order, and document body bytes as much as possible.

Project OS should not parse and rewrite arbitrary nested YAML merely to add identity fields.

### 6.3 Hash ordering

The accepted ordering is:

```text
validate submitted content/hash
        -> resolve document_id
        -> inject/validate controlled frontmatter
        -> compute canonical SHA-256 of final bytes
        -> store immutable payload
        -> write provider-visible file
        -> persist version/head evidence
```

The existing request `content_sha256` continues to validate the content submitted by the caller. The canonical `DocumentVersionRecord.content_sha256` must represent the **final normalized bytes actually stored and written**.

This avoids hash loops and makes canonical payload evidence match the visible Markdown.

## 7. Governed rename API

A new work-product operation is added to the Managed Document request family:

```ts
{
  operation: "document.rename";
  request_id: string;
  project_id: string;
  document_id: string;
  new_logical_path: string;
  expected_versions: {
    working?: string;
    review?: string;
    published?: string;
  };
  created_at: string;
}
```

`expected_versions` is a full optimistic-concurrency snapshot of all active work-product pointers. Rename fails if the supplied set does not exactly match the current head pointers.

This is stronger and less ambiguous than a single `expected_version_id` because a reopened document may have a published version and a working/review version simultaneously.

### 7.1 Rename preconditions

Before provider mutation, Project OS must:

1. verify project mutability and project binding;
2. load/restore the work-product head by `document_id`;
3. compare `expected_versions` to the current head;
4. validate `new_logical_path`;
5. ensure the destination path has no permanent claim owned by another document;
6. ensure no other live rename intent reserves the destination for another document/request;
7. ensure all current active provider observations still match their expected revisions/evidence;
8. persist a durable rename intent whose destination acts as the **temporary reservation** before moving any provider object.

A permanent path claim for the destination is not created at this precondition stage.

## 8. Crash-safe rename intent and reservation

Governed rename is a resumable multi-step operation.

A provider-bearing rename intent uses the current provider-neutral V2 compatibility model established by `IMP-SCHEMA001`. It records enough frozen evidence to resume without guessing.

Conceptually:

```ts
interface ManagedDocumentRenameIntentV2 {
  schema_version: "2.0";
  request_id: string;
  project_id: string;
  document_id: string;
  from_logical_path: string;
  to_logical_path: string;
  expected_versions: ActiveVersionPointers;
  created_at: string;
  stages: {
    working?: RenameStageIntent;
    review?: RenameStageIntent;
    published?: RenameStageIntent;
  };
  status: "prepared" | "applying" | "committed" | "aborted";
}
```

Each stage intent freezes source path, destination path, active version ID, and provider-neutral precondition/evidence sufficient for the active persistence provider.

The precise storage structure may use an immutable intent plus append-only step/terminal records instead of mutating the intent in place. The required semantic is append-only/recoverable progress, not a specific file layout.

### 8.1 Reservation semantics

A non-terminal rename intent reserves `to_logical_path` for its `document_id`/`request_id` before provider effects. Other creates/renames must treat that destination as unavailable.

If the operation fails **before any provider effect**, it may write a terminal `aborted` result; the temporary reservation then ceases to block the path and no permanent path claim is created.

After any provider effect has occurred, the operation is no longer safely abortable by simply releasing the path. Recovery must converge the intent to a consistent committed state or require explicit administrative recovery; it must not silently free the destination while partial provider effects exist.

The permanent append-only path claim for `to_logical_path` is written only after all required provider/stage steps have succeeded and immediately before/folded into the final logical head transition. A crash after that claim but before head finalization is recoverable from the still-live rename intent and must converge to completion.

### 8.2 Rename execution

For every active representation in the head (`working`, `review`, and/or `published`):

1. verify whether the source or destination already reflects a prior completed step;
2. move the provider object only when the step has not already happened;
3. read destination metadata/evidence;
4. for an identity-stamped Markdown representation whose bytes are unchanged, reuse the immutable content payload;
5. for a legacy unstamped Markdown representation, normalize/inject the controlled identity during the rename, persist the new canonical payload/hash, and write those final bytes under provider preconditions;
6. create a new document version for that stage;
7. store the new `logical_path` and provider path/evidence in the new version;
8. persist step completion.

After all active stages have completed:

1. write/verify the permanent destination path claim for the same `document_id`;
2. update the head atomically/logically to keep the same `document_id`, set `logical_path` to the new path, point each active stage to its new rename-generated version, update provider observations, and keep `reconciliation_status: clean`;
3. mark the rename terminal `committed`.

### 8.3 Rename creates versions

A rename creates a new `version_id` for each moved active stage even when content bytes are unchanged.

Reason: a Managed Document version represents observable document state, including logical/provider path, not only payload bytes.

Example:

```text
DOC-X / VER-1 / A.md
      -> governed rename
DOC-X / VER-2 / B.md
```

The old version remains immutable and retains `A.md`. The new version reuses the old immutable payload only when final bytes are unchanged; a legacy unstamped Markdown rename creates a newly normalized payload containing the controlled identity.

Rename version IDs must be deterministic from `request_id` plus the specific rename stage so retries cannot create duplicate business effects.

## 9. Reconciliation behavior

Human-visible `document_id` is evidence, **not authority to rebind identity**.

### 9.1 Normal managed edit

If a file appears at the expected current path and its controlled identity matches the head, existing external-edit capture semantics continue.

### 9.2 Forged/mismatched ID

If a managed path contains a `project_id` or `document_id` that conflicts with the governed identity:

- do not rebind the file to the supplied ID;
- preserve/snapshot the external evidence when possible;
- mark or surface `DOCUMENT_IDENTITY_MISMATCH`;
- set/retain conflict state as appropriate;
- restore the governed representation when current recovery rules require restoration;
- do not advance clean reconciliation as if the mismatch were valid.

### 9.3 Missing ID

Missing identity is tolerated only for a legacy Managed Document whose current governed version has never been identity-stamped.

Once a governed canonical version contains the controlled identity fields, removing either field externally is an identity-integrity conflict, not a legacy case.

The implementation may derive the stamped state from the current canonical payload/version and may cache it if schema-compatible, but the governed version remains the authority.

### 9.4 External/manual rename

A provider-side move or rename is never automatically accepted as a logical rename.

If a moved file exposes a known `document_id` under a path different from `head.logical_path`:

- recognize it as evidence associated with that document;
- do not mutate `head.logical_path` or create a permanent path claim automatically;
- preserve external bytes/version evidence where possible;
- surface a conflict;
- restore the governed current representation when required by lifecycle/recovery rules.

Even moving a file back to one of the document's historical aliases does not count as a governed rename. Only `document.rename` changes the current logical path.

### 9.5 In-flight internal rename

The reconciler must consult active rename intents before classifying provider changes. Source disappearance and destination appearance that match a live governed rename are internal effects and must not be misclassified as external mutation/conflict.

## 10. Legacy compatibility and opportunistic stamping

There is no mass historical backfill.

Existing heads, versions, and visible documents remain valid.

For an existing legacy work product:

- if it has no permanent path claim, the next governed mutation establishes the claim for its current `head.logical_path` and existing `document_id` as part of that successful mutation/recovery path;
- the next governed text-producing operation (`working.write`, `review.write`, publication replacement, or other content write) injects the controlled identity;
- **governed rename itself also stamps any active legacy Markdown representation** even if the rename would otherwise only move bytes;
- simple reader/recovery operations do not rewrite bytes solely to stamp identity;
- immutable historical payloads are never modified.

A separate explicit future backfill may be designed if needed, but it is not part of this package.

## 11. Legacy Artifact API

The legacy Artifact API already creates/adopts Managed Document heads for governed published work products. For new or replaced Markdown work-product artifacts it must use the same controlled-frontmatter normalization before canonical payload storage and provider write.

The resulting published file must expose the same `document_id` stored in the Managed Document head.

No legacy route may independently invent or trust a caller-provided `document_id`.

References written through legacy artifact routes remain outside this package's identity-visibility scope.

## 12. Bootstrap and recovery

Bootstrap/recovery must remain reader-first.

- Existing legacy work products may still be found using current path/head/version evidence where no permanent claim exists.
- Once a permanent claim exists, claim lookup is authoritative for path-to-document resolution.
- Live rename intents act as temporary path reservations and recovery instructions, not historical aliases until committed.
- Recovery that reconstructs heads from immutable versions must preserve the original `document_id` even if the latest version has a renamed `logical_path`.
- Recovery must rebuild or validate permanent path claims from durable claim records; it must not infer that old paths became reusable.
- Rename intent recovery must finish or reconcile interrupted provider moves before normal reconciliation treats those changes as external.

## 13. Schema and compatibility rules

This package follows the A2 family-selective schema architecture already deployed by `IMP-SCHEMA001`:

- existing V1/V2 records remain readable;
- no downmigration;
- no bulk rewrite;
- no write-on-read historical mutation;
- new provider-bearing rename evidence uses provider-neutral V2 semantics;
- non-provider permanent path claims may start as an independent schema-1.0 family;
- projection version is independent and should not bump unless a generated projection contract actually changes.

The visible Markdown frontmatter change is a Managed Document content contract, not a ProjectState schema migration.

## 14. Failure semantics

The system fails closed for:

- destination path already permanently claimed by another document;
- destination path temporarily reserved by another live rename;
- destination provider path occupied by unrelated content;
- controlled frontmatter mismatch;
- duplicate/ambiguous controlled identity keys;
- stale `expected_versions`;
- provider precondition/revision mismatch;
- partial rename state that cannot be proven from durable intent/evidence;
- external rename presented as if it were governed;
- attempt to create/write a new document through another document's historical alias.

No failure path may allocate a second `document_id` for the same governed document, silently transfer a path claim, or permanently reserve a never-used rename destination after a clean pre-provider abort.

## 15. Invariants

The package must enforce at least:

### `INV-DOCID-001`
Every Managed Document head has exactly one valid internal `document_id`.

### `INV-DOCID-002`
Every identity-stamped human work-product representation in WORKING, REVIEW, or DELIVERABLES exposes the same `document_id` as its head.

### `INV-DOCID-003`
`WORKING -> REVIEW -> DELIVERABLES` and reopen preserve `document_id`.

### `INV-DOCID-004`
A new document version changes `version_id`, not `document_id`.

### `INV-DOCID-005`
Business IDs such as `task_id` or `decision_id` never substitute for `document_id`.

### `INV-DOCID-006`
Provider object IDs are never treated as work-product logical identity.

### `INV-DOCID-007`
Controlled frontmatter mismatch is detected and never silently accepted.

### `INV-DOCID-008`
A permanently claimed normalized logical path can never belong to two different `document_id` values.

### `INV-DOCID-009`
Governed rename preserves `document_id` and creates a new version for each active representation moved.

### `INV-DOCID-010`
External provider rename/move never changes `head.logical_path` automatically.

### `INV-DOCID-011`
Committed historical aliases remain permanently reserved to their original `document_id`.

### `INV-DOCID-012`
Once a governed version is identity-stamped, later removal of controlled identity fields is a conflict.

### `INV-DOCID-013`
A rename aborted before any provider effect does not create a permanent historical alias for its attempted destination.

## 16. Required test matrix

### Frontmatter and hashing

- create new Markdown WORKING without frontmatter;
- create with unrelated existing frontmatter;
- preserve correct controlled IDs;
- reject wrong `project_id`;
- reject wrong `document_id`;
- reject duplicate controlled keys;
- verify canonical payload hash equals final visible normalized bytes;
- verify submitted-content hash validation remains intact.

### Lifecycle identity

- WORKING -> REVIEW -> DELIVERABLES retains one `document_id`;
- publish V1 -> reopen/edit -> publish V2 keeps same `document_id` and changes versions;
- task-linked document exposes both `task_id` and `document_id` without conflation.

### Path claims and reservations

- initial successful create establishes permanent path claim;
- same-document permanent claim retry is idempotent;
- second document cannot claim historical/current path;
- case-equivalent provider path collision is rejected;
- historical alias cannot be silently reused by `working.write`;
- same document can explicitly rename back to a historical alias;
- pre-provider rename failure/abort releases temporary destination reservation and creates no permanent alias;
- concurrent/live rename reservation blocks another create/rename from taking that destination.

### Governed rename

- rename WORKING only;
- rename REVIEW while a published version also exists;
- rename reopened WORKING while published version also exists;
- rename published-only document;
- rename `A.md -> B.md -> A.md`;
- all moved stages receive deterministic new version IDs;
- immutable content payload is reused when final bytes are unchanged;
- legacy unstamped Markdown is stamped during rename and receives a new canonical payload/hash;
- stale `expected_versions` fails before provider mutation;
- occupied provider target fails closed.

### Crash/recovery

Inject deterministic faults after each durable/provider step:

- after rename intent/temporary reservation persistence;
- after first provider move;
- after destination evidence capture;
- after first rename version record;
- after all provider moves but before permanent path claim;
- after permanent path claim but before head update;
- after head update but before terminal marker.

Every retry/recovery must converge to one document identity, one current logical path, one set of active stage versions, and no duplicate provider effects. A pre-provider terminal abort must leave the attempted destination reusable because no permanent claim was committed.

### Reconciliation

- correct identity external edit captured normally;
- forged `document_id` detected;
- forged `project_id` detected;
- removal of identity from stamped document detected;
- legacy unstamped document remains compatible;
- manual provider rename is not auto-adopted;
- manual move to historical alias is not auto-adopted;
- reconciler ignores/properly accounts for in-flight governed rename steps.

### Legacy Artifact API

- new governed published Markdown artifact exposes correct `document_id`;
- replacement preserves same logical identity;
- incorrect caller-visible controlled ID cannot override ledger identity;
- existing non-Markdown/binary behavior remains unchanged.

### Isolation and schema compatibility

- path claims/reservations are project-scoped;
- same logical path in two projects is allowed with independent identities;
- V1 historical document records remain readable;
- existing provider V2 evidence remains readable;
- no mass rewrite occurs during startup/reconciliation.

## 17. Rollout plan and gates

Implementation must be staged.

### Gate R0 — reader/reconciler compatibility

Deploy readers and reconciliation logic that understand both legacy unstamped and new identity-stamped work products, plus path claims/rename intents, while leaving identity injection and rename writes disabled.

Proof: no regression against existing projects and current Managed Document reconciliation.

### Gate R1 — identity stamping for governed writes

Enable controlled frontmatter injection/validation for new governed work-product text writes and legacy Artifact API Markdown publications.

Proof: isolated production probe demonstrates exact head/frontmatter identity match and canonical hash of visible bytes.

### Gate R2 — governed rename

Enable `document.rename`, temporary path reservations, permanent path claims, durable rename intent, and crash recovery.

Proof: isolated production probe demonstrates stable identity across rename and lifecycle plus historical alias reservation and clean pre-provider abort semantics.

### Gate R3 — steady state

After CI, exact-commit deployment, health validation, isolated production proof, and read-only non-regression checks, make the capability normal production behavior.

No historical bulk rewrite is part of any rollout gate.

## 18. Production proof

Production validation must use a **new isolated probe project**, not PRJ-0003 and not a recycled historical probe.

The proof must demonstrate at minimum:

1. create a new Markdown work product;
2. verify visible `project_id + document_id` match its head;
3. promote to REVIEW and publish with the same ID;
4. reopen and create another version with the same ID;
5. governed rename `A.md -> B.md` preserving ID;
6. verify old path is permanently reserved and cannot be claimed by another document;
7. governed rename back to `A.md`;
8. verify a pre-provider failed rename does not permanently consume its unused destination;
9. verify forged identity is detected in a controlled probe;
10. verify an external/manual rename is not silently adopted;
11. verify no business revision or project outside the isolated probe changes as a side effect.

Probe cleanup must preserve machine-managed audit evidence and follow normal provider mutation confirmation rules.

## 19. Expected code surfaces

Implementation planning should inspect and likely touch only the necessary subset of:

- `src/domain/managed-document.ts`
- `src/domain/managed-document-request.ts`
- `src/documents/service.ts`
- `src/documents/reconciler.ts`
- `src/documents/bootstrap.ts`
- `src/documents/repository.ts`
- `src/documents/legacy-artifact.ts`
- persistence layout/provider compatibility helpers for new claim/intent records
- ProjectGuard document routing
- focused Managed Document, reconciliation, fault-injection, legacy artifact, provider compatibility, and API tests
- `docs/managed-documents.md` after implementation is validated

Do not use the generated Project OS projection frontmatter renderer (`src/render/frontmatter.ts`) as the Managed Document frontmatter implementation. Generated canonical notes and collaborative Managed Documents are separate systems.

## 20. Acceptance criteria

The package is acceptable only when all of the following are true:

- new governed Markdown work products visibly expose correct `project_id` and `document_id`;
- the same ID survives lifecycle transitions, reopen, versions, and governed rename;
- a rename does not derive a new ID from the new path;
- committed historical logical paths remain reserved to the original document;
- a clean pre-provider rename abort does not create a permanent unused alias;
- mismatched/forged identity fails closed;
- legacy unstamped documents remain readable and are stamped opportunistically, including during governed rename, not via mass rewrite;
- rename is deterministic, idempotent, concurrency-safe, and recoverable after every tested interruption;
- external/manual rename never silently changes logical identity/path;
- legacy Artifact API Markdown publication uses the same identity contract;
- all relevant unit/integration/high-risk tests pass;
- exact commit deploys successfully on GitHub-hosted infrastructure;
- production health and isolated probe proof pass;
- canonical PRJ-0002 evidence is recorded through receipt-gated typed transactions before `TASK-IMPDOCIDENTITY001` is marked complete.

## 21. Relationship to the remaining roadmap

`IMP-DOCIDENTITY001` runs before `IMP-INDEX001` because a durable read/search index should index stable document identities rather than path-derived pseudo-identities.

The resulting contract gives later packages a clean foundation:

```text
stable document_id
    + mutable current logical_path
    + immutable version history
    + permanent historical path claims
    -> reliable INDEX / OBSERVE / SECURITY / UX references
```

This package therefore closes a field-observed identity gap without broadening into the later indexing or product layers.