# IMP-PERSIST001 — Persistence Provider Boundary Design

## Status

Design validated by the user on 2026-08-26 after revalidation against canonical PRJ-0002 revision 92 and GitHub `main` at merge commit `946337526c8da541db00cd4ec5ff76207e6295a6`.

This document authorizes design/specification only. It does not authorize runtime implementation, deployment, MutationGate enforcement, PRJ-0003 repair, SCHEMA runtime work, schema migration, or any alternate persistence provider.

## Purpose

Introduce a real provider-neutral **runtime** persistence boundary while keeping Dropbox as the only production persistence provider in this package.

PERSIST001 removes Dropbox-specific operational coupling from Project OS Core, repositories, materialization, managed documents, MutationGate, inbox processing, ProjectGuard, and RegistryGuard. At the same time, it preserves every existing schema-1.0 persisted record and Dropbox V1 compatibility exactly.

The package explicitly does **not** make historical serialized provider evidence provider-neutral. Generalizing persisted `provider_*` fields, MutationGate provider preconditions/candidates, provider-derived IDs, migrations, or upcasters remains owned by IMP-SCHEMA001.

## Architecture decision

Adopt **Option B — provider-neutral runtime boundary with an explicit Dropbox V1 schema compatibility seam**.

```text
Domain / Project OS services
          |
          v
src/persistence/*
  - logical layout and paths
  - repositories
  - provider-neutral contracts
  - provider-neutral errors
  - explicit capability requirements
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

Persisted provider-shaped schema-1.0 evidence remains isolated:

```text
provider-neutral runtime metadata/evidence
          |
          v
Dropbox V1 schema compatibility seam
          |
          v
