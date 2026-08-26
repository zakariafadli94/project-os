# IMP-PERSIST001 — Persistence Provider Boundary Design

## Status

Design validated by the user on 2026-08-26 after revalidation against canonical PRJ-0002 revision 92 and GitHub `main` at merge commit `946337526c8da541db00cd4ec5ff76207e6295a6`.

This document authorizes design/specification only. It does not authorize runtime implementation, deployment, MutationGate enforcement, PRJ-0003 repair, SCHEMA runtime work, schema migration, or any alternate persistence provider.

## Purpose

Introduce a real provider-neutral runtime persistence boundary while keeping Dropbox as the only production persistence provider in this package.

The package must prevent Project OS Core, repositories, materialization, managed documents, MutationGate, inbox processing, and Durable Objects from depending directly on Dropbox client classes, Dropbox error classes, Dropbox retry classification, or Dropbox-specific capability probing.

At the same time, it must preserve every existing schema-1.0 persisted record and Dropbox V1 compatibility exactly. Provider-shaped persisted fields and identities are intentionally not generalized in PERSIST001; that work remains a dependency of IMP-SCHEMA001.

## Design decision

Adopt **Option B — provider-neutral runtime boundary with explicit Dropbox V1 compatibility seam**.

The intended architecture is:

```text
Domain / Project OS services
          |
          v
persistence/*
  - logical layout and paths
  - repositories
  - provider-neutral contracts
  - provider-neutral errors
  - capability requirements
  - provider-neutral resilience
          |
          v
production composition roots
          |
          v
Dropbox persistence adapter
          |
          v
Dropbox API
```

Alongside that runtime boundary, schema-1.0 provider evidence remains isolated through an explicit compatibility seam:

```text
provider-neutral runtime metadata/evidence
          |
          v
Dropbox V1 schema compatibility seam
          |
          v
existing schema-1.0 fields and identities
```

PERSIST001 therefore makes execution provider-neutral, not historical serialized formats provider-neutral.

## Goals

PERSIST001 must:

- keep Dropbox as the only production provider;
- introduce a provider-neutral persistence contract used by runtime services and repositories;
- make provider capabilities explicit and semantically defined;
- remove direct Core dependencies on `DropboxTransport`, `DropboxConflictError`, Dropbox API errors, and Dropbox retry classification;
- centralize provider construction so Dropbox credentials/client setup exist in one production factory rather than across multiple layers;
- preserve all existing paths, records, IDs, schema versions, and Dropbox V1 behavior;
- preserve current reliability semantics, including bounded retries, fail-closed conflict handling, idempotent recovery, server-side snapshots, CAS behavior, and cursor-reset recovery;
- leave MutationGate in `observe`;
- create no requirement for a local filesystem or user PC bridge;
- establish a clean foundation for later INDEX/OBSERVE/SECURITY/PERF packages and a separately approved alternate provider.

## Non-goals

PERSIST001 must not:

- add SharePoint, Google Drive, S3, filesystem, or any other production provider;
- add a provider-selection environment variable or dynamic provider registry;
- introduce a local filesystem provider, desktop daemon, or PC dependency;
- migrate or rewrite persisted data;
- bump any schema version;
- introduce schema upcasters or migrations;
- generalize persisted `provider_file_id`, `provider_rev`, `provider_content_hash`, provider paths, MutationGate provider preconditions, candidate records, or provider-derived IDs;
- change candidate identity semantics;
- change managed-document version identity semantics;
- launch PRJ-0003 deviation repair;
- launch SCHEMA runtime;
- switch MutationGate from `observe` to `enforce`;
- change continuity rollout mode;
- retune retry budgets or make unrelated performance changes.

## Current coupling being removed

The current code uses `DropboxTransport` as both a low-level provider API and an implicit capability bag. Its metadata shape carries Dropbox concepts directly (`id`, `rev`, `content_hash`), optional methods are used as runtime feature detection, and callers catch `DropboxConflictError` directly.

`ResilientDropboxTransport` also knows Dropbox HTTP status behavior and Dropbox request IDs, and several repositories/services construct their own resilient wrappers.

Direct `DropboxClient` construction currently occurs in multiple runtime composition locations, including worker helpers and Durable Object constructors.

Provider-independent Project OS concepts such as logical storage paths, workspace layout, artifact routing, and repositories are also located under `src/dropbox/`, which makes the namespace itself falsely provider-specific.

PERSIST001 must remove these forms of coupling rather than merely rename them.

## Target package boundaries

