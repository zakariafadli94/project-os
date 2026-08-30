# Project OS — SOP Governance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce explicit project-creation authorization, typed synthetic projects, standardized cross-project referrals, and crash-safe observable INPUT intake without rewriting historical Project OS evidence.

**Architecture:** Keep canonical `ProjectState` and existing business revisions unchanged. Add separate governance records for project kind and project-create authorization, a dedicated referral transport family, and a resumable intake journal under the machine project namespace. RegistryGuard remains the serialized allocation authority; ProjectGuard remains the serialized per-project document authority; scheduled maintenance gains a direct `INPUTS/` sweep independent of the provider change cursor.

**Tech Stack:** TypeScript 5.9, Zod 4.4, Vitest 4.1, Cloudflare Workers/Durable Objects, provider-neutral persistence with Dropbox production provider, GitHub-hosted Actions only.

**Spec:** `docs/superpowers/specs/2026-08-30-sop-governance-hardening-design.md`

## Global Constraints

- Do not implement or merge IMP-DOCIDENTITY001 / PR #93 in this package.
- Do not modify PRJ-0003 business state during implementation or production proof.
- Preserve PRJ-0004, PRJ-0005, and PRJ-0006 historical evidence; PRJ-0006 must remain archived.
- Do not retroactively invent human authorization or `project_kind` for historical projects.
- `ProjectState`, canonical business revision semantics, project lifecycle semantics, existing Managed Document IDs/versions, registry IDs, historical receipts/events/commits, and MutationGate semantics remain unchanged.
- New project kinds are exactly `real`, `synthetic_probe`, and `synthetic_stress_test`; historical missing kind reads as `unknown_legacy` only in governance views.
- Generic transaction/referral/artifact/document writers must not be able to issue project-create authorization.
- New project allocation after enforcement must fail closed without a live matching one-shot authorization.
- New referral types are exactly `anomaly`, `dependency`, `research`, `information`, `decision_request`, `improvement_request`, `deliverable_reference`.
- Referral Markdown never contains mutable lifecycle fields such as `referral_status`.
- `INPUTS/` is transient evidence intake; no INPUT may be deleted before a coherent governed reference or verified duplicate exists.
- Direct INPUT discovery must not depend on the managed-document change cursor.
- Archived projects are never processed by intake.
- Stale intake threshold is exactly 15 minutes after `first_seen_at`.
- Source metadata must be re-read immediately before deletion and must still match the intake-bound provider revision.
- Prefer temporary duplicate evidence over source loss.
- All new runtime work is TDD: failing focused test, minimal implementation, focused pass, regression pass, commit.
- CI/deployment uses GitHub-hosted runners only; never add or restore self-hosted runners.
- No production validation step may create a project implicitly. If a new synthetic project is genuinely required, stop and require the normal explicit project-create authorization flow.
- Any later canonical PRJ-0002 mutation remains receipt-gated and follows the separate Dropbox confirmation rule; implementation commits themselves do not constitute canonical Project OS business-state updates.

---

## File map and responsibility boundaries

### New governance modules

- `src/domain/project-governance.ts` — project kind, governance profile, project-create authorization record/consumption/receipt contracts.
- `src/schema/project-governance.ts` — strict parsers for governance records; legacy absence maps to `unknown_legacy` in readers only.
- `src/governance/project-create-authorization.ts` — issuance/matching/expiry/consumption policy functions.
- `src/governance/repository.ts` — durable global authorization/frontier records and per-project governance profiles.

### New referral modules

- `src/domain/referral.ts` — request, envelope, receipt, referral type and safe ID/path validation.
- `src/referrals/renderer.ts` — deterministic Markdown envelope renderer with no workflow status field.
- `src/referrals/service.ts` — target resolution, idempotent delivery to target `INPUTS/`, transport receipt publication.
- `src/referrals/repository.ts` — transport receipt persistence and idempotency lookup.

### New intake modules

- `src/domain/intake.ts` — intake ID, state machine, step evidence and health contracts.
- `src/schema/intake.ts` — strict journal/health readers.
- `src/documents/intake-repository.ts` — durable journal, health and referral-provenance sidecars.
- `src/documents/intake-service.ts` — one-revision crash-safe INPUT ingestion engine.
- `src/documents/intake-sweep.ts` — recursive direct enumeration of `INPUTS/` and convergence onto the same intake engine.
- `src/documents/intake-health.ts` — 15-minute stale classification and aggregate health.

### Existing integration points