existing schema-1.0 fields and identities
```

PERSIST001 therefore makes **execution** provider-neutral, not the historical durable format.

## Baseline and hard constraints

The design is validated against:

- canonical PRJ-0002 revision 92 at design validation;
- `main` merge commit `946337526c8da541db00cd4ec5ff76207e6295a6`;
- production layout mode `v2`;
- continuity mode `stable`;
- MutationGate mode `observe`.

PERSIST001 must preserve these constraints:

- Dropbox remains the sole production provider.
- No SharePoint, Google Drive, S3, filesystem, or other provider is added.
- No local filesystem provider, desktop daemon, PC bridge, or direct PC dependency is added.
- No provider-selection environment variable or dynamic provider registry is added.
- No data migration or rewrite is performed.
- No schema version is bumped.
- No schema upcaster is introduced.
- No persisted path value changes.
- No existing schema-1.0 record shape, field, regex contract, provider-derived ID, or provider evidence is generalized.
- MutationGate remains `observe`.
- PRJ-0003 repair does not run.
- SCHEMA runtime does not run.
- Continuity rollout mode does not change.
- Retry budgets are not retuned as part of this package.

## Current coupling being removed

The current `DropboxTransport` is not a true provider boundary. It combines base object operations, optional capability methods, Dropbox metadata (`id`, `rev`, `content_hash`), and Dropbox-specific error semantics.

`ResilientDropboxTransport` additionally owns Dropbox HTTP retry classification and catches `DropboxConflictError` for recovery behavior. Multiple repositories/services independently create resilient wrappers.

Direct `DropboxClient` construction currently occurs in multiple runtime composition locations, including Worker/admin helpers and Durable Object constructors.

Provider-independent Project OS concepts such as logical layout, paths, artifact routing, and repositories also live under `src/dropbox/`, which makes the namespace itself falsely provider-specific.

PERSIST001 must remove these forms of coupling rather than merely rename them.

## Target source ownership

The implementation plan may refine filenames, but ownership and dependency direction must follow this shape:

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

Provider-independent artifact routing belongs with Project OS persistence/workspace governance, not the Dropbox adapter.

Moving source files must not change any persisted `/PROJECT_OS/...` path value.

## Provider-neutral base contract

The provider boundary represents a hierarchical Project OS object namespace. Paths are Project OS persistence paths; they are not declared to be local filesystem paths.

The base contract must preserve the operations and semantics used by current production flows:

- read a text object and return absence explicitly;
- create a text object with **create-only** semantics, without silent overwrite or autorename;
- **upsert/overwrite** a text object, creating it when absent and replacing it when present, preserving the current Dropbox `overwrite` behavior used by mutable heads/snapshots/views;
- read object metadata and return absence explicitly;
- list immediate children, returning the current empty/missing semantics expected by callers;
- move/rename without silently overwriting a destination;
- delete idempotently when the object is absent.

Provider operations return provider-neutral metadata where applicable. Core callers must not parse provider-specific HTTP responses or error payloads.

A provider adapter must never emulate an unsupported strong guarantee with a weaker sequence and advertise it as equivalent.

## Provider-neutral metadata

Runtime metadata uses provider-neutral concepts:

```text
path
size
modifiedAt?
objectId?
revisionToken?
integrityHash?
```

`objectId` and `revisionToken` are opaque strings. Core code must not parse or rely on Dropbox formats.

`integrityHash` carries semantic/algorithm identity plus value, conceptually:

```text
algorithm
value
```

The Core must not assume Dropbox `content_hash` is SHA-256 or interchangeable with Project OS canonical SHA-256 content hashes.

For Dropbox production, the adapter maps Dropbox `id`, `rev`, and `content_hash` into this neutral representation.

## Explicit provider capabilities

Capabilities are semantic contracts, not booleans with vague meaning and not optional transport methods probed throughout business code.

PERSIST001 makes these six capabilities explicit:

1. **conditional write**;
2. **server-side copy**;
3. **incremental change feed**;
4. **stable object ID**;
5. **revision token**;
6. **integrity hash**.

### Conditional write

A conditional write is true provider-side compare-and-swap against an opaque revision token.

`read metadata -> compare locally -> ordinary overwrite` is not equivalent and must not be advertised as this capability.

### Server-side copy

A server-side copy duplicates/snapshots an object within provider storage without downloading and re-uploading the payload through Project OS.

PERSIST001 must not silently substitute a client-side copy for managed-document or MutationGate snapshot operations, including opaque/binary payloads.

### Incremental change feed

The provider supplies an opaque cursor, continuation from that cursor, file/folder/deletion observations required by current reconciliation, and an explicit cursor-reset condition.

### Stable object ID

The provider supplies an opaque object identity stable under the rename/move semantics relied on by current Dropbox V1 managed-document and MutationGate records.

### Revision token

The provider supplies an opaque version token suitable for equality and conditional-write preconditions. Core code does not inspect its internal representation.

### Integrity hash

The provider supplies content-integrity evidence with identified semantics/algorithm. Neutral runtime equality requires compatible semantics plus equal value.

## Capability binding rules

Runtime consumers must not detect capabilities via `if (transport.copy)`, `if (transport.uploadConditional)`, or equivalent optional-method checks.

Capabilities are bound and validated at construction/composition time. Services receive the typed capability ports they require, or a prepared runtime bundle that has already passed fail-fast capability assertions.

Examples:

- ordinary canonical repository operations require the base object contract;
- managed-document publication/update requires conditional write plus revision-token capability;
- provider snapshots require server-side copy;
- managed-document reconciliation requires incremental change feed;
- Dropbox V1 managed-document and MutationGate compatibility requires stable object ID, revision token, and Dropbox-compatible integrity evidence.

Because Dropbox is the only production provider in PERSIST001 and all current features are enabled, production composition must validate the complete required Dropbox capability profile before business mutation begins.

A future provider lacking a required capability cannot be activated merely because it implements the base interface.

## Provider-neutral error model

Core runtime consumers must no longer import or catch:

- `DropboxConflictError`;
- `DropboxApiError`;
- `DropboxCursorResetError`;
- raw Dropbox HTTP status codes or Dropbox response-body strings.

The provider boundary exposes neutral error categories sufficient for existing behavior, including at least:

- provider operation failure with retryable/terminal classification;
- create/destination conflict;
- conditional-write/precondition failure;
- change-cursor reset;
- unsupported/missing capability.

Not-found cases remain normal absence where current semantics use absence rather than failure.

Provider-specific diagnostics such as HTTP status, Dropbox request ID, or provider error code may be retained as opaque observability detail, but Core branching must not depend on them.

The Dropbox adapter owns mapping raw Dropbox failures to these neutral categories. A Dropbox conditional 409 becomes a provider-neutral precondition/CAS failure before managed-document business logic sees it.

## Resilience and retry boundary

PERSIST001 separates provider-specific error normalization from generic retry behavior.

The Dropbox adapter owns:

- OAuth/token refresh;
- Dropbox HTTP requests;
- parent-folder creation behavior;
- Dropbox conflict/cursor-reset recognition;
- raw error mapping;
- Dropbox-specific operation normalization required to satisfy the neutral contract.

A provider-neutral resilience decorator owns bounded retries using only neutral error information such as `retryable`.

The refactor must preserve the currently validated production behavior:

- bounded attempts;
- current base backoff behavior;
- jitter behavior;
- fail-closed terminal semantics;
- current logging/correlation intent;
- move/archive/replay idempotency behavior.

PERSIST001 is not a retry-tuning or performance package.

If move recovery depends on Dropbox-specific API collision behavior, that normalization belongs in the Dropbox adapter rather than leaking Dropbox error classes into Core.

## Centralized production composition

Introduce one authoritative production construction path, conceptually:

```text
createProductionPersistence(env)
```

The exact name may be refined in the implementation plan, but the architectural rule is fixed:

- it is the only ordinary production location that knows Dropbox credential names and constructs the Dropbox client/adapter;
- it creates the provider-neutral Dropbox adapter;
- it applies the provider-neutral resilience layer exactly once;
- it validates the production capability profile;
- it returns a provider-neutral runtime/bundle for injection.

PERSIST001 does not add `PROJECT_OS_PROVIDER` or another provider selector. The factory always builds Dropbox.

Cloudflare Durable Objects are platform-created and cannot receive an instantiated provider from the outer Worker. Their constructors may call the same authoritative factory with `env`; this is centralized construction because direct `new DropboxClient(...)` remains forbidden outside the factory.

Within a composition context:

- `ProjectGuard` creates the prepared runtime once and injects it into its repository, managed-document services, change coordinator, and materialization writer;
- `RegistryGuard` uses the same factory path once for its context;
- Worker/admin/inbox flows use the same factory path rather than constructing Dropbox directly;
- lower-level services do not add their own resilience wrappers.

## Logical layout and path ownership

`layout.ts`, `paths.ts`, and provider-independent artifact routing express Project OS storage conventions/governance, not Dropbox API behavior.

PERSIST001 moves their architectural ownership out of the Dropbox namespace.

Every generated legacy and V2 path string remains byte-for-byte identical to current `main`, including:

- `/PROJECT_OS/.project-os/...` machine paths;
- `/PROJECT_OS/WORKSPACE/...` workspace paths;
- `/PROJECT_OS/ARCHIVE/...` archive paths;
- legacy transaction, receipt, registry, event, decision, and project paths.

No Dropbox data is renamed, moved, rewritten, or migrated.

## Dropbox V1 schema compatibility seam

This is the critical boundary with IMP-SCHEMA001.

Existing schema-1.0 records already persist Dropbox-shaped provider evidence. PERSIST001 may translate neutral runtime metadata into those exact values, but it must not generalize them.

The compatibility seam consumes **provider-neutral runtime metadata** and existing domain records. It may know Dropbox V1 persisted value constraints and validation rules, but it must **not** import or depend on raw `DropboxClient`, `DropboxTransport`, Dropbox API error classes, or Dropbox retry helpers. Raw runtime Dropbox behavior belongs only in the Dropbox provider adapter/composition layer.

The seam preserves exactly:

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
- `documentIdForProviderFile` behavior;
- external version IDs derived from provider revision;
- MutationGate candidate IDs derived from `(project_id, provider_file_id, provider_rev)`;
- all existing schema-1.0 field optionality, regex constraints, and path semantics.

The compatibility seam must fail explicitly if asked to produce Dropbox V1 records from runtime evidence that is not Dropbox V1-compatible.

No persisted `provider_kind`, hash-algorithm field, generalized provider token object, discriminator, or schema-2 envelope is introduced by PERSIST001.

## Managed-document compatibility

Managed-document runtime code moves to provider-neutral ports/errors for metadata lookup, create/upsert, true CAS, move/copy lifecycle operations, provider snapshots, and external-change reconciliation.

Business-level managed-document conflicts remain business conflicts. Provider CAS failures are translated into existing managed-document conflict outcomes without catching Dropbox error classes.

When writing existing schema-1.0 `DocumentVersionRecord`, `ManagedDocumentHead`, provider-file binding, or reference fingerprint data, the service uses the Dropbox V1 compatibility seam and preserves current serialized evidence exactly.

Existing semantics remain unchanged:

- provider revision protects visible-file concurrency;
- conditional update remains true CAS;
- server-side copies remain provider-side snapshots;
- external edits produce versions rather than silent overwrite;
- provider-file binding and reference fingerprint identity remain stable;
- historical schema-1.0 records remain readable without migration/rewrite.

PERSIST001 does not define the future provider-neutral managed-document record format.

## MutationGate compatibility

MutationGate remains `observe` throughout PERSIST001.

Runtime provider operations move behind neutral ports/errors for:

- provider precondition observation;
- change-feed entries;
- candidate metadata;
- provider-side candidate snapshot copy;
- metadata verification;
- collision/idempotency handling.

The following remain unchanged:

- mutation intent schema;
- provider precondition schema;
- external candidate schema;
- candidate identity derivation;
- detection-source vocabulary;
- candidate resolution semantics;
- append-only evidence behavior;
- baseline/cursor-reset ordering;
- immutable candidate payload paths.

PERSIST001 does not repair PRJ-0003 and does not enable enforcement.

Candidate identity currently depends directly on Dropbox V1 evidence, so its generalization is explicitly deferred to SCHEMA001.

## Projection/materialization compatibility

Projection writers and materialization repositories consume the neutral base contract and neutral conflict categories.

Project OS canonical SHA-256 output hashes remain Project OS hashes. Provider integrity hashes must not replace or reinterpret them.

Materialization paths, generation records, output evidence, result-root hashes, projection version, archive semantics, coalescing, recovery, and critical-output verification remain unchanged.

## Inbox and canonical repository compatibility

Inbox processing and canonical repositories consume neutral persistence operations/errors while preserving:

- transaction filename binding;
- dependency-aware inbox ordering;
- poison-entry isolation;
- immutable terminal records;
- receipt-gated canonical success;
- idempotent source archival/replay cleanup;
- canonical commit ordering/recovery;
- no false committed receipts.

No inbox/Core path may catch `DropboxConflictError` after PERSIST001.

## Dropbox webhook boundary

`/dropbox/webhook` remains explicitly Dropbox-specific.

Webhook signature verification and Dropbox HMAC semantics are inbound integration concerns, not repository abstractions. Neutralizing them in PERSIST001 would be false generalization.

After webhook verification, triggered Project OS work uses the neutral production persistence runtime.

## Environment and credentials

Existing Dropbox bindings remain unchanged:

- `DROPBOX_APP_KEY`;
- `DROPBOX_APP_SECRET`;
- `DROPBOX_REFRESH_TOKEN`.

PERSIST001 adds no generic provider credentials or provider-selection configuration.

Credential/permission redesign remains outside this package.

## Dependency boundaries

### IMP-MODEL001

Satisfied prerequisite. PERSIST001 is validated against the merged MODEL001 baseline.

### IMP-MUTATIONGATE001

Not a blocking prerequisite for the runtime boundary, but MutationGate is an affected high-risk consumer and its full regression suite is mandatory.

PERSIST001 does not alter MutationGate rollout mode or authorize enforcement.

### IMP-SCHEMA001

Deferred hard dependency for persisted provider generalization and any future non-Dropbox activation, not a prerequisite for runtime decoupling.

PERSIST001 establishes the runtime seam now. SCHEMA001 remains responsible for provider-aware durable models, compatibility policies, migrations, and upcasting.

### PRJ-0003 repair

No dependency. PERSIST001 neither triggers nor performs the repair.

### IMP-INDEX001

Downstream beneficiary. INDEX001 should consume provider-neutral persistence/read interfaces rather than bind directly to Dropbox.

## Non-goals summary

PERSIST001 does not:

- implement an alternate provider;
- prove an alternate provider works;
- add provider selection UI/configuration;
- migrate or rewrite data;
- bump schemas;
- generalize schema-1.0 provider evidence;
- change business lifecycle semantics;
- change canonical commit semantics;
- change materialization record formats;
- activate MutationGate enforcement;
- repair PRJ-0003;
- start SCHEMA runtime;
- redesign Dropbox webhook authentication;
- retune performance/retry policy beyond behavior-preserving refactoring.

## Required tests

Implementation must be test-driven and preserve the complete relevant regression suite.

### Architecture boundary checks

Add an enforceable dependency/static check proving that raw Dropbox runtime types are confined to the Dropbox provider implementation and authoritative production composition.

After PERSIST001, provider-independent repositories, managed documents, MutationGate, materialization, inbox code, ProjectGuard, and RegistryGuard must not import or reference:

- `DropboxClient`;
- `DropboxTransport`;
- `DropboxConflictError`;
- `DropboxApiError`;
- `DropboxCursorResetError`;
- Dropbox retry parsing/status helpers.

Dropbox webhook code may remain Dropbox-specific for HMAC/route semantics, but it should not become a back door for repository/runtime Dropbox dependencies.

The Dropbox V1 compatibility seam may contain Dropbox V1 **serialized-format** terminology/validators, but it consumes neutral runtime metadata and must not import raw Dropbox client/transport/error/retry classes.

Direct `new DropboxClient(...)` must exist only in the authoritative production factory or adapter-internal tests.

### Provider contract/capability tests

Test neutral semantics for:

- create-only collision;
- upsert/overwrite create-when-absent and replace-when-present behavior;
- absent read/metadata;
- direct-child listing and missing-root behavior;
- move conflict;
- idempotent delete;
- conditional-write success/failure;
- server-side copy;
- change-feed continuation and cursor reset;
- metadata identity/revision/hash mapping;
- missing required capability fail-fast behavior.

A deterministic in-memory test double may implement the neutral interfaces for unit tests. It is not a production provider and must not become runtime configuration.

### Dropbox adapter tests

Preserve/migrate tests proving:

- token/API behavior;
- parent-folder creation;
- conflict and CAS mapping;
- cursor-reset mapping;
- transient error classification;
- bounded retry behavior;
- move/idempotency recovery;
- server-side copy capability;
- change-feed capability;
- no silent autorename.

### Golden schema-1.0 compatibility tests

Before/after fixtures must prove exact durable compatibility for representative:

- managed-document version records;
- managed-document heads/provider observations;
- provider-file bindings;
- reference fingerprints;
- MutationGate intents/provider preconditions;
- external mutation candidates;
- candidate IDs;
- provider-derived managed-document IDs/version IDs.

A runtime refactor that changes these durable values fails PERSIST001.

### Path golden tests

All legacy and V2 path helpers must produce exactly the same strings as current `main`.

### Full regression suite

Existing commit consistency, recovery, rollback, inbox, materialization, artifacts, managed documents, MutationGate, MODEL001 lifecycle/concurrency, fault injection, and Dropbox resilience tests remain green.

## Acceptance criteria

PERSIST001 implementation is acceptable only when all of the following hold:

1. Dropbox remains the only production provider.
2. Runtime repositories/services use provider-neutral contracts/errors.
3. Core runtime consumers no longer import Dropbox transport/error/client classes.
4. Raw Dropbox HTTP/status/body semantics do not drive Core branching.
5. Capabilities are explicit, semantic, typed/fail-fast, and not inferred from optional methods.
6. Production provider construction is centralized through one authoritative assembly path.
7. Lower-level services do not construct Dropbox clients or resilience wrappers.
8. Logical layout/path/repository ownership is provider-independent while every persisted path value remains unchanged.
9. The compatibility seam consumes neutral metadata, not raw Dropbox runtime classes.
10. Existing schema-1.0 managed-document and MutationGate formats/IDs remain unchanged.
11. No migration, upcasting, or schema bump occurs.
12. MutationGate remains `observe`.
13. PRJ-0003 repair is not run.
14. SCHEMA runtime is not run.
15. Full CI/regression tests are green at the exact final PR head.
16. Production validation is separately authorized and completed at an exact merged commit before canonical task closure.

## Production validation boundary

The later implementation plan must define a production proof isolated from PRJ-0003 and SCHEMA runtime.

At minimum it must demonstrate through normal Project OS paths:

- production health and continuity remain stable;
- MutationGate reports `observe`;
- historical schema-1.0 project state remains readable without migration/rewrite;
- an isolated synthetic `PRJ-AUTO` project can commit/recover through the neutral repository path;
- projection/materialization reaches a verified current head;
- managed-document create/update/CAS behavior works with Dropbox V1 evidence preserved;
- incremental change-feed reconciliation still works;
- no PRJ-0003 repair or SCHEMA runtime action occurred.

Exact merge SHA and deployment evidence are required for closure.

## Rollback principle

PERSIST001 is a runtime/source boundary refactor with no data migration.

Rollback is code/config rollback through the existing continuity/deployment mechanism. Canonical history and schema-1.0 records are never rewritten to emulate rollback.

Because persisted paths and schemas do not change, reverting runtime code must leave Dropbox V1 data directly consumable by the pre-PERSIST implementation.

## Deferred SCHEMA handoff

PERSIST001 leaves an explicit seam for SCHEMA001 rather than hidden coupling.

SCHEMA001 may later decide how to evolve durable provider evidence, including possible provider discriminators, provider-neutral object identity/revision-token representation, algorithm-aware integrity hashes, Dropbox V1 upcasting, migration/cutover rules, and generalized MutationGate provider evidence.

Those structures are deliberately **not** designed or implemented by PERSIST001 beyond preserving the seam where future translation can occur.

## Final architectural invariant

After PERSIST001, adding a future provider should require a new provider adapter plus separately approved schema/provider compatibility work where durable evidence demands it. It must not require rewriting Project OS business logic merely to replace `DropboxClient`, Dropbox error classes, Dropbox retry parsing, or Dropbox-specific optional transport methods.

That is the success condition for this package.
