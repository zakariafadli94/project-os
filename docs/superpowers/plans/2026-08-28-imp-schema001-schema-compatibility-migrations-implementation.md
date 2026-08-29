# IMP-SCHEMA001 — Schema Compatibility and Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Architecture A2 so Project OS can read mixed durable schema generations indefinitely, write ProjectState/manifest and provider-bearing records as V2 behind monotonic rollout gates, and recover/rollback safely without rewriting immutable history.

**Architecture:** Add explicit per-family codecs at durable boundaries: strict parser for each serialized version, pure deterministic upcast to the current semantic model, and one active writer version per family controlled by a monotonic `v1_only -> core_v2 -> provider_v2` stage. Keep commit/transaction/event/receipt/registry/materialization envelopes at 1.0, keep `projection_version = 1`, preserve all historical IDs and V1 records, and make deployment authority R0 a hard precondition before any production V2 writer activation.

**Tech Stack:** TypeScript 5.9, Zod 4.4, Vitest 4.1, Cloudflare Workers/Durable Objects, provider-neutral persistence boundary with Dropbox production provider.

**Spec:** `docs/superpowers/specs/2026-08-28-imp-schema001-schema-compatibility-migrations-design.md`

## Global Constraints

- Family-versioned durable schemas; no global `PROJECT_OS_SCHEMA_VERSION`.
- Unknown future versions fail closed; malformed known versions fail closed.
- Every emitted durable version remains readable indefinitely unless explicitly deprecated later.
- No write-on-read and no business revision/event solely for representation conversion.
- Immutable commits/events/receipts/document versions/MutationGate evidence are never bulk rewritten.
- `CanonicalCommitRecord`, `Transaction`, `DomainEvent`, canonical `Receipt`, registry, materialization records stay schema 1.0 in IMP-SCHEMA001.
- `projection_version` remains `1` unless projection semantics change separately.
- Existing Dropbox-derived IDs (`DOC-*`, `VER-*`, `MUTINT-*`, `MUTCAND-*`, `MUTRES-*`) are preserved exactly across V1/V2.
- Dropbox `content_hash` maps to provider integrity algorithm `dropbox-content-hash`; never relabel it as canonical SHA-256.
- Rollout stages are exactly `v1_only -> core_v2 -> provider_v2` and cannot regress after the corresponding durable frontier is crossed.
- MutationGate stays `enforce` throughout rollout.
- R0 deployment-authority safety is mandatory before the first production V2 durable write.
- Prefer additive transactional Durable Object SQL migration; do not destructively rebuild unreconciled in-flight allocator/request state.

---

## File map

New focused codec modules should live under `src/schema/` so historical serialization concerns do not leak into business services:

- `src/schema/version.ts` — common version dispatch/result/error primitives and writer-stage type.
- `src/schema/project-state.ts` — strict ProjectState V1/V2 parsers, V1->current upcast, V2 encoder.
- `src/schema/manifest.ts` — manifest V1/V2 codecs and state-schema pointer validation.
- `src/schema/provider-evidence.ts` — provider-neutral observation schema plus Dropbox V1 upcast.
- `src/schema/managed-document.ts` — ManagedDocumentHead/DocumentVersionRecord V1/V2 codecs.
- `src/schema/mutation-gate.ts` — artifact-intent/external-candidate V1/V2 codecs.
- `src/schema/writer-stage.ts` — stage parsing, frontier guards, and monotonic activation checks.

Existing integration points remain in their current modules, notably `src/domain/project-state-normalizer.ts`, `src/domain/commit-record.ts`, `src/domain/managed-document.ts`, `src/domain/mutation-gate.ts`, `src/durable/project-guard-neutral.ts`, `src/durable/project-guard-mutation-gate.ts`, managed-document repositories/services under `src/documents/`, materialization code under `src/materialization/`, and deployment/runtime entrypoints under `src/index-neutral.ts` / `src/env.ts`.