The implementation plan may refine filenames, but the architectural ownership must follow this structure:

```text
src/persistence/
  provider/
    contract
    metadata
    capabilities
    errors
    resilience
  layout
  paths
  repository-core
  repository
  compatibility/
    dropbox-v1-evidence
  providers/
    dropbox/
      client
      adapter
      error-mapping
  production-factory
```

Provider-independent artifact routing belongs with Project OS persistence/workspace governance rather than the Dropbox adapter.

The exact persisted path strings remain unchanged. Moving path-building code between source modules must not alter any `/PROJECT_OS/...` value.

## Provider-neutral base contract

The provider boundary represents a hierarchical Project OS object namespace. Paths are Project OS logical persistence paths; they are not declared to be native filesystem paths.

The base contract must cover the operations that are universally required by current Project OS runtime flows:

- read a text object and return absence explicitly;
- create a text object without silent overwrite or autorename;
- replace a text object according to the provider's ordinary replace semantics;
- read object metadata and return absence explicitly;
- list immediate children for a logical path;
- move/rename an object without silent destination overwrite;
- delete an object idempotently when absent.

Provider operations should return provider-neutral object metadata whenever the provider naturally supplies it. Callers must not parse provider-specific HTTP responses or error payloads.

The contract must preserve current fail-closed behavior. A provider adapter may not emulate an unsupported strong guarantee with a weaker read-then-write sequence and report it as equivalent.

## Provider-neutral metadata

Runtime metadata must use provider-neutral concepts:

```text
path
size
modifiedAt?
objectId?
revisionToken?
integrityHash?
```

`objectId` and `revisionToken` are opaque strings. Core code must not parse or rely on Dropbox formats.

`integrityHash` must carry both semantic identity and value, for example conceptually:

```text
algorithm
value
```

The Core must not assume Dropbox `content_hash` is SHA-256 or interchangeable with Project OS canonical SHA-256 content hashes.

For Dropbox production, the adapter maps Dropbox metadata into this neutral representation. The schema-1.0 compatibility seam may then validate and serialize the exact legacy Dropbox values where existing records require them.

## Explicit capabilities

Capabilities are contracts with defined semantics, not merely booleans and not optional transport methods probed throughout business code.

The provider profile must describe these six capabilities:

### 1. Conditional write

A conditional write is a true provider-side compare-and-swap against an opaque revision token.

It must not be implemented as:

```text
read metadata -> compare locally -> ordinary overwrite
```

because that sequence does not provide the concurrency guarantee required by managed-document publication.

### 2. Server-side copy

A server-side copy duplicates an object within provider storage without downloading and re-uploading the payload through Project OS.

PERSIST001 must not silently substitute client-side copy for this capability, because current managed-document and MutationGate snapshot semantics deliberately rely on provider-side copying, including binary/opaque payloads.

### 3. Incremental change feed

The provider can enumerate changes incrementally using an opaque cursor, including file, folder, and deletion observations needed by current managed-document reconciliation.

Cursor invalidation/reset must surface as a typed provider-neutral condition so the existing bounded baseline rebuild path remains possible.

### 4. Stable object ID

The provider supplies an opaque object identity stable enough for the existing Dropbox V1 managed-document and MutationGate identity semantics, including rename/move behavior relied upon by current records.

### 5. Revision token

The provider supplies an opaque object revision/version token suitable for equality and conditional-write preconditions.

The Core must not inspect the token's internal format.

### 6. Integrity hash

The provider supplies content-integrity evidence with an identified algorithm/semantic. Equality is valid only when both algorithm and value match.

The runtime abstraction must not rename arbitrary provider hashes to SHA-256.

## Capability binding rules

Services must bind required capabilities at construction/composition time rather than repeatedly testing for optional methods during operations.

Examples:

- ordinary canonical repository operations require only the base provider contract;
- managed-document publication/update requires conditional write plus revision-token capability;
- provider snapshots require server-side copy;
- managed-document change coordination requires incremental change feed;
- Dropbox V1 managed-document and MutationGate compatibility requires stable object ID, revision token, and Dropbox-compatible integrity evidence.

If a required capability is missing, construction must fail explicitly before business mutation begins.

Because Dropbox is the only production provider in PERSIST001, production startup/composition must prove that the Dropbox adapter satisfies the complete capability profile needed by enabled Project OS features.

## Provider-neutral error model

The Core must no longer catch Dropbox error classes.

The provider boundary must expose provider-neutral errors sufficient to preserve current semantics. At minimum the design needs:

