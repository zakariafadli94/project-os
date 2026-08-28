# IMP-SCHEMA001 — Schema Compatibility and Migrations Design

## Status

Design revalidated and approved by the user on 2026-08-28.

Canonical approval: `DEC-IMPSCHEMAA2001`, committed in PRJ-0002 revision 106 by transaction `TXN-SCHEMA-A2-DESIGN-APPROVAL-20260828-170710-6353` / event `EVT-000106`.

This design is validated against GitHub `main` at commit `a461f4ccc71de8f5fc0310381f3d2829d1466f2b` and the canonical PRJ-0002 state at revision 106.

This document approves the Architecture A2 design and rollout model only. It does **not** authorize runtime implementation, a schema writer cutover, production deployment, migration execution, destructive rewrite, deployment-pipeline changes, or completion of `TASK-IMPSCHEMA001`.

## Purpose

Make Project OS upgrades safe when durable records were created by different software and schema generations, while preserving immutable history, deterministic recovery, existing projects, managed-document history, MutationGate evidence, materialization semantics, and provider-neutral runtime boundaries.

The package must solve two distinct problems without conflating them:

1. **schema compatibility** — how Project OS reads and writes durable record generations safely;
2. **rollout compatibility** — how software capable of reading/writing those generations is introduced and rolled back safely in production.

The design deliberately avoids one global Project OS schema version. Durable families evolve independently.

## Architecture decision

Adopt **Architecture A2 — selective family evolution with strict read/upcast and current-write behavior**.

A2 preserves the core of the previously accepted Architecture A:

```text
raw durable record
      |
      v
strict parser for declared source version
      |
      v
pure deterministic upcast chain
      |
      v
current semantic model
      |
      v
business logic / recovery / projection
```

Writes are independent by family:

```text
current semantic model
      |
      v
configured current encoder for that family
      |
      v
new durable record
```

No reader rewrites the record it just read. Immutable historical records are never bulk rewritten.

The architecture is **family-versioned**, not release-versioned. A valid canonical commit may therefore contain a schema-1.0 commit envelope, a schema-2.0 ProjectState, a schema-1.0 Transaction, schema-1.0 DomainEvent, and schema-1.0 Receipt.

## Revalidated baseline

The target baseline contains material changes that did not exist when the original SCHEMA checkpoint was accepted.

### Canonical state and commit model

- production layout mode is `v2`;
- continuity mode remains `stable`;
- canonical immutable commit records are the recovery history for revisions that have them;
- `state.json` is a mutable canonical snapshot/derivative that can be reconstructed or converged without creating a business revision;
- Durable Object SQLite is hot operational state and is not canonical business truth;
- projection/materialization is asynchronous and independently versioned.

### Formal domain model

`IMP-MODEL001` is complete. Project, task, phase, decision, research, deliverable and constraint lifecycle semantics are now the business baseline that ProjectState schema migration must preserve exactly.

### Persistence provider boundary

`IMP-PERSIST001` is complete. Runtime metadata is provider-neutral and exposes concepts including:

- `providerId`;
- `objectId`;
- `revisionToken`;
- `integrityHash { algorithm, value }`;
- size/path metadata;
- explicit conditional-write, server-side-copy, change-feed and evidence capabilities.

Dropbox remains the only production provider. PERSIST intentionally preserved Dropbox-shaped schema-1.0 durable evidence and deferred its durable generalization to SCHEMA001.

### MutationGate

`IMP-MUTATIONGATE001` is complete and production mode is `enforce`.

Durable schema-1.0 families now include:

- artifact mutation intents;
- intent destination bindings;
- external mutation candidates;
- immutable candidate payload snapshots;
- candidate resolutions;
- terminal candidate-resolution evidence.

The historical PRJ-0003 deviation repair is complete: all eight approved candidates have deterministic terminal resolutions. SCHEMA must preserve those identities and records exactly.

### Residual deployment risk

