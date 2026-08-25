# IMP-MUTATIONGATE001 B2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Project OS mutation gate that prevents raw provider files from silently becoming governed truth, preserves unknown final-zone writes as explicit external candidates, and gives artifact writes durable pre-effect provenance for deterministic recovery.

**Architecture:** Extend IMP-ARTIFACT001 rather than replacing it. Add a small independently versioned mutation-gate ledger for artifact intents, external candidates, immutable candidate payloads, and resolutions; run final-zone provenance classification before DELIVERABLE bootstrap; keep collaborative zones under the existing managed-document reconciler; and expose typed candidate resolution through ProjectGuard. Production rolls out in `observe` mode first while continuity remains `stable`.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers/Durable Objects SQLite, Dropbox HTTP API, Zod 4, Vitest 4, Wrangler 4.

**Spec:** `docs/superpowers/specs/2026-08-25-imp-mutationgate001-b2-design.md`

## Global Constraints

- This plan is not implementation approval. Start code only after a separate explicit user approval.
- Production continuity mode remains `stable` throughout the package.
- `ProjectState` remains on its existing schema; MUTATIONGATE does not force ProjectState 2.0.
- New mutation-gate durable families start at `schema_version: "1.0"` and remain project-isolated.
- Raw provider presence is never sufficient evidence of publication, canonicalization, or acceptance.
- `INPUTS`, `REFERENCES`, `WORKING`, and `REVIEW` remain legitimate external-edit surfaces.
- Unknown new files in final/governed zones must be preserved before resolution and must not auto-bootstrap as published.
- Managed-document request intent/receipt remains authoritative for managed-document operations; do not create a duplicate managed-document intent family.
- Artifact provider effects require durable mutation intent before the effect and terminal artifact/document evidence after the effect.
- Candidate capture is non-destructive by default; automatic unsafe delete/move of unknown final files is forbidden.
- Status vocabulary is exactly `SUBMITTED -> COMMITTED -> CANONICAL VERIFIED -> ACCEPTED`; no provider upload alone advances those semantics.
- No secret values in source, tests, docs, logs, Dropbox canonical notes, or chat.
- HMAC/signature provenance and provider credential separation remain primarily `IMP-SECURITY001` scope.
- PRJ-0003 repair occurs only after MUTATIONGATE production validation.
- IMP-SCHEMA001 runtime implementation remains blocked until MUTATIONGATE production validation, PRJ-0003 repair, and SCHEMA rollout revalidation.

---

### Task 1: Define mutation-gate records and project-isolated paths

**Files:**
- Create: `src/domain/mutation-gate.ts`
- Modify: `src/dropbox/layout.ts`
- Test: `test/mutation-gate-domain.spec.ts`
- Extend: `test/dropbox-paths.spec.ts`

**Interfaces:**
- Produces `MutationIntentRecord`, `ExternalMutationCandidateRecord`, `ExternalMutationResolutionRecord`, `MutationCandidateResolutionRequest`, parsers, deterministic `mutationIntentIdFor()`, `mutationCandidateIdFor()`, and `mutationResolutionIdFor()` helpers.
- Produces `machineMutationGateRoot()`, `machineMutationIntentPath()`, `machineMutationIntentDestinationBindingPath()`, `machineMutationCandidatePath()`, `machineMutationCandidatePayloadPath()`, and `machineMutationResolutionPath()`.

- [ ] **Step 1: Write RED domain tests for strict versioned records and deterministic IDs**

```ts
import { describe, expect, it } from "vitest";
import {
  mutationCandidateIdFor,
  mutationIntentIdFor,
  parseExternalMutationCandidateRecord,
  parseMutationIntentRecord
} from "../src/domain/mutation-gate";

describe("mutation gate domain", () => {
  it("derives project-bound deterministic intent and candidate ids", async () => {
    const intent = await mutationIntentIdFor("PRJ-0002", "ART-MUTATION-000001");
    expect(intent).toMatch(/^MUTINT-[A-F0-9]{24}$/);
    expect(await mutationIntentIdFor("PRJ-0002", "ART-MUTATION-000001")).toBe(intent);
    expect(await mutationIntentIdFor("PRJ-0003", "ART-MUTATION-000001")).not.toBe(intent);

    const candidate = await mutationCandidateIdFor({
      projectId: "PRJ-0002",
      providerFileId: "id:abc",
      providerRev: "rev-17"
    });
    expect(candidate).toMatch(/^MUTCAND-[A-F0-9]{24}$/);
  });

  it("rejects a candidate that claims a different project payload namespace", () => {
    expect(() => parseExternalMutationCandidateRecord({
      schema_version: "1.0",
      candidate_id: "MUTCAND-111111111111111111111111",
      project_id: "PRJ-0002",
      source: "external_unverified",
      detection_source: "incremental",
      provider_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/x.md",
      provider_file_id: "id:abc",
      provider_rev: "rev-17",
      provider_content_hash: "a".repeat(64),
      size: 3,
      immutable_payload_path: "/PROJECT_OS/.project-os/projects/PRJ-0003/mutation-gate/payloads/candidates/x/payload",
      detected_at: "2026-08-25T16:00:00+01:00"
    })).toThrow(/project/i);
  });
});
```

- [ ] **Step 2: Run the new domain/path tests and confirm RED**