- `src/domain/transaction.ts` — optional governance fields on `project.create` for legacy-compatible parsing.
- `src/durable/registry-guard-neutral.ts` — authorization issuance/consumption, allocation gate, governance profile binding, historical replay compatibility.
- `src/durable/project-guard-neutral.ts` — document maintenance orchestration and intake health/status endpoints.
- `src/documents/reconciler.ts` — delegate `INPUTS/` changes to `IntakeService`; remove unsafe inline ingestion sequence.
- `src/documents/change-coordinator.ts` — incremental path remains, but intake is no longer dependent on it.
- `src/documents/repository.ts` — existing reference proof operations consumed by `IntakeService`; no ID algorithm changes.
- `src/persistence/layout.ts` — safe global governance/referral paths and per-project intake/provenance paths.
- `src/persistence/repository-core.ts` / `src/persistence/repository.ts` — governance profile and global record persistence hooks where appropriate.
- `src/materialization/coordinator.ts` / `src/materialization/planner.ts` — pass optional project governance profile to human projection planning without adding fields to ProjectState.
- `src/render/project.ts`, `src/render/operating.ts`, `src/render/handoff.ts`, `src/render/registry.ts` — synthetic visibility and updated operating contract.
- `src/index-neutral.ts` — dedicated operator authorization endpoint, referral endpoint, scheduled intake sweep/health summaries.
- `src/env.ts` — dedicated operator credential and rollout mode/frontier configuration.
- `docs/project-os/sop/01-PROJECT-MANAGEMENT-SOP.md` — normative project authorization/referral/intake rules.
- `package.json` — add governance/intake high-risk suites to persistence high-risk gate.

---

### Task 1: Establish governance, referral and intake domain contracts

**Files:**
- Create: `src/domain/project-governance.ts`
- Create: `src/domain/referral.ts`
- Create: `src/domain/intake.ts`
- Create: `src/schema/project-governance.ts`
- Create: `src/schema/intake.ts`
- Modify: `src/domain/transaction.ts`
- Modify: `src/persistence/layout.ts`
- Create: `test/governance-domain.spec.ts`
- Create: `test/referral-domain.spec.ts`
- Create: `test/intake-domain.spec.ts`

**Interfaces:**
- Produces: `type ProjectKind = "real" | "synthetic_probe" | "synthetic_stress_test"`.
- Produces: `type ProjectKindView = ProjectKind | "unknown_legacy"`.
- Produces: `ProjectGovernanceProfile { schema_version:"1.0"; project_id; project_kind; authorization_id; parent_project_id?; improvement_package_id?; created_at }`.
- Produces: `ProjectCreateAuthorizationRecord`, `ProjectCreateAuthorizationConsumption`, `ProjectCreateAuthorizationReceipt`.
- Produces: `ReferralWriteRequest`, `ReferralEnvelope`, `ReferralTransportReceipt`.
- Produces: `IntakeRecord`, `IntakeHealthRecord`, `IntakeState = "observed" | "processing" | "ingested" | "duplicate" | "failed"`.
- Produces safe path helpers for global authorization/frontier/referral receipts and per-project intake/provenance records.

- [ ] **Step 1: Write failing governance tests for exact project-kind values, synthetic parent/package requirements, strict authorization IDs, and legacy `project.create` parsing.**

```ts
expect(parseProjectKind("real")).toBe("real");
expect(() => parseProjectKind("production_probe")).toThrow();
expect(() => parseProjectGovernanceProfile({
  schema_version: "1.0",
  project_id: "PRJ-9001",
  project_kind: "synthetic_probe",
  authorization_id: "PCAUTH-AAAAAAAAAAAAAAAAAAAAAAAA",
  created_at: at
})).toThrow(/parent|package/i);

expect(parseTransaction({
  schema_version: "1.0",
  transaction_id: "TXN-GOV-LEGACY-0001",
  project_id: "PRJ-AUTO",
  base_revision: 0,
  operation: "project.create",
  created_at: at,
  payload: { name: "Legacy", slug: "legacy", aliases: [], objective: "Historical replay" }
}).operation).toBe("project.create");
```

- [ ] **Step 2: Write failing referral tests for the exact seven `referral_type` values, `canonical:false`, stable `REF-*` IDs, source/target mismatch rejection, and absence of `referral_status` from the domain envelope.**

```ts
expect(parseReferralWriteRequest(validReferral).referral_type).toBe("improvement_request");
expect(() => parseReferralWriteRequest({ ...validReferral, referral_type: "task" })).toThrow();
expect(parseReferralEnvelope(renderedEnvelope)).not.toHaveProperty("referral_status");
```

- [ ] **Step 3: Write failing intake tests for deterministic `INTAKE-*` identity from `(project_id, provider_id, object_id, revision_token)`, strict states, terminal-state rules and 15-minute stale classification boundary.**