Production currently has evidence of a race between GitHub Actions deployment and Cloudflare Workers Builds deployment. A delayed autonomous deployment has previously replaced a newer authenticated operator deployment.

For schema changes, this is a correctness risk: after the first durable V2 write, a delayed V1-only Worker must never be able to become production again.

Therefore deployment authority is a hard precondition of schema writer cutover, not an unrelated cleanup.

## Global invariants

All SCHEMA implementation and rollout work must preserve these invariants.

1. **No silent history rewrite.** Immutable commits, events, historical receipts, document versions, MutationGate candidates/resolutions, and other append-only evidence remain byte/history-preserving records.
2. **No business revision for representation conversion.** Upcasting or snapshot convergence does not create a transaction, event, decision, or project revision.
3. **No write-on-read.** Reading V1 and upcasting to the current semantic model does not persist V2 merely because the object was observed.
4. **Unknown future versions fail closed.** Software never guesses how to interpret a newer durable schema.
5. **Malformed known versions fail closed.** Upcasters operate only after strict source-version validation.
6. **Migrations never invent business truth.** IDs, lifecycle meaning, project revision, timestamps, causal links and explicit acceptance state are preserved.
7. **Mixed supported generations are first-class.** Recovery and business reads cannot assume all records in a project share one schema version.
8. **Projection version remains independent.** A ProjectState schema bump does not itself imply a projection-version bump.
9. **Provider evidence semantics are explicit.** Dropbox content hash is never relabeled as canonical SHA-256.
10. **Existing durable identities are stable.** Schema migration does not recalculate historical document, version, candidate, intent or resolution IDs.
11. **MutationGate stays enforce.** Schema rollout does not weaken final-zone governance.
12. **Project isolation fails closed.** No migration or reader may bind evidence from one project into another project.
13. **Rollback never down-migrates durable truth.** Recovery after a writer cutover is forward-compatible, not history-rewriting.

## Versioning policy

### Version ownership

Each durable record family owns its own `schema_version` and compatibility policy.

There is no top-level `PROJECT_OS_SCHEMA_VERSION` whose value forces unrelated records to migrate.

### Version semantics

Use major/minor string versions with current production convention such as `"1.0"` and `"2.0"`.

For this package:

- a **major** change means old software cannot safely interpret the new representation without an explicit parser/upcaster change;
- a family does not receive a bump merely because a release changed code elsewhere;
- compatible implementation refactors that preserve the durable contract do not change schema version.

### Read support

A family reader contains an explicit dispatch table for every supported durable generation.

Conceptually:

```text
schema_version = 1.0 -> parse V1 strictly -> migrate V1 to current model
schema_version = 2.0 -> parse V2 strictly -> current model
anything else       -> unsupported-version failure
```

Missing `schema_version` is not silently interpreted as current. Historical exceptions, if any are required by real durable evidence, must be represented as an explicit legacy parser and test fixture rather than a permissive fallback.

### Write support

Every family has one configured current write version for normal new records.

Reader compatibility and writer activation are separate rollout controls. Shipping V2 readers does not activate V2 writes.

## Family version matrix

The validated target matrix is:

| Durable family | Current production | Target normal writes | Rationale |
| --- | --- | --- | --- |
| ProjectState | 1.0 | **2.0** | Freeze the current formal business model as a strict canonical representation |
| machine manifest | derived from state version today | **2.0** | Make manifest representation explicit and stop accidental coupling to state implementation |
| CanonicalCommitRecord envelope | 1.0 | 1.0 | Envelope structure does not require a bump; nested family versions are independent |
| Transaction | 1.0 | 1.0 | No incompatible transaction change is required by SCHEMA |
| DomainEvent | 1.0 | 1.0 | No incompatible event-envelope change is required |
| canonical Receipt | 1.0 | 1.0 | No incompatible receipt-envelope change is required |
| registry | 1.0 | 1.0 | Current structure remains sufficient |
| materialization completed record/head | 1.0 | 1.0 | Schema compatibility is orthogonal to projection generation |
| `projection_version` | 1 | 1 | Bump only when projection semantics/rendering require it |
| ManagedDocumentHead | 1.0 | **2.0** | Replace Dropbox-shaped provider observations with provider-neutral durable evidence |
| DocumentVersionRecord | 1.0 | **2.0 for new versions** | Preserve immutable V1 versions; new provider-bearing versions use neutral evidence |
| provider-object binding | 1.0 | **2.0** | Qualify object identity by provider |
| reference integrity fingerprint | 1.0 | **2.0** | Qualify integrity evidence by provider + algorithm |
| managed-document request intent | 1.0 | 1.0 | No provider-shaped evidence requires change |
| managed-document request receipt | 1.0 | 1.0 | No provider-shaped evidence requires change |
| MutationGate artifact intent | 1.0 | **2.0** | Generalize provider precondition/evidence |
| MutationGate destination binding | 1.0 | 1.0 | Binding contains no provider evidence requiring change |
| MutationGate external candidate | 1.0 | **2.0** | Generalize provider identity/revision/integrity evidence |
| MutationGate resolution | 1.0 | 1.0 | Resolution identity/action does not require provider generalization |
| MutationGate terminal resolution evidence | 1.0 | 1.0 | Existing structure remains sufficient |

This matrix is deliberately selective. A future incompatible change may bump any retained 1.0 family independently.

## ProjectState 2.0

### Purpose of the bump

ProjectState 1.0 currently represents multiple historical structural generations under the same version. Compatibility normalization supplies missing framing/discovery/routes and maps old deliverable statuses into the current lifecycle model.

ProjectState 2.0 ends that ambiguity by making the **current formal ProjectState shape** the strict serialized contract.

The bump does not introduce a new business model.

### Required V1 -> V2 preservation

The migration must preserve exactly:

- `project_id`;
- project name, slug and aliases;
- objective/framing/discovery semantics;
- project lifecycle status;
- project `revision`;
- `current_phase_id`;
- all entity IDs;
- task/phase/decision/research/deliverable/constraint business meaning;
- artifact-route semantics;
- `last_event_id`;
- creation/update timestamps.

Historical compatibility normalization that currently happens implicitly becomes explicit migration behavior. Examples include:

- absent framing/discovery/routes become their defined empty current representations;
- legacy deliverable `pending` maps to `planned`;
- legacy deliverable `completed` maps to `legacy_completed`;
- current lifecycle statuses retain their exact meaning.

The migration must not infer acceptance, completion, supersession, ownership, relationships or research links that do not exist in V1 evidence.

### Snapshot convergence

A V1 `state.json` may be read and upcast to the current semantic model without write-on-read.

After a later legitimate canonical/materialization operation writes the mutable current snapshot, `state.json` may converge to schema 2.0 while retaining the same business revision if no business transaction occurred solely for conversion.

## Canonical commits and recovery

### Mixed nested versions

A schema-1.0 CanonicalCommitRecord envelope may embed ProjectState 1.0 or 2.0. The commit parser validates the envelope and delegates nested parsing to family-specific readers.

No commit-envelope bump is required merely because the nested state version changes.

### Mixed chains

This is a normal supported history:

```text
REV-000103 -> commit 1.0 / state 1.0
REV-000104 -> commit 1.0 / state 1.0
REV-000105 -> commit 1.0 / state 1.0
REV-000106 -> commit 1.0 / state 2.0
REV-000107 -> commit 1.0 / state 2.0
```

Recovery after total SQLite loss must produce the same final business state regardless of where the state-version transition occurs in a supported contiguous commit chain.

### Historical V2 snapshots predating commit records

Current compatibility paths support V2 layout snapshots that may predate immutable commit records. SCHEMA must preserve this bounded historical recovery behavior; it may not require synthetic commits to fill historical gaps.

## Provider-neutral durable evidence V2