Run:

```bash
npx vitest run test/mutation-gate-domain.spec.ts test/dropbox-paths.spec.ts
```

Expected: FAIL because `src/domain/mutation-gate.ts` and mutation-gate layout helpers do not exist.

- [ ] **Step 3: Implement strict V1 schemas and deterministic IDs**

Create `src/domain/mutation-gate.ts` with the exact core shapes:

```ts
import { z } from "zod";

const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const artifactRequestId = z.string().regex(/^ART-[A-Z0-9-]{10,}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const intentId = z.string().regex(/^MUTINT-[A-F0-9]{24}$/);
const candidateId = z.string().regex(/^MUTCAND-[A-F0-9]{24}$/);
const resolutionId = z.string().regex(/^MUTRES-[A-F0-9]{24}$/);

export const mutationIntentRecordSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  intent_id: intentId,
  project_id: projectId,
  kind: z.literal("artifact"),
  request_id: artifactRequestId,
  request_sha256: sha256,
  request_json: z.string().min(2),
  base_project_revision: z.number().int().nonnegative(),
  destination_path: z.string().min(1),
  archive_path: z.string().min(1).optional(),
  route_id: z.string().min(1).optional(),
  expected_content_sha256: sha256,
  mode: z.enum(["create", "replace"]),
  recorded_at: z.string().min(1)
});

export const externalMutationCandidateRecordSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  candidate_id: candidateId,
  project_id: projectId,
  source: z.literal("external_unverified"),
  detection_source: z.enum(["incremental", "baseline", "cursor_reset"]),
  provider_path: z.string().min(1),
  provider_file_id: z.string().regex(/^id:[A-Za-z0-9_-]+$/),
  provider_rev: z.string().min(1),
  provider_content_hash: sha256,
  size: z.number().int().nonnegative().safe(),
  immutable_payload_path: z.string().min(1),
  detected_at: z.string().min(1)
});

export const externalMutationResolutionRecordSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  resolution_id: resolutionId,
  project_id: projectId,
  candidate_id: candidateId,
  action: z.enum(["adopt_as_artifact", "adopt_as_working", "reject"]),
  downstream_request_id: z.string().min(1).optional(),
  downstream_receipt_status: z.enum(["committed", "conflict", "rejected"]).optional(),
  resolved_at: z.string().min(1)
});
```

Add `superRefine` checks so every provider/immutable path is absolute, traversal-free, and bound to the same `project_id`. Derive IDs with Web Crypto SHA-256 and the first 24 uppercase hex characters, following the existing managed-document ID pattern.

- [ ] **Step 4: Add exact hidden path helpers**

In `src/dropbox/layout.ts` add:

```ts
export function machineMutationGateRoot(projectId: string): string {
  return `${machineProjectRoot(projectId)}/mutation-gate`;
}

export function machineMutationIntentPath(projectId: string, requestId: string): string {
  return `${machineMutationGateRoot(projectId)}/intents/artifacts/${assertSafeArtifactRequestId(requestId)}.json`;
}

export function machineMutationCandidatePath(projectId: string, candidateId: string): string {
  return `${machineMutationGateRoot(projectId)}/candidates/${assertSafeMutationCandidateId(candidateId)}.json`;
}

export function machineMutationCandidatePayloadPath(projectId: string, candidateId: string): string {
  return `${machineMutationGateRoot(projectId)}/payloads/candidates/${assertSafeMutationCandidateId(candidateId)}/payload`;
}
```

Add the destination-binding and resolution path helpers using hashed safe path keys rather than embedding arbitrary physical paths into machine filenames.

- [ ] **Step 5: Run focused tests GREEN**

```bash
npx vitest run test/mutation-gate-domain.spec.ts test/dropbox-paths.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/domain/mutation-gate.ts src/dropbox/layout.ts test/mutation-gate-domain.spec.ts test/dropbox-paths.spec.ts
git commit -m "feat: define mutation gate durable records"
```

---

### Task 2: Add immutable mutation-gate repository and candidate byte preservation

**Files:**
- Create: `src/mutation-gate/repository.ts`
- Test: `test/mutation-gate-repository.spec.ts`
- Extend: `test/helpers/mock-dropbox.ts`

**Interfaces:**
- Consumes Task 1 record parsers/path helpers and existing `DropboxTransport`/`ResilientDropboxTransport`.
- Produces `MutationGateRepository` methods:
  - `ensureArtifactIntent(record)`
  - `readArtifactIntent(projectId, requestId)`
  - `listArtifactIntentsForDestination(projectId, destinationPath)`
  - `captureCandidate(input)`
  - `readCandidate(projectId, candidateId)`
  - `writeResolution(record)`
  - `readResolutions(projectId, candidateId)`

- [ ] **Step 1: Write RED tests for immutable intent/candidate/resolution evidence**