```ts
const first = await intakeIdFor("PRJ-0002", "dropbox", "id:abc", "rev-7");
expect(first).toMatch(/^INTAKE-[A-F0-9]{24}$/);
expect(await intakeIdFor("PRJ-0002", "dropbox", "id:abc", "rev-7")).toBe(first);
expect(await intakeIdFor("PRJ-0002", "dropbox", "id:abc", "rev-8")).not.toBe(first);
expect(isIntakeStale("2026-08-30T07:00:00Z", "2026-08-30T07:15:00Z")).toBe(true);
```

- [ ] **Step 4: Run `npx vitest run test/governance-domain.spec.ts test/referral-domain.spec.ts test/intake-domain.spec.ts` and confirm RED.**
- [ ] **Step 5: Implement minimal strict Zod/domain contracts and path helpers. Keep new `project.create` governance fields optional at parse time: `authorization_id`, `project_kind`, `parent_project_id`, `improvement_package_id`. Do not enforce them in the parser.**
- [ ] **Step 6: Re-run the three focused suites plus `npm run typecheck`.**
- [ ] **Step 7: Commit `feat(governance): add project referral and intake contracts`.**

### Task 2: Add reader-first governance profiles and synthetic human visibility

**Files:**
- Create: `src/governance/repository.ts`
- Modify: `src/persistence/layout.ts`
- Modify: `src/materialization/coordinator.ts`
- Modify: `src/materialization/planner.ts`
- Modify: `src/render/project.ts`
- Modify: `src/render/registry.ts`
- Create: `test/project-governance-profile.spec.ts`
- Modify: `test/materialization-coordinator.spec.ts`

**Interfaces:**
- Produces: `GovernanceRepository.readProjectProfile(projectId): Promise<ProjectGovernanceProfile | null>`.
- Produces: `GovernanceRepository.writeProjectProfile(profile): Promise<void>` as immutable safe-add semantics.
- `planProjection(record, baseline, projectionVersion, governanceProfile?)` accepts profile separately from `ProjectState`.
- Human rendering receives `ProjectKindView`; absent profile becomes `unknown_legacy` without any durable write.

- [ ] **Step 1: Write a failing legacy-read test proving a project with no governance profile still materializes with business state unchanged and is exposed only as `unknown_legacy` to governance-aware rendering.**
- [ ] **Step 2: Write a failing synthetic render test requiring the exact visible warning text `Synthetic project — fictitious / non-business` in `PROJECT.md` and a `[synthetic]` marker in the registry human index.**

```ts
const rendered = renderProject(state, { project_kind: "synthetic_probe" });
expect(rendered).toContain("Synthetic project — fictitious / non-business");
expect(rendered).toContain("Project kind: synthetic_probe");
```

- [ ] **Step 3: Run the focused suites and confirm RED.**
- [ ] **Step 4: Implement immutable profile persistence at `.project-os/projects/<PRJ>/governance/profile.json`; if absent, do not create or infer one.**
- [ ] **Step 5: Thread the optional profile through materialization planning. Include `project_kind` in the semantic input hash for `PROJECT.md`/registry display so a newly written profile causes the next legitimate materialization to render the warning without changing ProjectState.**
- [ ] **Step 6: Re-run focused suites plus materialization regression tests.**
- [ ] **Step 7: Commit `feat(governance): render project kind outside business state`.**

### Task 3: Implement independent project-create authorization issuance

**Files:**
- Create: `src/governance/project-create-authorization.ts`
- Modify: `src/governance/repository.ts`
- Modify: `src/env.ts`
- Modify: `src/index-neutral.ts`
- Create: `test/project-create-authorization.spec.ts`
- Create: `test/project-create-authorization-route.spec.ts`

**Interfaces:**
- Adds env secret: `PROJECT_CREATE_OPERATOR_TOKEN` distinct from `INGRESS_TOKEN` and `MUTATION_GATE_OPERATOR_TOKEN`.
- Adds authenticated endpoint: `POST /v1/operator/project-create-authorizations`.
- Request body: `{ authorization_id, name, slug, aliases, objective, project_kind, parent_project_id?, improvement_package_id?, issued_at, expires_at }`.
- Produces immutable authorization record plus immutable issuance receipt; does not create a Project OS business event/revision.

- [ ] **Step 1: Write failing endpoint tests proving `INGRESS_TOKEN` alone cannot issue authorization, missing operator token returns 401, and the dedicated operator token succeeds.**

```ts
const denied = await worker.fetch(operatorRequest(validAuth, testEnv.INGRESS_TOKEN), testEnv, ctx);
expect(denied.status).toBe(401);
const allowed = await worker.fetch(operatorRequest(validAuth, testEnv.PROJECT_CREATE_OPERATOR_TOKEN!), testEnv, ctx);
expect(allowed.status).toBe(200);
```