### Common representation

Provider-bearing V2 records use the following semantic structure where applicable:

```text
provider_id
path
object_id
revision_token
integrity_hash:
  algorithm
  value
size
```

Field optionality remains family-specific. The common semantic model does not imply that every record must carry every field.

### Dropbox V1 upcast

Existing Dropbox schema-1.0 evidence upcasts exactly as:

```text
provider_id               = "dropbox"
path                      = provider_path/path
object_id                 = provider_file_id/file_id
revision_token            = provider_rev/rev
integrity_hash.algorithm  = "dropbox-content-hash"
integrity_hash.value      = provider_content_hash/content_hash
size                      = size
```

No hash conversion takes place.

Dropbox `content_hash` is provider integrity evidence. It is not renamed semantically to SHA-256 and does not replace Project OS canonical `content_sha256` fields.

### Future providers

This package creates a durable format capable of naming a provider and evidence semantics. It does not activate an alternate provider.

A future provider still requires a separate approved provider implementation and must prove that the capabilities required by the affected business flows are satisfied.

## Identity preservation

Schema evolution changes representation, not historical logical identity.

The following existing IDs are never recalculated during V1 -> V2 migration/upcast:

- `DOC-*`;
- `VER-EXT-*` and `VER-REQ-*`;
- `MUTINT-*`;
- `MUTCAND-*`;
- `MUTRES-*`;
- existing request IDs and transaction IDs.

### New Dropbox records after V2 cutover

For Dropbox, existing deterministic identity algorithms remain the compatibility identity algorithms for new V2 records as well. This prevents the same physical Dropbox object from acquiring a different logical Project OS identity simply because the schema writer was upgraded.

The V2 record stores provider-neutral evidence around that identity; it does not redefine the identity itself.

A future non-Dropbox provider must define its identity policy explicitly before activation. SCHEMA does not invent a cross-provider identity equivalence rule without a real provider and validated semantics.

## Provider-qualified indexes and bindings

Mutable/reconstructible indexes that are currently keyed only by Dropbox evidence need provider-qualified V2 keys.

Conceptually:

```text
provider object binding key =
  SHA256(provider_id + "\n" + object_id)

provider integrity fingerprint key =
  SHA256(provider_id + "\n" + integrity_hash.algorithm + "\n" + integrity_hash.value)
```

The exact storage-path encoding may be finalized in the implementation plan but must be deterministic and project-isolated.

Readers support both namespaces during compatibility:

1. check provider-qualified V2 evidence;
2. check legacy Dropbox V1 evidence where applicable;
3. if both exist and bind to contradictory logical objects, fail closed instead of choosing one silently.

There is no automatic full backfill of old indexes and no write-on-read migration.

## Managed-document compatibility

Managed-document history remains an immutable causal ledger.

### V1/V2 version chains

A single document history may contain:

```text
VER-A -> DocumentVersionRecord 1.0
VER-B -> DocumentVersionRecord 1.0
VER-C -> DocumentVersionRecord 2.0
```

Head reconstruction parses/upcasts every supported version before applying the existing causal-tip rules.

Schema conversion must not change:

- document kind;
- logical path;
- stage;
- parent-version relationship;
- request binding;
- published/working/review/reference lifecycle meaning;
- immutable payload identity;
- existing provider-derived IDs.

### Heads

ManagedDocumentHead is mutable/reconstructible. Once the provider-evidence writer gate is enabled, newly written/reconstructed heads use V2 neutral provider observations.

The head may therefore converge to V2 without rewriting any historical immutable document versions.

### Request ledger

Managed-document request intent/receipt records remain 1.0 unless a separate incompatible change is later required. Their durable request-hash/idempotency contract is independent from provider evidence representation.

## MutationGate compatibility

MutationGate remains `enforce` throughout SCHEMA rollout.

### Artifact intents

New V2 artifact mutation intents preserve the existing frozen-destination and route-snapshot guarantees while expressing provider preconditions with explicit provider identity/evidence semantics.