```ts
it("captures candidate bytes server-side before writing immutable candidate metadata", async () => {
  const transport = new FakeMutationGateDropbox();
  const visible = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/direct.md";
  const metadata = transport.seed(visible, "direct bytes");
  const repo = new MutationGateRepository(transport);

  const result = await repo.captureCandidate({
    projectId: "PRJ-0002",
    detectionSource: "incremental",
    visiblePath: visible,
    metadata,
    detectedAt: "2026-08-25T16:10:00+01:00"
  });

  expect(result.created).toBe(true);
  expect(transport.copies[0].from).toBe(visible);
  expect(transport.copies[0].to).toBe(result.record.immutable_payload_path);
  expect(await repo.readCandidate("PRJ-0002", result.record.candidate_id)).toEqual(result.record);
});

it("replays the same candidate idempotently and rejects different immutable evidence", async () => {
  // same project + file id + rev => same candidate; same bytes replay succeeds.
});
```

Also test that an intent request ID cannot be rebound to different request JSON or destination, and a candidate cannot receive two conflicting terminal resolutions.

- [ ] **Step 2: Run focused repository test RED**

```bash
npx vitest run test/mutation-gate-repository.spec.ts
```

Expected: FAIL because repository does not exist.

- [ ] **Step 3: Implement `MutationGateRepository` with safe-add semantics**

Use the existing immutable repository pattern:

```ts
async ensureArtifactIntent(record: MutationIntentRecord): Promise<MutationIntentRecord> {
  const validated = parseMutationIntentRecord(record);
  const path = machineMutationIntentPath(validated.project_id, validated.request_id);
  try {
    await this.transport.upload(path, pretty(validated), "add");
  } catch (error) {
    if (!(error instanceof DropboxConflictError)) throw error;
    const existing = await this.readArtifactIntent(validated.project_id, validated.request_id);
    if (!existing || !sameIntentBinding(existing, validated)) {
      throw new MutationIntentConflictError(validated.request_id);
    }
    return existing;
  }
  await this.safeAddDestinationBinding(validated);
  return validated;
}
```

For `captureCandidate`, snapshot with provider-side `copy()` first, verify destination payload metadata has the same `content_hash` and size, then safe-add the immutable candidate record. Never download opaque bytes merely to capture the candidate.

- [ ] **Step 4: Add destination binding lookup**

Store one immutable binding per artifact request under a deterministic hashed destination directory. `listArtifactIntentsForDestination()` lists only that directory, parses each binding, then reads/validates the corresponding intent. Do not recursively scan every project intent.

- [ ] **Step 5: Run repository tests GREEN**

```bash
npx vitest run test/mutation-gate-repository.spec.ts test/resilient-document-transport.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/mutation-gate/repository.ts test/mutation-gate-repository.spec.ts test/helpers/mock-dropbox.ts
git commit -m "feat: persist mutation gate provenance and candidates"
```

---

### Task 3: Put durable artifact intent before provider effects and freeze resolved destination

**Files:**
- Create: `src/mutation-gate/artifact-intent.ts`
- Modify: `src/durable/project-guard.ts`
- Modify: `src/dropbox/repository.ts`
- Modify: `src/documents/legacy-artifact.ts`
- Modify: `src/dropbox/artifact-routing.ts` only if a small exported snapshot helper is needed
- Test: `test/artifact-mutation-intent.spec.ts`
- Extend: `test/legacy-artifact-managed.spec.ts`
- Extend: `test/project-guard-artifact.spec.ts`

**Interfaces:**
- Produces `ArtifactMutationIntentService.prepare(state, request): Promise<PreparedArtifactMutation>` where `PreparedArtifactMutation` contains the validated durable intent plus a frozen `ResolvedArtifactDestination`.
- Changes `ProjectRepository.writeArtifact` to accept an optional already-resolved destination so recovery does not recompute a changed route.

- [ ] **Step 1: Write RED test proving intent exists before the first visible artifact provider write**

```ts
it("persists artifact mutation intent before provider effect", async () => {
  const response = await guard.fetch("https://project-guard.internal/artifact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(await artifactRequest("ART-MUTATION-INTENT-0001", "# governed"))
  });
  expect(response.status).toBe(200);

  const intentIndex = mock.uploadCalls.findIndex((p) => p.includes("/mutation-gate/intents/artifacts/ART-MUTATION-INTENT-0001.json"));
  const visibleIndex = mock.uploadCalls.findIndex((p) => p.includes("/WORKSPACE/PROJECTS/") && p.endsWith("/DELIVERABLES/REVENUE-OS/foo.md"));
  expect(intentIndex).toBeGreaterThanOrEqual(0);
  expect(visibleIndex).toBeGreaterThan(intentIndex);
});
```

- [ ] **Step 2: Write RED route-drift recovery test**

Scenario:

1. prepare artifact at project revision N with route `REVENUE-OS -> DELIVERABLES/REVENUE-OS`;
2. inject failure after provider create but before managed artifact/version receipt completion;
3. advance canonical route configuration to a different target;
4. replay the exact artifact request;
5. assert recovery uses the destination stored in the original intent and does not silently publish to the new target.

- [ ] **Step 3: Run RED tests**

```bash
npx vitest run test/artifact-mutation-intent.spec.ts test/legacy-artifact-managed.spec.ts test/project-guard-artifact.spec.ts
```

Expected: new intent and route-drift cases FAIL.

- [ ] **Step 4: Implement preparation service**

Core flow:

```ts
export class ArtifactMutationIntentService {
  constructor(private readonly repo: MutationGateRepository) {}

  async prepare(state: ProjectState, request: ArtifactWriteRequest): Promise<PreparedArtifactMutation> {
    const destination = resolveArtifactDestination(state, request.relative_path);
    const requestJson = JSON.stringify(request);
    const record = await this.repo.ensureArtifactIntent({
      schema_version: "1.0",
      intent_id: await mutationIntentIdFor(request.project_id, request.request_id),
      project_id: request.project_id,
      kind: "artifact",
      request_id: request.request_id,
      request_sha256: await sha256Text(requestJson),
      request_json: requestJson,
      base_project_revision: state.revision,
      destination_path: destination.path,
      ...(destination.archive_path ? { archive_path: destination.archive_path } : {}),
      ...(destination.route ? { route_id: destination.route.route_id } : {}),
      expected_content_sha256: request.content_sha256,
      mode: request.mode,
      recorded_at: new Date().toISOString()
    });
    return { record, destination: destinationFromIntent(record) };
  }
}
```

`destinationFromIntent()` must reconstruct only the frozen physical destination fields; it must not call `resolveArtifactDestination()` again.

- [ ] **Step 5: Wire ProjectGuard artifact handling to the prepared destination**

In `handleArtifact`, after current request/project/hash validation and before `repository.writeArtifact`, call the intent service. Pass the prepared frozen destination into the repository writer.

Keep existing terminal artifact receipt behavior unchanged.

- [ ] **Step 6: Make managed legacy artifact writer consume the frozen destination**

Refactor `LegacyArtifactDocumentWriter.writeIfManaged(...)` so the caller may provide the already-resolved destination. The writer may validate that the destination remains inside the bound project workspace but must not choose a new route during exact replay.

- [ ] **Step 7: Run artifact suites GREEN**

```bash
npx vitest run test/artifact-mutation-intent.spec.ts test/legacy-artifact-managed.spec.ts test/artifact-routing.spec.ts test/project-guard-artifact.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/mutation-gate/artifact-intent.ts src/durable/project-guard.ts src/dropbox/repository.ts src/documents/legacy-artifact.ts src/dropbox/artifact-routing.ts test/artifact-mutation-intent.spec.ts test/legacy-artifact-managed.spec.ts test/project-guard-artifact.spec.ts
git commit -m "feat: persist artifact intent before provider writes"
```

---

### Task 4: Classify final-zone changes before bootstrap and eliminate implicit published adoption

**Files:**
- Create: `src/mutation-gate/classifier.ts`
- Modify: `src/documents/change-coordinator.ts`
- Modify: `src/documents/bootstrap.ts`
- Test: `test/mutation-gate-classifier.spec.ts`
- Extend: `test/document-change-coordinator.spec.ts`
- Extend: `test/document-bootstrap.spec.ts`

**Interfaces:**
- Produces `FinalZoneMutationClassifier.classify(state, change, context)` returning:
  - `governed_current`
  - `governed_inflight`
  - `external_candidate`
  - `not_final_zone`
- `ManagedDocumentChangeCoordinator` calls this classifier before final-zone bootstrap/reconciliation.

- [ ] **Step 1: Write RED incremental unknown DELIVERABLE test**

```ts
it("records a direct new DELIVERABLE as candidate instead of ignoring or publishing it", async () => {
  await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
  const path = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-gate/DELIVERABLES/direct.md`;
  await mock.writeExternal(path, "# direct bypass");

  const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
  expect(await response.json()).toMatchObject({ candidates: 1 });

  const documentId = await documentIdFor(projectId, "direct.md");
  const status = await guard.fetch(`https://project-guard.internal/document-status?document_id=${documentId}`);
  expect(status.status).toBe(404);
});
```

- [ ] **Step 2: Write RED first-baseline and cursor-reset tests**

Seed the unknown `DELIVERABLES/direct.md` **before** the first reconcile and assert baseline reports a candidate with `bootstrapped: 0` for that path. Repeat with a stored cursor, injected Dropbox reset, and assert `detection_source = "cursor_reset"` and no published head.

- [ ] **Step 3: Write RED governed-inflight tests**

Cover:

- interrupted managed publish where REVIEW evidence matches visible DELIVERABLE bytes;
- interrupted artifact create where a durable artifact intent matches the same physical destination/request content.

Both must classify as `governed_inflight`, not candidate.

- [ ] **Step 4: Run RED classifier/coordinator tests**

```bash
npx vitest run test/mutation-gate-classifier.spec.ts test/document-change-coordinator.spec.ts test/document-bootstrap.spec.ts
```

Expected: unknown final files still bootstrap/ignore under current behavior, so RED cases fail.

- [ ] **Step 5: Implement strict final-zone classification**

Classifier outline:

```ts
export type FinalZoneClassification =
  | { kind: "not_final_zone" }
  | { kind: "governed_current" }
  | { kind: "governed_inflight"; requestId?: string }
  | { kind: "external_candidate" };