- general provider operation failure with a `retryable` classification;
- conflict/already-exists failure;
- conditional-write/precondition failure;
- cursor-reset failure;
- unsupported/missing capability failure;
- terminal provider failure.

Provider-specific details such as Dropbox HTTP status, raw error payload, or request ID may be retained as opaque diagnostic metadata for logs, but business code must not branch on them.

The Dropbox adapter is responsible for mapping raw Dropbox responses into the provider-neutral error taxonomy.

A conditional Dropbox 409 must map to the provider-neutral precondition/CAS failure expected by managed-document logic rather than forcing business services to know Dropbox's status vocabulary.

## Resilience and retry boundary

Retry is a provider-neutral decorator around a provider whose adapter has already classified errors.

The resilience layer may retry only failures marked retryable by the adapter/neutral error contract. It must not contain Dropbox response-body parsing or Dropbox status knowledge.

PERSIST001 preserves the currently validated retry policy and timing behavior. It does not retune retry counts, backoff, or jitter.

A composition context must create the resilient provider once and inject it downward. Services and repositories must not repeatedly wrap the same raw provider in separate resilient transports.

The current move-recovery/idempotency semantics must be preserved behind provider-neutral conflict errors. Refactoring the boundary must not weaken inbox archival, workspace archive, or retry safety.

## Production construction and injection

Introduce one authoritative production factory, conceptually:

```text
createProductionPersistence(env)
```

The exact function name may change in the implementation plan, but the ownership rule is fixed:

- it is the only production location that knows Dropbox credential names and constructs the Dropbox client/adapter;
- it creates the provider-neutral Dropbox adapter;
- it applies the provider-neutral resilience decorator once;
- it validates the production capability profile;
- it returns the provider-neutral runtime object used by callers.

PERSIST001 does not add `PROJECT_OS_PROVIDER` or any provider switch. The factory always builds Dropbox.

Cloudflare Durable Objects are platform-created and therefore cannot receive an already-instantiated provider from the outer Worker. Their constructors may call the shared production factory with `env`; this is still centralized construction because direct `new DropboxClient(...)` is forbidden outside the factory.

Within each Worker/DO composition context, the constructed provider is reused and injected into repositories/services rather than recreated inside them.

## Logical layout and path ownership

`layout.ts`, `paths.ts`, and provider-independent artifact routing express Project OS storage conventions and governance. They are not Dropbox API adapters.

PERSIST001 moves their architectural ownership out of the Dropbox namespace into provider-independent persistence/workspace modules.

All path values must remain byte-for-byte compatible with the current Dropbox V1 layout. Examples include, without limitation:

- `/PROJECT_OS/.project-os/...` machine paths;
- `/PROJECT_OS/WORKSPACE/...` human workspace paths;
- `/PROJECT_OS/ARCHIVE/...` archived workspace paths;
- legacy transaction/receipt/project paths still required for compatibility.

The package performs no path migration and no data movement.

## Dropbox V1 schema compatibility seam

This is the critical scope boundary with IMP-SCHEMA001.

Current schema-1.0 records already persist Dropbox-shaped provider evidence. PERSIST001 must not change those structures.

The compatibility seam translates provider-neutral Dropbox runtime metadata into the exact existing schema-1.0 values and validates the reverse direction when runtime comparisons need legacy records.

It must preserve, without renaming or reinterpreting persisted fields:

- `provider_file_id`;
- `provider_rev`;
- `provider_content_hash`;
- `provider_path`;
- `ManagedProviderObservation.file_id`;
- `ManagedProviderObservation.rev`;
- `ManagedProviderObservation.content_hash`;
- `ProviderFileBindingRecord`;
- `ReferenceFingerprintRecord`;
- MutationGate provider preconditions;
- MutationGate candidate provider evidence;
- provider-derived managed-document IDs/version IDs;
- provider-derived MutationGate candidate IDs.

The compatibility seam must explicitly verify that the active production provider is Dropbox V1-compatible before producing these records. It must not pretend another provider could safely populate Dropbox-specific schema fields.

No `provider_kind`, hash-algorithm field, generalized provider ID object, or new discriminator is added to persisted schema 1.0 in this package.

## Managed-document compatibility

Managed-document runtime services must consume provider-neutral metadata and errors for provider operations.

When writing existing schema-1.0 `DocumentVersionRecord` or `ManagedDocumentHead` values, they must use the Dropbox V1 compatibility seam to preserve exact current serialized evidence.

Existing semantics remain unchanged:

- provider revision protects visible-file concurrency;
- conditional update remains true CAS;
- server-side copies remain provider-side snapshots;
- external edits continue to produce managed versions rather than silent overwrite;
- existing provider-file binding and reference fingerprint identities remain stable;
- old schema-1.0 records remain readable without migration or rewrite.

PERSIST001 does not redefine the long-term provider-neutral managed-document record format. SCHEMA001 owns that future format and any upcasting/migration strategy.

## MutationGate compatibility

MutationGate remains in `observe` throughout PERSIST001.

Its runtime provider operations move behind the neutral boundary, but all persisted schema-1.0 evidence remains unchanged.

In particular:

- `provider_precondition.kind=existing` keeps the same `file_id`, `rev`, `content_hash`, and `size` fields;
- external candidate records keep the same provider evidence fields;
- `mutationCandidateIdFor(project_id, provider_file_id, provider_rev)` remains unchanged;
- immutable candidate payload paths remain unchanged;
- candidate classification and resolution semantics remain unchanged;
- baseline and cursor-reset ordering remains unchanged;
- PERSIST001 does not repair historical PRJ-0003 deviations;
- PERSIST001 does not enable enforcement.

The compatibility seam is required because candidate identity itself currently depends on Dropbox V1 evidence. Generalizing that identity is explicitly deferred to SCHEMA001.

## Projection/materialization compatibility

Projection writers and materialization repositories must use the provider-neutral base contract and provider-neutral conflict errors.

Project OS canonical SHA-256 output hashes remain Project OS hashes and must not be conflated with provider integrity hashes.

All materialization paths, generation records, result-root hashes, output evidence, archive semantics, coalescing behavior, and recovery behavior remain unchanged.

PERSIST001 does not alter projection versioning.

## Inbox compatibility

Worker inbox processing must consume the provider-neutral provider instance created by the production factory.

The current behavior remains unchanged:

- dependency-aware transaction ordering;
- poison-entry isolation;
- safe terminal artifact creation;
- idempotent archive/replay cleanup;
- absence handling;
- no false committed receipts.

Inbox code must not import Dropbox transport or Dropbox conflict classes after PERSIST001.

## Dropbox webhook boundary

The `/dropbox/webhook` endpoint remains explicitly Dropbox-specific.

Webhook signature verification is a Dropbox ingress concern and is not generalized by this package.

After a verified Dropbox webhook wakes processing, persistence operations invoked by inbox/reconciliation must use the provider-neutral runtime boundary.

Attempting to create a generic webhook/provider event system in PERSIST001 would be false generalization and is out of scope.

## Environment and secrets

Existing Dropbox secrets remain unchanged:

- `DROPBOX_APP_KEY`;
- `DROPBOX_APP_SECRET`;
- `DROPBOX_REFRESH_TOKEN`.

PERSIST001 does not rename or migrate secrets.

No new provider-selection variable is added.

Existing Project OS continuity/layout/MutationGate configuration remains unchanged, including production `PROJECT_OS_MUTATION_GATE_MODE=observe`.

## Testing strategy

Implementation must be test-driven and preserve the existing regression suite.

The final implementation must add provider-boundary tests covering at least:

### Contract and capability tests

- base provider create/read/replace/list/move/delete semantics;
- no silent overwrite/autorename on create;
- conditional write is represented as a distinct capability;
- server-side copy is represented as a distinct capability;
- change-feed cursor/reset semantics;
- stable object ID and revision-token opacity;
- integrity hash includes semantic/algorithm identity;
- required capability absence fails before mutation.

A deterministic in-memory test double may implement the neutral contract for unit tests. It is not a production alternate provider and must not become runtime configuration.

### Dropbox adapter tests

- Dropbox metadata maps correctly to provider-neutral metadata;
- Dropbox conflict/CAS/cursor/transient errors map to neutral errors;
- retryability classification matches current validated behavior;
- Dropbox server-side copy and change feed satisfy declared capabilities;
- Dropbox V1 compatibility codec reproduces the exact current persisted values.

### Golden compatibility tests

Fixtures must prove byte/semantic compatibility for existing schema-1.0 families, including:

- managed document head/version records;
- provider-file bindings;
- reference fingerprints;
- MutationGate intents/preconditions;
- external mutation candidate records;
- candidate IDs;
- managed-document provider-derived IDs/version IDs;
- paths and layout values.

No fixture may require rewriting old data.

### Existing reliability regression

The implementation must keep green the existing tests for:

- Dropbox read/write resilience;
- fault injection;
- commit/receipt ordering;
- recovery;
- inbox replay/cleanup/isolation;
- materialization faults/reconciliation;
- managed-document concurrency/external edits;
- MutationGate candidate/classification/fault/status behavior;
- MODEL001 lifecycle/concurrency semantics;
- historical schema-1.0 readability.

## Static boundary acceptance checks

At completion, source-level checks must prove that outside the Dropbox provider adapter, Dropbox webhook code, Dropbox V1 compatibility seam, and production factory, Project OS Core does not import or reference:

- `DropboxClient`;
- `DropboxTransport`;
- `DropboxConflictError`;
- `DropboxApiError`;
- `DropboxCursorResetError`;
- Dropbox retry parsing/status helpers.

Provider-independent repositories, managed documents, MutationGate, materialization, inbox code, ProjectGuard, and RegistryGuard must compile against provider-neutral interfaces.

Direct `new DropboxClient(...)` must exist only in the authoritative production factory or adapter-internal tests.

## Dependencies

### IMP-MODEL001

Satisfied. PERSIST001 is validated against the completed MODEL001 baseline on `main` merge `946337526c8da541db00cd4ec5ff76207e6295a6`.

### IMP-MUTATIONGATE001

Not a blocking prerequisite for the runtime boundary, but a high-value compatibility surface.

PERSIST001 may refactor MutationGate provider plumbing only while preserving its existing schema-1.0 record families, candidate identity, provenance behavior, recovery behavior, and `observe` mode.

No enforcement activation is authorized.

### IMP-SCHEMA001

A deferred hard dependency for provider-neutral persisted evidence and any alternate provider.

PERSIST001 can complete the runtime abstraction before SCHEMA runtime begins. However, no non-Dropbox provider may be production-enabled for provider-evidence-dependent flows until SCHEMA001 defines and validates the generalized persisted model, compatibility policy, and migrations/upcasters.

### PRJ-0003 deviation repair

No dependency for PERSIST001 and explicitly out of scope.

### IMP-INDEX001

Downstream. INDEX001 should consume provider-neutral persistence/read interfaces rather than couple itself directly to Dropbox.

## Rollout invariants

When implementation is later authorized:

- continuity remains stable unless separately changed by its own approved package;
- MutationGate remains observe;
- no schema migration runs;
- no PRJ-0003 repair runs;
- no SCHEMA runtime runs;
- no alternate provider is enabled;
- exact current Dropbox paths and schema-1.0 records remain compatible;
- production proof must use normal typed Project OS operations and historical read checks;
- rollback is code/config rollback only, never canonical history rewrite.

## Completion criteria

IMP-PERSIST001 runtime implementation is not complete until all of the following are proven:

1. provider-neutral runtime contracts and errors are in place;
2. capabilities are explicit and semantically tested;
3. provider construction is centralized through the production factory;
4. Core/repository/service imports no longer depend directly on Dropbox runtime types/errors;
5. logical layout/path ownership is provider-independent with identical persisted values;
6. Dropbox V1 compatibility seam preserves every existing schema-1.0 provider-shaped record and derived identity;
7. the full relevant regression suite is green;
8. `npm run check` is green at the exact final PR head;
9. deployment, health, and production proof are separately authorized and successful;
10. MutationGate is still observe;
11. no PRJ-0003 repair or SCHEMA runtime action occurred;
12. canonical PRJ-0002 evidence and task closure are recorded only after production proof.

## Deferred follow-up owned by IMP-SCHEMA001

The following are intentionally deferred and must not leak back into PERSIST001:

- generalized provider evidence fields;
- provider-kind discriminators in durable records;
- algorithm-aware persisted provider integrity hashes;
- generic provider object IDs/revision-token schemas;
- generic MutationGate preconditions/candidates;
- new candidate identity semantics;
- managed-document provider-state schema redesign;
- old-record upcasters;
- migrations;
- compatibility cutover strategy for a second provider.

Only after those schema concerns are explicitly designed, migrated, and proven may a separate package production-enable a provider other than Dropbox.

## Final design statement

PERSIST001 establishes a **real provider-neutral runtime boundary** while preserving **Dropbox V1 as the only production provider and the exact schema-1.0 persisted contract**.

The package succeeds by separating three concerns that are currently conflated:

1. Project OS logical persistence behavior;
2. provider runtime capabilities/errors/resilience;
3. historical Dropbox-shaped schema-1.0 compatibility.

It does not solve future provider-neutral persistence schemas. That boundary is deliberate, testable, and required to avoid performing IMP-SCHEMA001 implicitly inside a persistence refactor.