An `absent` precondition is also provider-bound so replay cannot silently reinterpret the same frozen intent against a different provider.

### External candidates

Historical V1 candidates remain valid forever and keep their existing deterministic `MUTCAND-*` identity.

New Dropbox V2 candidates retain the existing Dropbox-compatible candidate-ID derivation while serializing provider-neutral evidence.

Candidate payload snapshots remain immutable and are not rewritten.

### Resolutions

Candidate resolution and terminal-resolution records remain at 1.0 because their durable semantics depend on project/candidate/resolution identity and action, not the detailed provider evidence representation.

The eight repaired PRJ-0003 candidates are regression fixtures for SCHEMA. Every reader/recovery release must continue to report their existing terminal resolutions without generating duplicate candidate or resolution identities.

## Registry compatibility

The registry remains schema 1.0 in this package.

RegistryGuard must continue to reconstruct its project list from the durable canonical registry and preserve allocator correctness. SCHEMA must not conflate ProjectState schema version with registry version.

A future incompatible registry change receives its own version and migration policy.

## Materialization and projections

`schema_version` and `projection_version` remain independent dimensions.

Current materialization records and head remain schema 1.0 and current projection version remains `1` unless output semantics/rendering change for a separate reason.

ProjectState V2 alone does not authorize projection version 2.

The existing planner hashes semantic inputs, not whole-project revision for every output. Therefore an output may legitimately retain `source_revision=104` while the materialization head targets revision 105 if its semantic input did not change.

SCHEMA must preserve this carry-forward behavior.

Critical `STATE.md` and `HANDOFF.md` may be regenerated when their semantic input includes the new current state representation; unrelated projections should not be forced to rewrite merely because a durable schema version changed.

## Durable Object SQLite storage schema

Canonical durable record schema version and Cloudflare Durable Object SQLite storage schema are separate concepts.

### Required discipline

Each Durable Object class that needs local structural evolution gets explicit local storage schema/version metadata.

Preferred order:

1. additive transactional SQL migration;
2. safe targeted reconstruction from durable truth when complete reconstructibility is proven;
3. destructive local migration only under a separately justified plan.

Unknown future local storage schema fails closed.

### ProjectGuard

ProjectGuard SQLite is hot acceleration for project state, receipts, artifact requests, managed-document request cache and materialization coordination. Durable external truth must remain sufficient to restore canonical business state and durable request bindings.

During the compatibility-reader rollout, local JSON caches remain encoded in a form readable by the pre-writer rollback release. Merely reading/upcasting external V1 does not opportunistically convert local durable cache representation in a way that destroys rollback compatibility.

### RegistryGuard

RegistryGuard also contains allocator/request state that can include in-flight allocation progress. It must not be blindly dropped under a generic "SQLite is reconstructible" assumption.

Before any destructive rebuild, the design must prove that pending allocation/request state has either been reconciled to durable truth or preserved transactionally.

SCHEMA itself does not require destructive SQLite rebuild.

## Migration function requirements

Every record migration function must be:

- pure with respect to external state;
- deterministic;
- side-effect free;
- explicit about source and destination versions;
- idempotent at the semantic level;
- total for every valid source-version fixture;
- fail-closed for invalid source records;
- business-truth preserving.

Given the same valid source record bytes/parsed value, migration produces the same current semantic result independent of provider availability, current time, random values, network state, or existing project files.

Migration functions may normalize representation only when the mapping is defined by already accepted compatibility semantics.

## Error behavior

Schema failures are correctness failures, not opportunities for best-effort repair.

Required classes of failure include:

- unsupported future version;
- malformed known version;
- invalid project/object binding;
- contradictory mixed-generation index evidence;
- missing required migration path;
- provider evidence whose declared algorithm/provider cannot satisfy a family requirement;
- local SQLite storage version newer than the running software.