- [ ] **Step 2: Add failing policy tests for `expires_at > issued_at`, maximum 30-minute validity, immutable replay with identical payload, and rejection of same `authorization_id` with different payload.**
- [ ] **Step 3: Run the two suites and confirm RED.**
- [ ] **Step 4: Implement `issueProjectCreateAuthorization()` with exact-payload idempotency and safe-add persistence under `.project-os/governance/project-create-authorizations/issued/`. Persist a separate immutable issuance receipt under `.../receipts/`.**
- [ ] **Step 5: Ensure the generic `/v1/transactions`, inbox processor, referral and document routes have no code path that calls the issuance function. Add a structural test that only the operator route references the issuance entrypoint.**
- [ ] **Step 6: Re-run focused suites plus `npm run check:persistence-boundary`.**
- [ ] **Step 7: Commit `feat(governance): add independent project create authorization`.**

### Task 4: Gate RegistryGuard allocation on one-shot authorization

**Files:**
- Modify: `src/durable/registry-guard-neutral.ts`
- Modify: `src/governance/project-create-authorization.ts`
- Modify: `src/governance/repository.ts`
- Modify: `src/env.ts`
- Modify: `src/index-neutral.ts`
- Modify: `test/registry-guard.spec.ts`
- Modify: `test/registry-guard-recovery.spec.ts`
- Create: `test/registry-guard-authorization.spec.ts`
- Create: `test/helpers/project-fixtures.ts`

**Interfaces:**
- Adds rollout env: `PROJECT_OS_PROJECT_CREATE_AUTH_MODE?: "observe" | "enforce"` defaulting to `observe` until R2.
- Adds informational frontier label: `PROJECT_OS_PROJECT_CREATE_AUTH_FRONTIER?: string` for logs/status; security never trusts transaction `created_at` to bypass enforcement.
- `RegistryGuard` consumes authorization only while serialized with allocation.
- Consumption record binds `{ authorization_id, transaction_id, allocated_project_id, consumed_at }` immutably after allocation.

- [ ] **Step 1: Add RED tests for enforcement rejection codes: `PROJECT_CREATE_AUTHORIZATION_REQUIRED`, `..._MISMATCH`, `..._EXPIRED`, `..._CONSUMED`.**
- [ ] **Step 2: Add RED tests for exact authorized create, exact committed replay returning the original receipt, and a second different transaction attempting the consumed authorization.**
- [ ] **Step 3: Add RED concurrency test sending two project creates against one authorization and assert exactly one allocation/commit.**
- [ ] **Step 4: Add RED recovery tests: failure before `allocateProjectId()` leaves authorization usable; failure after allocation permanently binds it to that allocated PRJ and retry resumes the same request.**
- [ ] **Step 5: Add RED historical compatibility test: in enforce mode, an already-terminal historical `project.create` with no governance fields replays from canonical receipt/request evidence; a previously unseen unauthenticated request is rejected even if it backdates `created_at`.**
- [ ] **Step 6: Implement matching over normalized name/slug/aliases/objective/project kind and synthetic binding. Consume/bind in RegistryGuard's existing serialized create flow; never release after project ID allocation.**
- [ ] **Step 7: On authorized allocation, write the immutable `ProjectGovernanceProfile` before downstream materialization can render the new project.**
- [ ] **Step 8: Introduce `authorizeAndCreateTestProject()` in `test/helpers/project-fixtures.ts`; use it for suites that intentionally exercise RegistryGuard create under enforce mode. Do not weaken production enforcement for tests.**
- [ ] **Step 9: Run `npx vitest run test/registry-guard.spec.ts test/registry-guard-recovery.spec.ts test/registry-guard-authorization.spec.ts` and `npm run test:persistence-high-risk`.**
- [ ] **Step 10: Commit `feat(governance): enforce authorized project allocation`.**

### Task 5: Standardize the dedicated cross-project referral writer

**Files:**
- Create: `src/referrals/renderer.ts`
- Create: `src/referrals/repository.ts`
- Create: `src/referrals/service.ts`
- Modify: `src/index-neutral.ts`
- Modify: `src/persistence/layout.ts`
- Create: `test/referral-renderer.spec.ts`
- Create: `test/referral-service.spec.ts`
- Create: `test/referral-route.spec.ts`

**Interfaces:**
- Adds authenticated endpoint: `POST /v1/referrals` using normal ingress authentication, not project-create operator capability.
- Deterministic destination: `<target workspace>/INPUTS/REFERRAL-<referral_id>.md`.
- Transport receipt: `{ schema_version:"1.0", referral_id, status:"delivered"|"rejected", source_project_id, target_project_id, input_path?, delivered_at?, code?, message? }`.
- Idempotent exact replay returns the original transport receipt.

- [ ] **Step 1: Write RED renderer test for exact frontmatter keys and assert the rendered Markdown does not contain `referral_status`, `task_id`, `decision_id`, or any canonical acceptance field.**