Tests should be grouped under `test/schema/` for codec contracts plus targeted existing integration suites (`test/commit-record.spec.ts`, `test/commit-repository.spec.ts`, `test/project-guard-commit-compat.spec.ts`, managed-document tests, MutationGate tests, recovery tests, and materialization tests).

---

### Task 1: Establish schema codec primitives and writer-stage contract

**Files:**
- Create: `src/schema/version.ts`
- Create: `src/schema/writer-stage.ts`
- Create: `test/schema/version.spec.ts`
- Create: `test/schema/writer-stage.spec.ts`
- Modify: `src/env.ts`

**Interfaces:**
- Produces: `type DurableSchemaVersion = "1.0" | "2.0"`
- Produces: `type SchemaWriterStage = "v1_only" | "core_v2" | "provider_v2"`
- Produces: `unsupportedSchemaVersion(family, version): Error`
- Produces: `assertWriterStageAtLeast(actual, required): void`
- Produces: `assertNoWriterStageRegression(previous, next): void`

- [ ] **Step 1: Write failing tests for exact stage ordering and unsupported-version failures.**

```ts
expect(() => assertNoWriterStageRegression("core_v2", "v1_only")).toThrow();
expect(() => assertWriterStageAtLeast("v1_only", "core_v2")).toThrow();
expect(() => unsupportedSchemaVersion("ProjectState", "3.0")).toThrow(/ProjectState.*3\.0/);
```

- [ ] **Step 2: Run `npx vitest run test/schema/version.spec.ts test/schema/writer-stage.spec.ts` and confirm failure.**
- [ ] **Step 3: Implement the minimal primitives and env parsing, defaulting production behavior to `v1_only`.**
- [ ] **Step 4: Re-run the two tests and `npm run typecheck`.**
- [ ] **Step 5: Commit `feat(schema): add codec version and writer stage primitives`.**

### Task 2: Implement strict ProjectState V1/V2 codecs and pure migration

**Files:**
- Create: `src/schema/project-state.ts`
- Create: `test/schema/project-state.spec.ts`
- Modify: `src/domain/project-state-normalizer.ts`

**Interfaces:**
- Produces: `readProjectState(input: unknown): { sourceVersion: "1.0" | "2.0"; state: ProjectState }`
- Produces: `encodeProjectState(state: ProjectState, stage: SchemaWriterStage): unknown`
- Produces: `migrateProjectStateV1ToCurrent(v1): ProjectState`

- [ ] **Step 1: Add fixtures covering sparse historical V1, modern V1, strict V2, malformed 1.0/2.0, and unknown 3.0.**
- [ ] **Step 2: Write semantic-preservation tests asserting exact IDs, revision, timestamps, lifecycle meaning, `last_event_id`, aliases/objective/framing/discovery/routes, and legacy deliverable mappings (`pending -> planned`, `completed -> legacy_completed`).**
- [ ] **Step 3: Verify the tests fail before the codec exists.**
- [ ] **Step 4: Move existing compatibility normalization behind the V1 parser/upcaster instead of letting callers normalize arbitrary parsed JSON.**
- [ ] **Step 5: Add a strict V2 serialized schema equal to the current formal ProjectState model; do not add new business fields.**
- [ ] **Step 6: Implement writer behavior: `v1_only` emits V1-compatible state, `core_v2`/`provider_v2` emits strict 2.0; if current durable state is already V2, a requested V1 writer regression must fail closed.**
- [ ] **Step 7: Run `npx vitest run test/schema/project-state.spec.ts` plus existing model/lifecycle tests.**
- [ ] **Step 8: Commit `feat(schema): add ProjectState V1 V2 codec`.**

### Task 3: Decouple and version the machine manifest

**Files:**
- Create: `src/schema/manifest.ts`
- Create: `test/schema/manifest.spec.ts`
- Modify: manifest read/write call sites in `src/durable/project-guard-neutral.ts`

**Interfaces:**
- Produces: `readManifest(input: unknown): CurrentManifest`
- Produces: `encodeManifest(state: ProjectState, stage: SchemaWriterStage): unknown`