A schema-read failure does not trigger automatic destructive correction or rewriting of the offending durable object.

## Recovery strategy

### Canonical project recovery

After complete loss of ProjectGuard SQLite:

1. read a valid supported canonical snapshot if present;
2. reconcile against immutable commit records where available;
3. parse/upcast every nested durable family according to its declared schema version;
4. verify revision contiguity and project/transaction/event/receipt bindings exactly as today;
5. rebuild current local state;
6. schedule/materialize projections using the current projection engine.

The final business state must equal recovery from the same history before local loss.

### Managed documents

Loss of mutable heads/indexes is recovered from immutable V1/V2 version histories and durable provider evidence. Ambiguous causal tips or contradictory provider bindings remain fail-closed conflicts.

### MutationGate

Candidate/intents/resolutions remain append-only durable evidence. Reconciliation reads V1/V2 families, verifies immutable payload evidence and retains terminal resolution authority exactly as today.

### Registry

RegistryGuard continues to recover from canonical registry state while protecting any in-flight allocator/request semantics required by its local recovery model.

## Rollback model

Rollback is divided by the durable write frontier.

### Before the first V2 durable write

A compatibility-reader release reads V1+V2 but writes V1 only. If no V2 durable object exists yet, rollback to the pre-SCHEMA production release remains valid.

### After the first V2 durable write

A pre-SCHEMA V1-only Worker is no longer an allowed production fallback.

Rollback may target only a release proven to read every durable generation already written. The designated rollback release therefore becomes the compatibility reader, not the historical V1-only stable release.

### No down-migration

Rollback never means rewriting V2 history into V1.

If a V2 writer defect is found after committed durable V2 records exist:

- stop/limit new affected writes if necessary;
- roll execution back to a V1+V2-compatible reader/writer-safe release;
- diagnose against preserved immutable truth;
- repair forward with a corrected compatible release.

No business history is rewound solely to restore an older software binary.

## Production rollout gates

The rollout is monotonic and explicitly gated.

### R0 — deployment-authority safety

This is a hard blocker before any V2 writer activation.

Required outcome:

- exactly one authoritative mechanism can promote a Worker version to production;
- production promotion is attributable to an exact Git SHA/version;
- a delayed autonomous deployment cannot replace the selected schema-capable release;
- the designated compatibility rollback release is identified and available;
- deployment/health evidence can prove which exact release is serving.

The currently observed GitHub Actions + Cloudflare Workers Builds double-production-pipeline risk must be resolved before this gate passes.

Preferred architecture is one explicit production promoter. GitHub Actions is the current recommended promoter because it already performs repository checkout, `npm run check`, deployment and health verification. Cloudflare Workers Builds may remain a non-promoting build/upload mechanism only if it cannot independently change production traffic.

The exact deployment-pipeline mutation requires its own explicit operational approval; this spec records the cutover requirement, not authorization to change deployment infrastructure.

### R1 — compatibility reader

Deploy software that:

```text
reads all supported V1 + V2 family records
writes V1 for every family
```

No V2 durable record is intentionally produced.

Required proof includes:

- legacy sparse ProjectState V1;
- modern ProjectState V1;
- strict synthetic ProjectState V2;
- unknown future version rejection;
- malformed known-version rejection;
- deterministic migration fixtures;
- mixed commit-chain parsing/recovery;
- old projects without modern fields;
- full SQLite-loss recovery;
- managed-document mixed-generation fixtures;
- MutationGate V1 fixtures including all eight PRJ-0003 terminal candidates;
- materialization/projection behavior unchanged;
- normal production health and transaction smoke checks.

Rollback to the pre-SCHEMA release remains valid while the durable frontier is still V1-only.

### R2 — core state V2 writer

Activate only:

- ProjectState 2.0 writes;
- machine manifest 2.0 writes.

All provider-bearing managed-document and MutationGate families still write V1 at this gate.

Required validation:

- first V2 state on an isolated/canary project;
- commit envelope remains valid at 1.0;
- nested state 2.0 preserves revision/event/receipt bindings;
- mixed V1/V2 commit-chain recovery;
- state snapshot convergence without extra business revision;
- total SQLite-loss recovery;
- current projection version and materialization root-hash invariants;
- no forced unrelated projection rewrites;
- project isolation across V1-only and V2-writing projects.

Once any durable ProjectState 2.0 is committed, the pre-SCHEMA V1-only release is permanently outside the supported rollback set.

### R3 — provider evidence V2 writer

Activate new writes for:

- ManagedDocumentHead 2.0;
- DocumentVersionRecord 2.0;
- provider-object bindings 2.0;
- reference fingerprints 2.0;
- MutationGate artifact intents 2.0;
- MutationGate external candidates 2.0.

Required validation:

- existing managed-document V1 histories remain readable;
- a new V2 version can extend a V1 history without identity change;
- head reconstruction through V1+V2 history is deterministic;
- Dropbox CAS semantics remain intact;
- provider integrity algorithms are compared explicitly;
- no `DOC`, `VER`, `MUTINT` or `MUTCAND` duplication caused by schema generation;
- legacy and V2 provider-qualified bindings detect contradictions fail-closed;
- all eight repaired PRJ-0003 candidates remain terminal and unchanged;
- a new V2 MutationGate candidate can be captured and resolved in `enforce` mode;
- no unknown strict-zone file is implicitly governed during migration/recovery.

### R4 — steady state

After production evidence proves R2 and R3:

- families designated V2 write V2 by default;
- legacy V1 readers remain supported for historical records;
- no historical bulk rewrite is scheduled;
- old projects converge lazily through ordinary legitimate writes/reconstruction of mutable heads/snapshots;
- immutable V1 history remains permanently valid unless a future explicit deprecation package changes support policy.

## Compatibility test matrix

Implementation must include a deterministic matrix covering at minimum:

### ProjectState

- minimal/sparse historical V1;
- modern V1;
- strict V2;
- V1 -> V2 field-for-field semantic preservation;
- legacy deliverable status normalization;
- unknown `3.0` rejection;
- malformed `1.0` rejection;
- malformed `2.0` rejection;
- migration repeatability;
- no generated timestamp/ID/business fact.

### Canonical commits

- commit 1.0 with nested state 1.0;
- commit 1.0 with nested state 2.0;
- mixed chains crossing V1 -> V2;
- recovery after total SQLite loss;
- crash after immutable commit publication but before snapshot/local persistence;
- exact revision, transaction, event, receipt and `last_event_id` binding checks.

### Managed documents

- V1 head/version read;
- V2 head/version read;
- V1 -> V2 upcast of Dropbox evidence;
- V1/V2 causal chain head reconstruction;
- V2 provider-qualified binding/fingerprint lookup with V1 fallback;
- contradictory V1/V2 index evidence conflict;
- exact replay/idempotency;
- published/working/review/reference lifecycle preservation;
- provider CAS conflict behavior unchanged.

### MutationGate

- V1 intent/candidate/resolution/terminal read;
- V2 intent/candidate read;
- exact Dropbox V1 evidence upcast;
- identity preservation across schema generation;
- all eight PRJ-0003 repaired candidates/resolutions;
- governed-inflight classification across V1/V2 intent evidence;
- baseline/cursor-reset safety;
- V2 candidate capture/replay/resolution in `enforce`;
- no implicit publication/acceptance.

### Registry / materialization

- registry 1.0 recovery unchanged;
- allocator correctness unchanged;
- materialization head/record 1.0 unchanged;
- projection version remains 1;
- carried-forward outputs retain historical `source_revision` when semantic inputs are unchanged;
- critical STATE/HANDOFF generation remains coherent at the target canonical revision.

### Rollout / rollback