```ts
expect(markdown).toContain("referral_id: REF-GOV-000000000001");
expect(markdown).toContain("canonical: false");
expect(markdown).not.toContain("referral_status:");
```

- [ ] **Step 2: Write RED service test with spies proving delivery reads the registry/target identity only and never reads target `HANDOFF.md`, `STATE.md`, `PLAN.md`, `DECISIONS/`, or `RESEARCH/`.**
- [ ] **Step 3: Add RED tests for unsupported type, source/target mismatch, missing target, archived target, target path conflict with different bytes, and exact idempotent replay.**
- [ ] **Step 4: Run the three focused suites and confirm RED.**
- [ ] **Step 5: Implement target resolution from RegistryGuard's registry response, deterministic renderer, safe-add into target `INPUTS/`, and immutable transport receipt under `.project-os/referrals/receipts/`.**
- [ ] **Step 6: Add integration assertion that referral delivery does not call ProjectGuard `/transaction` and therefore cannot create task/decision/research/deliverable state.**
- [ ] **Step 7: Re-run focused suites plus `test/session-routing-contract.spec.ts`.**
- [ ] **Step 8: Commit `feat(referrals): add typed cross project transport`.**

### Task 6: Add intake journal persistence and referral provenance sidecars

**Files:**
- Create: `src/documents/intake-repository.ts`
- Modify: `src/persistence/layout.ts`
- Create: `test/intake-repository.spec.ts`
- Create: `test/referral-provenance.spec.ts`

**Interfaces:**
- Journal path: `.project-os/projects/<PRJ>/documents/intake/records/<INTAKE-ID>.json`.
- Health path: `.project-os/projects/<PRJ>/documents/intake/health.json`.
- Referral provenance path: `.project-os/projects/<PRJ>/documents/provenance/referrals/<REF-ID>.json`.
- `IntakeRepository.beginObservation(...)` is idempotent for exact provider revision evidence.
- `IntakeRepository.write(record)` enforces monotone terminal semantics: terminal `ingested`/`duplicate` cannot return to processing; failed retryable may resume.

- [ ] **Step 1: Write RED tests that two discoveries of the same provider revision converge on one record and a different revision creates a different intake ID.**
- [ ] **Step 2: Write RED tests for forbidden transitions (`ingested -> processing`, `duplicate -> failed`) and allowed retry (`failed retryable -> processing`).**
- [ ] **Step 3: Write RED provenance tests for a standard referral ID and for a legacy referral with no ID, where the sidecar uses a deterministic `REF-LEGACY-<24HEX>` derived from bound provider object identity without rewriting source Markdown.**
- [ ] **Step 4: Implement strict read/write behavior and safe deterministic legacy referral provenance derivation.**
- [ ] **Step 5: Run focused suites and `npm run typecheck`.**
- [ ] **Step 6: Commit `feat(intake): add durable journal and referral provenance`.**

### Task 7: Replace unsafe inline INPUT ingestion with a crash-safe IntakeService

**Files:**
- Create: `src/documents/intake-service.ts`
- Modify: `src/documents/reconciler.ts`
- Modify: `src/documents/repository.ts`
- Create: `test/intake-service.spec.ts`
- Modify: `test/document-change-coordinator.spec.ts`

**Interfaces:**
- `IntakeService.process(state, { logicalPath, inputPath, metadata, detectedAt }): Promise<"ingested"|"duplicate"|"pending"|"failed">`.
- Reuses existing `DocumentLedgerRepository` ID algorithms and reference proof methods; does not change `documentIdForProviderFile()` or `externalVersionIdFor()`.
- `ManagedDocumentReconciler` delegates `classified.zone === "inputs"` to the service.

- [ ] **Step 1: Write RED happy-path test asserting order: journal intent exists before immutable snapshot; destination reference exists and is verified before source deletion; version/head/binding/fingerprint exist before terminal journal.**
- [ ] **Step 2: Add RED duplicate test requiring current reference fingerprint, readable head/version, current destination metadata, and exact source re-read before deletion. A stale fingerprint must leave the INPUT untouched.**
- [ ] **Step 3: Add RED source-change test: mutate the INPUT to a newer provider revision after destination/ledger completion but before final source check; old intake must not delete it and must record that source cleanup was skipped for revision mismatch.**
- [ ] **Step 4: Add RED legacy-referral ingestion test proving provenance sidecar creation without modifying the source referral bytes.**
- [ ] **Step 5: Run focused tests and confirm RED.**
- [ ] **Step 6: Implement the exact safe sequence from the spec: intent -> snapshot -> destination plan/copy -> destination verification -> version -> head/indexes -> governed reference verification -> source metadata re-read -> delete exact still-current source -> terminal journal.**
- [ ] **Step 7: Remove the old `ingestInput()` implementation from `ManagedDocumentReconciler`; there must be one ingestion engine only.**
- [ ] **Step 8: Re-run focused tests plus existing managed-document external edit/change-coordinator suites.**
- [ ] **Step 9: Commit `refactor(intake): make input ingestion journaled and source safe`.**