- [ ] **Step 1: Add a V1 manifest fixture matching current production and a V2 fixture with exactly `schema_version`, `project_id`, `slug`, `revision`, `status`, `last_event_id`, `project_state_schema_version`, `updated_at`.**
- [ ] **Step 2: Add tests that V2 rejects an inconsistent `project_state_schema_version`, malformed fields, or unknown future manifest version.**
- [ ] **Step 3: Implement V1 read compatibility and independent V2 writer semantics.**
- [ ] **Step 4: Integrate snapshot convergence so a legitimate later write may produce V2 manifest/state at the same business revision without creating a transaction/event solely for conversion.**
- [ ] **Step 5: Run manifest tests and affected ProjectGuard persistence tests.**
- [ ] **Step 6: Commit `feat(schema): version project manifest independently`.**

### Task 4: Route canonical commit, receipt, transaction, event and recovery reads through family codecs

**Files:**
- Modify: `src/domain/commit-record.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: receipt/transaction/event repository parsing sites discovered during implementation
- Modify: `test/commit-record.spec.ts`
- Modify: `test/commit-repository.spec.ts`
- Modify: `test/project-guard-commit-compat.spec.ts`
- Add/modify: total SQLite-loss recovery tests

**Interfaces:**
- Consumes: `readProjectState()`
- Produces: commit-envelope parser that keeps envelope schema 1.0 while delegating nested ProjectState versioning.

- [ ] **Step 1: Add a failing commit fixture for envelope 1.0 + state 2.0 and a mixed contiguous chain crossing V1->V2.**
- [ ] **Step 2: Add failure tests for malformed nested state, revision/transaction/event/receipt binding mismatch, and unknown nested version.**
- [ ] **Step 3: Replace direct `JSON.parse(...) as Type` / manual schema-version shortcuts for in-scope canonical families with their family reader.**
- [ ] **Step 4: Keep Transaction, DomainEvent, Receipt and commit envelope serialized at 1.0; do not extend their closed operation unions in this package.**
- [ ] **Step 5: Prove total ProjectGuard SQLite loss reconstructs identical business state from mixed chains, including crash after immutable commit publication but before snapshot/local persistence.**
- [ ] **Step 6: Run `npx vitest run test/commit-record.spec.ts test/commit-repository.spec.ts test/project-guard-commit-compat.spec.ts` plus the recovery suite.**
- [ ] **Step 7: Commit `refactor(schema): centralize canonical family reads`.**

### Task 5: Add provider-neutral durable evidence codec

**Files:**
- Create: `src/schema/provider-evidence.ts`
- Create: `test/schema/provider-evidence.spec.ts`
- Modify provider metadata types only where needed to share the neutral observation shape

**Interfaces:**
- Produces: `ProviderObservation { provider_id; path; object_id; revision_token; integrity_hash: { algorithm; value }; size }`
- Produces: `upcastDropboxV1Observation(v1): ProviderObservation`

- [ ] **Step 1: Write exact mapping tests: Dropbox `file_id/object id`, `rev/revision token`, `content_hash -> {algorithm:"dropbox-content-hash", value}`, path and size.**
- [ ] **Step 2: Add explicit tests proving Dropbox content hash is not accepted as canonical `content_sha256` and hash equality includes algorithm.**
- [ ] **Step 3: Implement a strict complete observation schema; reject partial serialized provider observations.**
- [ ] **Step 4: Run the focused tests and `npm run check:persistence-boundary`.**
- [ ] **Step 5: Commit `feat(schema): add provider neutral durable evidence`.**

### Task 6: Implement ManagedDocumentHead and DocumentVersionRecord V1/V2 codecs

**Files:**
- Create: `src/schema/managed-document.ts`
- Create: `test/schema/managed-document.spec.ts`
- Modify: `src/domain/managed-document.ts`
- Modify relevant repositories/services under `src/documents/`
- Modify existing managed-document recovery/concurrency tests

**Interfaces:**
- Produces: `readManagedDocumentHead()` / `encodeManagedDocumentHead()`
- Produces: `readDocumentVersionRecord()` / `encodeDocumentVersionRecord()`
- Consumes: `ProviderObservation`, `SchemaWriterStage`

- [ ] **Step 1: Add V1 head/version fixtures and strict V2 fixtures matching the spec shapes.**
- [ ] **Step 2: Add a V1->V2 mixed causal chain test (`VER-A 1.0 -> VER-B 1.0 -> VER-C 2.0`) and verify deterministic head reconstruction.**
- [ ] **Step 3: Assert lifecycle pointers/stage/kind/logical path/parent/request bindings and immutable payload identity are unchanged by upcast.**
- [ ] **Step 4: Implement V2 encoders only for `provider_v2`; `v1_only` and `core_v2` continue provider-bearing V1 writes.**
- [ ] **Step 5: Keep managed-document request intent/receipt at 1.0 and preserve request hash/idempotency.**
- [ ] **Step 6: Run managed-document, external-edit and Dropbox CAS/concurrency tests.**
- [ ] **Step 7: Commit `feat(schema): add managed document V2 codecs`.**

### Task 7: Introduce provider-qualified V2 bindings and fingerprints with dual-read conflict detection

**Files:**
- Modify relevant managed-document index repository under `src/documents/`
- Create: `test/schema/provider-indexes.spec.ts`
- Modify existing document lookup/dedup tests

**Interfaces:**
- Produces exact paths:
  - `.project-os/projects/<PRJ>/documents/provider-file-bindings/v2/<KEY>.json`
  - `.project-os/projects/<PRJ>/documents/reference-fingerprints/v2/<KEY>.json`
- Produces keys:
  - `sha256(provider_id + "\n" + object_id)`
  - `sha256(provider_id + "\n" + integrity_hash.algorithm + "\n" + integrity_hash.value)`

- [ ] **Step 1: Add exact 64-character lowercase SHA-256 path/key vectors.**
- [ ] **Step 2: Add lookup tests: V2 first, legacy Dropbox V1 fallback, same binding accepted, contradictory V1/V2 evidence fails closed.**
- [ ] **Step 3: Implement V2 writes only at `provider_v2`; do not backfill old indexes and do not migrate on read.**
- [ ] **Step 4: Prove document IDs remain based on the same Dropbox object-ID input as V1.**
- [ ] **Step 5: Run document index/dedup/concurrency tests.**
- [ ] **Step 6: Commit `feat(schema): add provider qualified document indexes`.**

### Task 8: Implement MutationGate intent/candidate V1/V2 codecs without changing resolution identity

**Files:**
- Create: `src/schema/mutation-gate.ts`
- Create: `test/schema/mutation-gate.spec.ts`
- Modify: `src/domain/mutation-gate.ts`
- Modify: `src/durable/project-guard-mutation-gate.ts`
- Modify existing `test/artifact-mutation-intent.spec.ts`, MutationGate candidate/fault/replay tests

**Interfaces:**
- Produces: V2 artifact-intent provider precondition (`absent` or complete `existing` neutral evidence)
- Produces: V2 external candidate provider observation
- Keeps destination binding/resolution/terminal-resolution families at 1.0

- [ ] **Step 1: Add V1 upcast and strict V2 serialization fixtures for intents/candidates.**
- [ ] **Step 2: Assert `absent` precondition is provider-bound and `existing` precondition is complete; partial evidence fails closed.**
- [ ] **Step 3: Assert candidate ID derivation keeps exact `(project_id, Dropbox object_id, Dropbox revision_token)` inputs used historically.**
- [ ] **Step 4: Add regression fixtures for all eight repaired PRJ-0003 candidates/resolutions and assert no duplicate candidate/resolution identity after V2 readers are enabled.**
- [ ] **Step 5: Keep MutationGate `enforce`; prove baseline/cursor-reset discovery still cannot implicitly govern an unknown strict-zone file.**
- [ ] **Step 6: Run the full MutationGate high-risk tests and `npm run check:mutation-gate-repair-workflow`.**
- [ ] **Step 7: Commit `feat(schema): add MutationGate V2 provider evidence`.**

### Task 9: Preserve projection/materialization semantics across ProjectState V2

**Files:**
- Modify only if necessary: `src/materialization/**`
- Modify: `test/materialization-*.spec.ts` relevant suites
- Add: `test/schema/materialization-compat.spec.ts`

**Interfaces:**
- Consumes current semantic ProjectState only; never historical serialized unions.

- [ ] **Step 1: Add tests proving `projection_version` remains 1 when ProjectState changes to V2.**
- [ ] **Step 2: Add a carried-forward output test where `source_revision` remains older than the materialization head target because semantic input is unchanged.**
- [ ] **Step 3: Verify only semantically affected `STATE.md`/`HANDOFF.md` outputs regenerate; unrelated projections are not forced to rewrite because a durable schema version changed.**
- [ ] **Step 4: Make the minimum integration change needed so materialization consumes current semantic state from the codec boundary.**
- [ ] **Step 5: Run materialization fault/recovery/root-hash tests.**
- [ ] **Step 6: Commit `test(schema): preserve materialization semantics across V2`.**

### Task 10: Add rollout frontier state, fail-closed rollback rules and schema diagnostics

**Files:**
- Modify: `src/schema/writer-stage.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: `src/durable/project-guard-mutation-gate.ts`
- Modify: runtime/admin diagnostics in `src/index-neutral.ts` and/or existing health/admin modules
- Create: `test/schema/rollout.spec.ts`

**Interfaces:**
- Records enough operational state to distinguish pre-frontier vs post-core-V2 vs post-provider-V2.
- Diagnostic fields include project ID when applicable, family, encountered version, semantic/current version, canonical revision, deployment/Git identity, parser/migration failure class, active writer stage, and frontier state.

- [ ] **Step 1: Write tests for R1 all-V1 operation, pre-frontier rollback allowance, first core-V2 frontier, first provider-V2 frontier, and forbidden writer regression after each frontier.**
- [ ] **Step 2: Add a test that `v1_only` encountering current V2 state fails closed instead of down-encoding.**
- [ ] **Step 3: Implement monotonic frontier persistence in hot/local operational state without inventing a business revision.**
- [ ] **Step 4: Add structured safe diagnostics; never log provider secrets or raw sensitive payloads.**
- [ ] **Step 5: Add explicit local SQLite storage-version checks where structural changes are required; prefer additive transactional migration and reject unknown newer local versions.**
- [ ] **Step 6: Run rollout tests plus ProjectGuard/RegistryGuard recovery tests.**
- [ ] **Step 7: Commit `feat(schema): enforce monotonic rollout frontiers`.**

### Task 11: R0 deployment-authority gate before any production V2 activation

**Files:**
- Inspect/modify only after explicit operational approval: `.github/workflows/**`, `wrangler.toml` / Cloudflare deployment configuration, deployment documentation/scripts.
- Add/update deployment verification tests/scripts if repository already has them.

**Interfaces:**
- Exactly one authoritative production promotion path.
- Promotion evidence identifies exact Git SHA/Worker version.
- Delayed autonomous build cannot replace the selected production release.

- [ ] **Step 1: Inventory both current production promotion mechanisms and document the concrete race using existing deployment evidence.**
- [ ] **Step 2: Write a failing deployment-policy check that detects more than one production promoter or a promoter lacking exact Git SHA identity.**
- [ ] **Step 3: Obtain explicit user/operational approval for the deployment-pipeline mutation before changing infrastructure.**
- [ ] **Step 4: Make the minimal change so only the approved promoter can change production traffic; keep any secondary build mechanism non-promoting.**
- [ ] **Step 5: Verify production health and exact deployed SHA; verify the designated schema-capable rollback release is available.**
- [ ] **Step 6: Commit `ops(schema): enforce single production promotion path`.**

**Hard gate:** Do not activate `core_v2` until Task 11 is completed and production evidence proves R0.

### Task 12: Execute staged R1 -> R4 validation without bulk migration

**Files:**
- Modify deployment/runtime configuration only through existing approved mechanisms.
- Add/update operator documentation for schema rollout/recovery.
- Add production-probe evidence references to the implementation PR and later canonical Project OS transaction(s).

**Interfaces:**
- R1: V1+V2 readers/encoders deployed, active stage `v1_only`.
- R2: active stage `core_v2`.
- R3: active stage `provider_v2`.
- R4: steady state, V1 history remains readable indefinitely.

- [ ] **Step 1: Before rollout, run `npm run check` and the schema compatibility matrix; require green CI at the exact PR head.**
- [ ] **Step 2: Deploy R1 with `v1_only`; prove old/sparse projects, mixed synthetic fixtures, total SQLite-loss recovery, managed documents, all eight PRJ-0003 MutationGate fixtures, and normal transaction smoke tests.**
- [ ] **Step 3: Confirm no V2 durable object was intentionally produced; only then is pre-SCHEMA rollback still permitted.**
- [ ] **Step 4: Activate R2 on an isolated production probe/canary project first; prove first ProjectState 2.0 + manifest 2.0, envelope 1.0, revision/event/receipt bindings, snapshot convergence without extra business revision, mixed recovery, projection invariants, and project isolation.**
- [ ] **Step 5: Record the core-V2 durable frontier; from this point prohibit V1-only rollback permanently.**
- [ ] **Step 6: Activate R3; create/extend a managed-document V1->V2 history, verify Dropbox CAS, V2 binding/fingerprint exact paths, no ID duplication, conflict fail-closed behavior, and capture/resolve a new V2 MutationGate candidate in `enforce`.**
- [ ] **Step 7: Record the provider-V2 durable frontier; rollback must retain `provider_v2` writer capability.**
- [ ] **Step 8: Enter R4 only after production evidence proves R2/R3; do not schedule bulk historical rewrites or backfills.**
- [ ] **Step 9: Update operator/recovery documentation with exact rollback set, frontier semantics, diagnostics and no-down-migration rule.**
- [ ] **Step 10: Persist completion evidence through typed Project OS transactions only after receipt status is `committed`; only then complete `TASK-IMPSCHEMA001`.**
- [ ] **Step 11: Commit `docs(schema): document staged rollout and recovery`.**

---

## Final verification matrix

Before implementation is considered ready for production activation, the executor must demonstrate:

1. ProjectState/manifest strict V1/V2 parsing, semantic migration and unknown-version rejection.
2. Commit envelope 1.0 with nested V1/V2 states and deterministic mixed-chain recovery after total SQLite loss.
3. Standalone receipt/transaction/event reads remain strict and unchanged at 1.0.
4. Managed-document V1/V2 causal histories reconstruct identically and retain request/CAS/lifecycle semantics.
5. Provider-qualified bindings/fingerprints use the exact deterministic namespaces and 64-hex keys from the spec.
6. MutationGate V1/V2 intents/candidates preserve all historical identities and all eight repaired PRJ-0003 terminal resolutions.
7. Registry allocator/recovery and materialization projection/version/root-hash semantics remain unchanged.
8. Writer stages/frontiers are monotonic and post-frontier rollback can never select V1-only software.
9. R0 proves one production promoter and exact serving deployment identity before any V2 durable writer activation.
10. `npm run check` is green at every merge/cutover candidate, and each R-stage has explicit production evidence before moving to the next.

## Self-review against the spec

- Spec coverage: every major section is mapped: family versioning/codecs (Tasks 1-8), ProjectState/manifest (2-3), mixed commits/recovery (4), provider-neutral evidence/indexes (5-8), materialization independence (9), Durable Object/rollback/error/observability discipline (10), R0 deployment authority (11), R1-R4 rollout and production validation (12).
- No bulk-rewrite or write-on-read path is introduced.
- Retained 1.0 families are explicitly kept at 1.0.
- Writer-stage names and rollout ordering match the spec exactly.
- Provider evidence field names and deterministic binding/fingerprint key formulas match the spec.
- The plan intentionally separates implementation from R0 infrastructure mutation approval and from production writer activation.