- R1 software against an all-V1 durable corpus;
- R1 rollback to pre-SCHEMA before any V2 durable write;
- R2 first-state-V2 frontier detection;
- rollback from R2 to designated V1+V2 compatibility release;
- proof that V1-only release is rejected/never selected after frontier crossing;
- R3 provider-evidence V2 mixed corpus;
- recovery with provider temporarily unavailable where only pure durable upcast is required;
- deployment identity proof preventing delayed old release promotion.

## Observability requirements

SCHEMA does not implement the full later observability package, but migration/cutover must expose enough structured information to diagnose correctness.

At minimum, schema-related failures and rollout proof should identify:

- project ID when applicable;
- durable family;
- encountered schema version;
- target/current semantic version;
- canonical revision when applicable;
- deployment/Git SHA identity;
- migration or parser failure class;
- whether the operation occurred before or after the V2 durable frontier.

Logs must not expose provider secrets or raw sensitive payloads merely to diagnose a schema failure.

## Non-goals

IMP-SCHEMA001 does not:

- add a second persistence provider;
- add direct local filesystem/PC access;
- redesign the business lifecycle model;
- introduce global multi-tenancy;
- rewrite all historical records into one generation;
- re-version every record family to 2.0;
- change projection output semantics merely because ProjectState changes version;
- weaken MutationGate `enforce`;
- redesign credentials/signatures/trust boundaries owned by SECURITY001;
- implement general product observability or performance work;
- authorize deployment-pipeline mutation by this document alone.

## Implementation-boundary guidance

The later implementation plan should favor small explicit family codec modules rather than one generic migration framework.

A family should be understandable independently:

```text
project-state/
  v1 parser
  v2 parser
  v1-to-v2 migration
  current reader/encoder

managed-document provider evidence/
  v1 parser
  v2 parser
  v1-to-v2 migration

mutation-gate provider evidence/
  v1 parser
  v2 parser
  v1-to-v2 migration
```

Exact filenames may follow the existing repository structure, but dependency direction is fixed: business logic consumes current semantic types, not historical schema unions.

Avoid unrelated refactors. Existing persistence/provider abstractions from IMP-PERSIST001 remain the runtime boundary.

## Acceptance criteria for the design package

The design package is ready for implementation planning only when the user has reviewed this written spec and explicitly approves it.

Implementation itself remains a separate gate and must not begin from this document alone.

A later implementation plan must also treat R0 deployment-authority resolution as a prerequisite task/gate before any V2 writer activation, even if compatibility reader code can be implemented and tested beforehand.

## Authoritative references

Revalidation used these authoritative sources:

- canonical PRJ-0002 `HANDOFF.md`, `STATE.md`, `PLAN.md` and machine `state.json`;
- canonical `DEC-IMPSCHEMADESIGN001` / `RES-IMPSCHEMADESIGN001` original SCHEMA checkpoint;
- canonical `DEC-IMPSCHEMAA2001` Architecture A2 approval at revision 106;
- canonical PERSIST decisions and production validation;
- canonical MutationGate enforcement and PRJ-0003 repair evidence;
- `docs/project-os-improvement-roadmap.md`;
- `docs/managed-documents.md`;
- `docs/mutation-gate.md`;
- `src/domain/project-state.ts` and `project-state-normalizer.ts`;
- `src/domain/commit-record.ts`, `transaction.ts`, `event.ts`, `receipt.ts`;
- `src/domain/managed-document.ts` and document repositories/request ledger;
- `src/domain/mutation-gate.ts` and MutationGate repository/services;
- `src/domain/materialization.ts` and materialization planner/ledger;
- `src/persistence/provider/*`, Dropbox adapter and Dropbox V1 compatibility seam;
- `src/persistence/repository-core.ts` and layout/path contracts;
- `src/durable/project-guard-neutral.ts` and `registry-guard-neutral.ts`;
- `.github/workflows/deploy.yml` and `wrangler.jsonc`;
- GitHub `main` commit `a461f4ccc71de8f5fc0310381f3d2829d1466f2b`.