### Task 8: Prove intake recovery at every crash boundary

**Files:**
- Create: `test/intake-faults.spec.ts`
- Modify: `test/helpers/mock-dropbox.ts` only to expose deterministic existing fault injection points; do not add production-only fault switches.
- Modify: `src/documents/intake-service.ts` only where tests expose missing replay logic.

**Interfaces:**
- Reuse `installDropboxMock({ faults })`.
- Recovery decisions derive from durable journal step evidence plus current provider/ledger evidence.

- [ ] **Step 1: Add parameterized RED tests for crashes after: intent, snapshot, destination copy, immutable version write, head/index write, source deletion, and before terminal journal update.**

```ts
it.each([
  "after_intent",
  "after_snapshot",
  "after_destination_copy",
  "after_version",
  "after_head_indexes",
  "after_source_delete"
])("resumes intake after %s", async (point) => { /* fixture invokes provider fault mapped to this durable boundary */ });
```

- [ ] **Step 2: Add RED contradiction test: destination path exists with different integrity evidence; intake becomes `failed` with `retryable:false`, source remains present, and both objects remain preserved.**
- [ ] **Step 3: Add RED missing-source recovery tests: if governed reference proof is complete, finalize success; if proof is incomplete, remain failed and never fabricate success.**
- [ ] **Step 4: Add RED provider retry classification test using `ProviderOperationError.retryable`; retryable failures remain eligible on later cycles, provider conflicts/evidence contradictions remain non-retryable.**
- [ ] **Step 5: Implement minimal replay logic until every crash test passes without duplicate versions/heads or unsafe deletion.**
- [ ] **Step 6: Run `npx vitest run test/intake-faults.spec.ts test/intake-service.spec.ts` and `npm run test:persistence-high-risk`.**
- [ ] **Step 7: Commit `test(intake): prove crash recovery and fail closed behavior`.**

### Task 9: Add direct recursive INPUT sweep independent of the change cursor

**Files:**
- Create: `src/documents/intake-sweep.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: `src/documents/change-coordinator.ts`
- Create: `test/intake-sweep.spec.ts`
- Modify: `test/document-change-coordinator.spec.ts`

**Interfaces:**
- `IntakeSweep.sweep(state, observedAt): Promise<IntakeSweepSummary>` recursively enumerates files under the project's `INPUTS/` using `ObjectPersistence.listChildren`, not `changeFeed.listChanges`.
- Nested traversal is bounded to 8 directory levels and 1000 files per project per maintenance call; exceeding bounds fails visibly rather than silently skipping.
- Every discovered file metadata is sent to the same `IntakeService.process()` and therefore converges by `intake_id` with incremental discovery.

- [ ] **Step 1: Write RED test where the managed-document cursor is already advanced past an externally inserted INPUT, but direct sweep still discovers and ingests it.**
- [ ] **Step 2: Add RED convergence test where incremental change and sweep see the same provider revision in one maintenance cycle and only one intake journal/reference version is created.**
- [ ] **Step 3: Add RED archived-project test proving zero INPUT listing and zero intake journal writes.**
- [ ] **Step 4: Add RED nested INPUT test and explicit bound-exceeded error tests.**
- [ ] **Step 5: Implement recursive sweep with deterministic lexical traversal and the same service.**
- [ ] **Step 6: Integrate ProjectGuard document maintenance so change-feed failure does not prevent the direct sweep from running; return summary fields for both paths and surface change-feed failure separately.**
- [ ] **Step 7: Re-run focused tests plus MutationGate baseline/cursor-reset suites to prove INPUT sweep does not create final-zone candidates.**
- [ ] **Step 8: Commit `feat(intake): sweep inputs independently of provider cursor`.**

### Task 10: Add intake health/watchdog and scheduled maintenance evidence

**Files:**
- Create: `src/documents/intake-health.ts`
- Modify: `src/documents/intake-repository.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: `src/index-neutral.ts`
- Create: `test/intake-health.spec.ts`
- Create: `test/intake-admin-health.spec.ts`

**Interfaces:**
- ProjectGuard endpoint: `GET /intake-health` returns one project's durable aggregate.
- Authenticated worker endpoint: `GET /v1/admin/intake-health` aggregates registry projects without mutating business state.
- Health fields: `pending_count`, `oldest_pending_age_ms`, `stale_count`, `failed_retryable_count`, `failed_non_retryable_count`, `last_successful_intake_at`, `last_reconcile_at`, `last_direct_sweep_at`, `last_error_summary`.