async classify(state: ProjectState, change: DropboxChangeEntry, detection: DetectionSource) {
  const final = classifyFinalPath(state, change.path);
  if (!final || change.tag !== "file") return { kind: "not_final_zone" } as const;

  if (await this.matchesManagedCurrent(state, final, change)) return { kind: "governed_current" } as const;
  if (await this.matchesManagedInflight(state, final, change)) return { kind: "governed_inflight" } as const;
  if (await this.matchesArtifactIntent(state, final, change)) return { kind: "governed_inflight" } as const;
  return { kind: "external_candidate" } as const;
}
```

Do not guess actor identity from Dropbox change metadata.

- [ ] **Step 6: Change baseline candidate selection**

In `ManagedDocumentChangeCoordinator.bootstrapCandidate`, remove the unconditional rule that returns `{ stage: "published" }` for every non-projected `DELIVERABLES/**` file. Only bootstrap `published` when classifier/evidence explicitly proves governance. Keep WORKING/REVIEW/REFERENCES compatibility bootstrap.

- [ ] **Step 7: Add explicit bootstrap guard**

`ManagedDocumentBootstrapper.bootstrapExistingManagedPath(..., "published")` must require an explicit provenance option/token from the caller rather than being callable as a generic inferred baseline.

Example signature:

```ts
bootstrapExistingManagedPath(
  state: ProjectState,
  visiblePath: string,
  metadata: DropboxFileMetadata,
  inferredStage: BootstrapManagedStage,
  options: { publishedProvenance?: "managed_recovery" | "legacy_artifact" } = {}
)
```

If `inferredStage === "published"` and `publishedProvenance` is absent, throw a fail-closed error.

- [ ] **Step 8: Run classifier/coordinator/bootstrap suites GREEN**

```bash
npx vitest run test/mutation-gate-classifier.spec.ts test/document-change-coordinator.spec.ts test/document-bootstrap.spec.ts test/document-external-edits.spec.ts
```

Expected: PASS and existing managed external-edit behavior unchanged.

- [ ] **Step 9: Commit Task 4**

```bash
git add src/mutation-gate/classifier.ts src/documents/change-coordinator.ts src/documents/bootstrap.ts test/mutation-gate-classifier.spec.ts test/document-change-coordinator.spec.ts test/document-bootstrap.spec.ts
git commit -m "feat: gate final-zone bootstrap by provenance"
```

---

### Task 5: Capture external candidates non-destructively and expose compact status

**Files:**
- Create: `src/mutation-gate/service.ts`
- Modify: `src/documents/change-coordinator.ts`
- Modify: `src/durable/project-guard.ts`
- Modify: `src/index.ts`
- Modify: `src/env.ts`
- Test: `test/mutation-gate-candidate.spec.ts`
- Extend: `test/document-change-coordinator.spec.ts`
- Extend: `test/index.spec.ts`

**Interfaces:**
- Produces `MutationGateService.captureExternalCandidate(...)`, `status(...)`, and `listUnresolved(...)`.
- Adds `PROJECT_OS_MUTATION_GATE_MODE?: "observe" | "enforce"` with parser defaulting to `observe` until production cutover is explicitly accepted.
- ProjectGuard internal endpoints:
  - `GET /mutation-candidates`
  - `GET /mutation-candidate-status?candidate_id=...`
- Public/admin compact read route may expose counts/IDs but never contents/provider secrets.

- [ ] **Step 1: Write RED candidate preservation test**

```ts
it("snapshots candidate bytes and leaves visible bytes untouched in observe mode", async () => {
  const path = `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-gate/DELIVERABLES/direct.md`;
  await mock.writeExternal(path, "# preserve me");
  const before = mock.files.get(path);

  const result = await reconcile(projectId);
  expect(result).toMatchObject({ candidates: 1, mutation_gate_mode: "observe" });
  expect(mock.files.get(path)).toBe(before);
  expect([...mock.files.keys()].some((p) => p.includes("/mutation-gate/payloads/candidates/"))).toBe(true);
});
```

Also assert candidate detection does not change canonical project revision.

- [ ] **Step 2: Write RED hot-cache-loss candidate replay test**

Delete any new SQLite candidate cache rows if added, then replay reconciliation and assert the same immutable Dropbox candidate is returned without duplicate payload/record.

- [ ] **Step 3: Implement mode parser**

In `src/env.ts` add the optional env type. In a focused helper (or `service.ts`) implement:

```ts
export function parseMutationGateMode(value: string | undefined): "observe" | "enforce" {
  if (value === undefined || value === "observe") return "observe";
  if (value === "enforce") return "enforce";
  throw new Error(`Unsupported PROJECT_OS_MUTATION_GATE_MODE: ${value}`);
}
```

Do not default to enforce.

- [ ] **Step 4: Wire `external_candidate` classification to repository capture**

For every candidate, call `captureCandidate()` before returning the reconcile summary. Add summary fields:

```ts
candidates: number;
mutation_gate_mode: "observe" | "enforce";
```

Observe and enforce use identical governance recognition. In this package, neither mode automatically deletes/moves an unknown candidate file. The difference is operational configuration/readiness, not unsafe destructive cleanup.

- [ ] **Step 5: Add compact candidate status/list endpoints**

Return only IDs, path-safe metadata, detection source, resolution state, and timestamps. Do not return candidate payload contents through status endpoints.

- [ ] **Step 6: Run focused tests GREEN**

```bash
npx vitest run test/mutation-gate-candidate.spec.ts test/document-change-coordinator.spec.ts test/index.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add src/mutation-gate/service.ts src/documents/change-coordinator.ts src/durable/project-guard.ts src/index.ts src/env.ts test/mutation-gate-candidate.spec.ts test/document-change-coordinator.spec.ts test/index.spec.ts
git commit -m "feat: preserve external mutation candidates"
```

---

### Task 6: Add typed, idempotent candidate resolution through normal governed services

**Files:**
- Create: `src/domain/mutation-candidate-resolution.ts`
- Create: `src/mutation-gate/resolution-service.ts`
- Modify: `src/durable/project-guard.ts`
- Modify: `src/index.ts`
- Test: `test/mutation-candidate-resolution.spec.ts`
- Extend: `test/project-guard-document.spec.ts`
- Extend: `test/project-guard-artifact.spec.ts`

**Interfaces:**
- Produces strict `MutationCandidateResolutionRequest` parser.
- ProjectGuard internal endpoint: `POST /mutation-candidate-resolution`.
- Public authenticated route: `POST /v1/mutation-candidates/resolve`.
- Resolution service calls existing artifact or managed-document service logic; it never writes a final provider path directly.

- [ ] **Step 1: Write RED adopt-as-artifact test**

```ts
it("adopts a text candidate only by committing a normal artifact request first", async () => {
  const candidate = await seedCandidate("# candidate artifact");
  const request = {
    operation: "candidate.adopt_artifact",
    resolution_id: "MUTRES-111111111111111111111111",
    project_id: projectId,
    candidate_id: candidate.candidate_id,
    artifact_request: await artifactRequest("ART-CANDIDATE-ADOPT-0001", "# candidate artifact")
  };

  const receipt = await resolve(request);
  expect(receipt).toMatchObject({ status: "committed", action: "adopt_as_artifact" });
  expect(await artifactReceipt("ART-CANDIDATE-ADOPT-0001")).toMatchObject({ status: "committed" });
});
```

- [ ] **Step 2: Write RED adopt-as-working test**

Nested document request must be `working.write`. Assert candidate adoption creates a WORKING managed document and `published_version_id` remains absent.

- [ ] **Step 3: Write RED reject and conflicting-resolution tests**

First `candidate.reject` writes immutable resolution. Exact replay returns the same result. A later `candidate.adopt_artifact` for the same candidate returns a deterministic conflict and performs no downstream write.

- [ ] **Step 4: Run RED resolution tests**

```bash
npx vitest run test/mutation-candidate-resolution.spec.ts test/project-guard-document.spec.ts test/project-guard-artifact.spec.ts
```

Expected: FAIL because resolution family/service/routes do not exist.

- [ ] **Step 5: Implement strict resolution parser**

```ts
export const mutationCandidateResolutionRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("candidate.adopt_artifact"),
    resolution_id: mutationResolutionIdSchema,
    project_id: projectIdSchema,
    candidate_id: mutationCandidateIdSchema,
    artifact_request: artifactWriteRequestSchema
  }),
  z.strictObject({
    operation: z.literal("candidate.adopt_working"),
    resolution_id: mutationResolutionIdSchema,
    project_id: projectIdSchema,
    candidate_id: mutationCandidateIdSchema,
    document_request: managedDocumentRequestSchema
  }).superRefine((value, ctx) => {
    if (value.document_request.operation !== "working.write") {
      ctx.addIssue({ code: "custom", message: "Candidate working adoption requires working.write" });
    }
  }),
  z.strictObject({
    operation: z.literal("candidate.reject"),
    resolution_id: mutationResolutionIdSchema,
    project_id: projectIdSchema,
    candidate_id: mutationCandidateIdSchema
  })
]);
```

Export the existing artifact/document schemas if necessary rather than duplicating validation rules.

- [ ] **Step 6: Implement candidate/downstream content binding**

Before adoption:

1. read immutable candidate record;
2. ensure no conflicting terminal resolution exists;
3. verify nested request project matches candidate project;
4. read candidate immutable payload only for supported text adoption;
5. compare exact content with nested request content and SHA-256;
6. call normal artifact/document service;
7. only after downstream committed receipt, safe-add `ExternalMutationResolutionRecord`.

If the candidate payload cannot be represented safely by the current text API, return a deterministic `CANDIDATE_CONTENT_UNSUPPORTED` conflict and preserve the candidate unchanged.

- [ ] **Step 7: Wire ProjectGuard and public route**

ProjectGuard keeps same-project serialization. `src/index.ts` public route authenticates with existing `INGRESS_TOKEN` and forwards to the bound `PROJECT_GUARD` Durable Object.

- [ ] **Step 8: Run resolution suites GREEN**

```bash
npx vitest run test/mutation-candidate-resolution.spec.ts test/project-guard-document.spec.ts test/project-guard-artifact.spec.ts test/document-lifecycle.spec.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 6**

```bash
git add src/domain/mutation-candidate-resolution.ts src/mutation-gate/resolution-service.ts src/durable/project-guard.ts src/index.ts test/mutation-candidate-resolution.spec.ts test/project-guard-document.spec.ts test/project-guard-artifact.spec.ts
git commit -m "feat: resolve mutation candidates through governed flows"
```

---

### Task 7: Enforce lifecycle terminology and operator-routing contract

**Files:**
- Modify: `docs/project-os-sop.md`
- Modify: `docs/managed-documents.md`
- Create: `docs/mutation-gate.md`
- Modify: `src/index.ts` only if response metadata needs compact verification state
- Test: `test/mutation-gate-status.spec.ts`

**Interfaces:**
- Produces the normative operator/runtime status contract and runtime documentation.
- No new business semantics beyond the accepted B2 design.

- [ ] **Step 1: Write RED status-contract tests**

Test that:

- an ingress artifact intent without terminal receipt is reported as `submitted`, not `committed`;
- candidate detection reports `candidate`/unverified and never `published` or `accepted`;
- a committed candidate adoption can be verified through downstream receipt plus resolution evidence;
- no API field names a provider upload alone `accepted`.

- [ ] **Step 2: Run RED status test**

```bash
npx vitest run test/mutation-gate-status.spec.ts
```

- [ ] **Step 3: Add concise runtime status helpers if needed**

Use exact enums instead of prose parsing:

```ts
export type MutationVerificationState =
  | "submitted"
  | "committed"
  | "canonical_verified"
  | "external_candidate";
```

Do **not** manufacture an `accepted` runtime state unless the domain object has a real explicit acceptance lifecycle.

- [ ] **Step 4: Update SOP with operator routing invariant**

Add normative language:

```text
Project OS agent/operator writes must use typed transaction, artifact,
managed-document, or candidate-resolution ingress. A generic Dropbox write
into a governed final business destination is never an equivalent durable
Project OS mutation. If such a file appears, treat it as external/unverified
until ProjectGuard evidence proves otherwise.
```

Also document exact `SUBMITTED -> COMMITTED -> CANONICAL VERIFIED -> ACCEPTED` distinctions.

- [ ] **Step 5: Document runtime design and recovery**

`docs/mutation-gate.md` must include:

- surface classification;
- hidden ledger paths;
- intent-before-effect ordering;
- baseline/cursor-reset rule;
- candidate capture and resolution;
- observe/enforce semantics;
- crash recovery;
- rollback;
- PRJ-0003 repair procedure after production validation;
- SECURITY and SCHEMA boundaries.

- [ ] **Step 6: Run status/docs-adjacent regression tests GREEN**

```bash
npx vitest run test/mutation-gate-status.spec.ts test/index.spec.ts test/project-guard-artifact.spec.ts test/project-guard-document.spec.ts
```

- [ ] **Step 7: Commit Task 7**

```bash
git add docs/project-os-sop.md docs/managed-documents.md docs/mutation-gate.md src/index.ts test/mutation-gate-status.spec.ts
git commit -m "docs: define mutation gate operating contract"
```

---

### Task 8: Prove crash recovery, baseline/reset safety, and multi-project isolation

**Files:**
- Create: `test/mutation-gate-acceptance.spec.ts`
- Create: `test/mutation-gate-faults.spec.ts`
- Extend: `test/write-coordination-stress.spec.ts`
- Extend: `test/helpers/mock-dropbox.ts`

**Interfaces:** none new; this is the package acceptance gate.

- [ ] **Step 1: Add end-to-end PRJ-0003-shaped bypass acceptance test**

Use a fresh isolated test project with a governed artifact route. Directly inject:

```text
DELIVERABLES/REVENUE-OS/.../01a-kit-execution-avis-temoignages.md
DELIVERABLES/REVENUE-OS/.../02a-kit-execution-referral-recommandation.md
ARTIFACTS/plan-action-executabilite-revenue-os.md
```

Assert:

- all three bytes are preserved;
- all three become external candidates where the configured final-zone policy applies;
- none creates a canonical project revision;
- none creates an accepted decision;
- none gets an artifact committed receipt;
- none gets an implicit published managed-document pointer.

- [ ] **Step 2: Add first-baseline and cursor-reset acceptance cases**

Prove the same files remain candidates when present before the initial baseline and when replayed after an injected `DropboxCursorResetError`.

- [ ] **Step 3: Add artifact crash-after-provider-write test**

Inject failure after visible provider create but before managed artifact/version/receipt completion. Assert durable intent exists first. Exact replay repairs the same request/destination and no candidate is created.

- [ ] **Step 4: Add route-change-during-recovery test**

After the interrupted artifact write, apply a different route to the test state before replay. Assert the old intent's frozen destination is used and the new route is not silently chosen.

- [ ] **Step 5: Add managed publish crash regression**

Reuse the current managed-document fault shape. Ensure MutationGate classifier treats the interrupted publication as governed-inflight and leaves existing exact replay repair intact.

- [ ] **Step 6: Add candidate resolution/replay matrix**

Cover exact replay, reject, adopt artifact, adopt working, conflicting second resolution, unsupported content, and cache loss.

- [ ] **Step 7: Add 50-operation multi-project stress test**

Run mixed operations across two projects:

- governed artifact writes;
- managed working writes;
- direct final-zone candidates;
- candidate resolutions;
- cursor reset on one project only.

Assert no intent/candidate/resolution path crosses project roots and no request/candidate ID is rebound.

- [ ] **Step 8: Run focused acceptance/fault/stress matrix**

```bash
npx vitest run \
  test/mutation-gate-acceptance.spec.ts \
  test/mutation-gate-faults.spec.ts \
  test/write-coordination-stress.spec.ts \
  test/managed-document-faults.spec.ts \
  test/document-change-coordinator.spec.ts
```

Expected: PASS.

- [ ] **Step 9: Run full repository verification**

```bash
npm run check
npx wrangler deploy --dry-run
```

Expected: both commands exit 0. Do not proceed to production with any failing suite.

- [ ] **Step 10: Commit Task 8**

```bash
git add test/mutation-gate-acceptance.spec.ts test/mutation-gate-faults.spec.ts test/write-coordination-stress.spec.ts test/helpers/mock-dropbox.ts
git commit -m "test: prove mutation gate acceptance and recovery"
```

---

### Task 9: Documentation PR, observe-mode production proof, enforcement gate, and canonical closure

**Files:**
- Modify: `docs/project-os-improvement-roadmap.md`
- Modify: `docs/deployment.md` only for exact mutation-gate config/recovery instructions
- Review: all files changed by Tasks 1-8
- Canonical Project OS changes: separate receipt-gated transactions only after production evidence

**Interfaces:** operational release gate only.

- [ ] **Step 1: Update roadmap truthfully before implementation PR merge**

Mark MUTATIONGATE as the active P0 item inserted before SCHEMA. Do not mark it complete until production proof and canonical closure exist.

- [ ] **Step 2: Review exact diff for forbidden behavior**

Check specifically for:

```text
- unconditional DELIVERABLES baseline -> published adoption
- raw final Dropbox writes from ChatGPT/operator-facing code paths
- candidate deletion/move before immutable preservation
- artifact provider write before durable mutation intent
- artifact replay that recomputes a changed route
- candidate detection that increments project business revision
- content/secret logging
- cross-project path construction
- new ProjectState schema dependency
```

- [ ] **Step 3: Open implementation PR from the isolated feature branch**

PR body must list exact acceptance suites, exact head SHA, expected production mode `observe`, and the statement that PRJ-0003 repair remains deferred until production validation.

- [ ] **Step 4: Verify exact PR head**

Run/verify on the exact PR head:

```bash
npm run check
npx wrangler deploy --dry-run
```

Require GitHub CI green for the exact SHA.

- [ ] **Step 5: Merge only the exact green SHA**

Use the repository's accepted merge method and record the merge SHA. Do not describe MUTATIONGATE as production-complete yet.

- [ ] **Step 6: Deploy with continuity stable and mutation gate observe**

Production configuration requirements:

```text
PROJECT_OS_CONTINUITY_MODE=stable
PROJECT_OS_MUTATION_GATE_MODE=observe
```

No connector permission change is part of this package rollout.

- [ ] **Step 7: Verify production health and read-only status**

Verify:

- `/health` returns ok;
- continuity reports `stable`;
- mutation gate reports `observe`;
- current project canonical revisions do not change merely from candidate inventory;
- managed document reconciliation remains healthy.

- [ ] **Step 8: Run non-destructive fleet candidate inventory**

Scan active projects. Record counts/IDs/path-safe metadata only. Do not adopt, reject, move, delete, or repair candidates during this proof.

- [ ] **Step 9: Validate false-positive rate against known governed writes**

Create isolated governed artifact and managed-document test operations through normal ingress and verify they are never classified as candidates. Inject one isolated raw final-zone test file and verify it becomes a candidate without publication/canonicalization.

- [ ] **Step 10: Request explicit enforcement approval**

Present production evidence. Do not switch `PROJECT_OS_MUTATION_GATE_MODE=enforce` until the user explicitly accepts the production behavior and any inventory implications.

- [ ] **Step 11: After explicit approval, activate enforce and repeat production proof**

Keep continuity `stable`. Re-run governed-write and raw-bypass tests. Roll back to `observe` on unexpected classification behavior.

- [ ] **Step 12: Record PRJ-0002 production evidence through typed transactions**

Refresh PRJ-0002 canonical revision first. Add accepted research/proof and complete `TASK-IMPMUTATIONGATE001` only when receipt status is committed and exact GitHub merge/deploy evidence is known.

- [ ] **Step 13: Repair PRJ-0003 only after MUTATIONGATE closure**

Bind PRJ-0003 separately, refresh its canonical state/revision, inventory the known direct files as candidates, preserve bytes, and route accepted business content through explicit governed adoption. Do not resubmit `DEC-EXECUTABILITY001`; it is already committed/accepted.

- [ ] **Step 14: Revalidate SCHEMA**

Return to PRJ-0002, refresh canonical revision, add the new mutation-gate record families to SCHEMA family compatibility/recovery review, and request explicit approval for the still-withheld SCHEMA rollout/implementation section.

---

## Plan self-review checklist

Before implementation approval is requested, verify this plan against the B2 spec:

- every unknown final-zone path is classified before published bootstrap;
- artifact intent is durable before provider effect;
- resolved artifact destination is frozen for replay;
- candidate bytes are preserved server-side before resolution;
- candidate capture does not change ProjectState revision;
- baseline and cursor reset cannot legitimize an unknown deliverable;
- managed-document crash recovery is preserved;
- candidate resolution calls normal governed services;
- observe mode is the first production mode;
- no automatic destructive candidate cleanup exists;
- SECURITY anti-forgery work remains separate;
- SCHEMA remains blocked until post-MUTATIONGATE revalidation.

## Execution handoff

After the user reviews and explicitly approves this written spec and plan, execute in a **separate isolated implementation branch/worktree**. Recommended execution mode is subagent-driven development with a fresh reviewer gate per task; inline execution is acceptable if each task preserves the same TDD and review boundaries.