- [ ] **Step 1: Write RED boundary tests: 14m59s is not stale; 15m00s is stale; terminal `ingested`/`duplicate` disappear from pending/stale counts.**
- [ ] **Step 2: Write RED test that a retryable stale intake remains eligible for the next sweep while a non-retryable failed intake is reported but not automatically retried.**
- [ ] **Step 3: Write RED endpoint auth test and archived-project aggregation test.**
- [ ] **Step 4: Implement durable health recomputation from journals after each document maintenance call and structured log entry `Project OS intake health` with project ID and counts.**
- [ ] **Step 5: Update scheduled maintenance completion log to include sweep/health summaries; do not create canonical tasks/decisions simply because an intake is stale.**
- [ ] **Step 6: Re-run focused tests and `npm run check`.**
- [ ] **Step 7: Commit `feat(intake): expose stale input health and watchdog`.**

### Task 11: Harden SOP and generated operating contract

**Files:**
- Modify: `docs/project-os/sop/01-PROJECT-MANAGEMENT-SOP.md`
- Modify: `src/render/operating.ts`
- Modify: `src/render/handoff.ts`
- Modify: `test/session-routing-contract.spec.ts`
- Create: `test/governance-operating-contract.spec.ts`

**Interfaces:**
- Increment `OPERATING_CONTRACT_VERSION` from `2` to `3` because portable operating semantics change.
- Generated contract explicitly states project authorization, synthetic typing, dedicated referral writer, transient monitored INPUT route and no implicit target canonical state.

- [ ] **Step 1: Write RED contract tests requiring these exact concepts: `explicit user authorization before project.create`, `synthetic project — fictitious / non-business`, `referral.write`, `INPUTS/ is a transient monitored intake zone`, `15 minutes`, and `no task/decision/research/deliverable is created solely from a referral`.**
- [ ] **Step 2: Update SOP section 4 New Projects with explicit authorization requirement and project kinds; update cross-project referral section with standard writer/types; update Sources/References with transient intake and stale defect language.**
- [ ] **Step 3: Update `renderOperating()` and HANDOFF routing summary; bump contract version to 3.**
- [ ] **Step 4: Run routing/governance contract tests plus materialization tests that fingerprint OPERATING/HANDOFF.**
- [ ] **Step 5: Commit `docs(sop): enforce project authorization referrals and intake health`.**

### Task 12: Add rollout policy R0-R4 and regression gates

**Files:**
- Create: `src/governance/rollout.ts`
- Modify: `src/env.ts`
- Modify: `src/index-neutral.ts`
- Modify: `package.json`
- Create: `test/governance-rollout.spec.ts`
- Create: `test/governance-acceptance.spec.ts`
- Modify production configuration docs / `wrangler.jsonc` only with safe default stages.

**Interfaces:**
- Rollout stages: `r0_reader_observe`, `r1_referrals_typing`, `r2_creation_enforce`, `r3_intake_enforce`, `r4_steady`.
- Stage ordering is monotone; production defaults must not skip directly to R4.
- `r2_creation_enforce` implies project-create auth enforcement.
- `r3_intake_enforce` implies journal+sweep+health are active.

- [ ] **Step 1: Write RED monotonic rollout tests and invalid configuration tests.**
- [ ] **Step 2: Add acceptance matrix covering all 35 required tests from the design spec by mapping each invariant to focused suites; fail the acceptance test if any required suite/fixture is absent from the explicit matrix.**
- [ ] **Step 3: Add governance/intake tests to `test:persistence-high-risk`: registry authorization/recovery, referral transport, intake faults/sweep/health, existing MutationGate/document concurrency suites.**
- [ ] **Step 4: Keep production config at R0 on merge; R1-R4 are explicit promotion actions, never inferred from successful deploy alone.**
- [ ] **Step 5: Run `npm run check`, `npm run test:persistence-high-risk`, and `npx wrangler deploy --dry-run`.**
- [ ] **Step 6: Commit `chore(governance): add rollout and high risk gates`.**

### Task 13: Production validation through R0-R3 without creating a project

**Files:**
- Create: `docs/superpowers/plans/2026-08-30-sop-governance-hardening-execution-notes.md` during execution with exact deployment evidence only.
- No new project files are created for validation unless separately authorized through the new gate.

**Interfaces:**
- Production proof uses existing PRJ-0002 and read-only/controlled operational surfaces; PRJ-0003 is never mutated.
- GitHub-hosted Actions only.

- [ ] **Step 1: Before deployment, run the full check/high-risk/dry-run gate and record exact commit SHA and green workflow run in execution notes.**
- [ ] **Step 2: Deploy R0 and verify authenticated intake health is readable, legacy projects remain readable, no project profile is invented for historical projects, and no business revision changes from observability alone.**
- [ ] **Step 3: Promote R1 and verify the standard referral renderer/writer in a test fixture or PRJ-0002 self-contained controlled input that does not touch PRJ-0003; verify synthetic rendering using unit/integration evidence rather than creating a new production project.**
- [ ] **Step 4: Promote R2 and prove an unauthorized new create request is rejected before allocation. Do not prove the positive path by creating a synthetic project unless the user separately authorizes such a project through the new operator flow.**
- [ ] **Step 5: Promote R3 and verify scheduled maintenance reports direct sweep and health timestamps every five-minute cycle; verify cursor-independent discovery using controlled PRJ-0002 input evidence.**
- [ ] **Step 6: If any production gate fails, stop promotion at that stage, preserve evidence, and do not advance to R4.**
- [ ] **Step 7: Commit execution notes containing only observed evidence, not inferred success.**

### Task 14: Repair the historical incidents and define the DOCIDENTITY unfreeze gate

**Files:**
- No manual move of the existing referral.
- Update execution notes with incident proof.
- Canonical PRJ-0002 transactions are performed only after fresh revision refresh, exact Dropbox mutation plan, immediate user confirmation, and committed receipts.

**Interfaces:**
- Existing referral path: `PRJ-0002/INPUTS/REFERRAL-PRJ0003-DOCUMENT-IDENTITY-VISIBILITY-IMPROVEMENT-20260830.md`.
- Existing task history remains untouched: `TASK-IMPDOCIDENTITY001` is not recreated or rewritten.
- R4 requires PRJ-0006 registry status `archived` and no unauthorized synthetic project active in the portfolio.

- [ ] **Step 1: At R3, let the corrected direct sweep discover the existing stuck referral naturally; do not manually move/delete it.**
- [ ] **Step 2: Verify terminal intake journal, immutable snapshot, reference version/head/indexes, `REFERENCES/UNCLASSIFIED/` destination, source removal, and referral provenance sidecar.**
- [ ] **Step 3: Verify the legacy referral provenance links to the existing DOCIDENTITY work as evidence only; do not rewrite the historical task create/start events and do not create a second task.**
- [ ] **Step 4: Read the fresh registry and prove PRJ-0006 is still archived and no active synthetic project lacks explicit post-cutover authorization evidence.**
- [ ] **Step 5: Run final `npm run check`, `npm run test:persistence-high-risk`, production health verification, and GitHub-hosted workflow checks.**
- [ ] **Step 6: Prepare the minimal canonical PRJ-0002 evidence/decision/task-state transactions required by the accepted operating contract. Before writing any transaction to Dropbox, refresh PRJ-0002 revision and obtain immediate confirmation for the exact transaction-file mutation. Consider the package canonically recorded only after receipts are `committed`.**
- [ ] **Step 7: Only after R4 evidence and canonical recording are complete, present IMP-DOCIDENTITY001 / PR #93 for plan revalidation. Do not automatically merge #93.**
- [ ] **Step 8: Commit `docs(governance): record R4 incident repair evidence` after observed proof exists.**

---

## Required test-to-invariant coverage

- `INV-GOV-001..005` → Tasks 2-4, 11-13.
- `INV-REF-001..003` → Tasks 5-6, 11.
- `INV-INTAKE-001..002` → Tasks 6-8.
- `INV-INTAKE-003..004` → Task 9.
- `INV-INTAKE-005` → Task 10.
- `INV-INTAKE-006` → Tasks 9-10.
- `INV-INTAKE-007` → Task 7 source-revision-change test.
- Required design tests 1-11 → Tasks 2-4.
- Required design tests 12-16 → Tasks 5-7.
- Required design tests 17-29 → Tasks 7-9.
- Required design tests 30-33 → Tasks 9-10.
- Required design test 34 → Task 14.
- Required design test 35 → Tasks 4, 12-13.

## Final verification commands

```bash
npm run check
npm run test:persistence-high-risk
npx vitest run \
  test/registry-guard-authorization.spec.ts \
  test/referral-service.spec.ts \
  test/intake-service.spec.ts \
  test/intake-faults.spec.ts \
  test/intake-sweep.spec.ts \
  test/intake-health.spec.ts \
  test/governance-acceptance.spec.ts
npx wrangler deploy --dry-run
```

Expected result: every command exits 0; no self-hosted runner label exists in changed workflows; no production proof creates a project without the dedicated authorization flow; no PRJ-0003 business mutation occurs; PRJ-0006 remains archived; the existing stuck referral is repaired only by the R3 intake path.

## Execution gate

This plan is a planning artifact only. Implementation begins only after explicit review/approval of this plan. When implementation is authorized, execute on an isolated branch/worktree from the then-current approved base using the required Superpowers execution/TDD skills, with review checkpoints between tasks.