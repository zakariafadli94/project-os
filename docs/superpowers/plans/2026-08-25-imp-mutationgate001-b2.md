# IMP-MUTATIONGATE001 B2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Project OS mutation gate that prevents raw provider files from silently becoming governed truth, preserves unknown final-zone writes as explicit external candidates, and gives artifact writes durable pre-effect provenance for deterministic recovery.

**Architecture:** Extend IMP-ARTIFACT001 rather than replacing it. Add an independently versioned mutation-gate ledger for artifact intents, external candidates, immutable candidate payloads, and resolutions; classify final-zone provider changes before DELIVERABLE bootstrap; keep collaborative zones under the existing managed-document reconciler; and resolve candidates only by re-entering normal artifact or managed-document services. Production starts in `observe` mode while continuity remains `stable`.

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
- An unresolved candidate at a destination path must block ordinary artifact/document replacement at that path; only an explicit candidate-resolution operation may adopt it.
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
- Produces `MutationIntentRecord`, `ExternalMutationCandidateRecord`, `ExternalMutationResolutionRecord`, strict parsers, `MutationDetectionSource`, and deterministic `mutationIntentIdFor()`, `mutationCandidateIdFor()`, and `mutationResolutionIdFor()` helpers.
- Produces `machineMutationGateRoot()`, `machineMutationIntentPath()`, `machineMutationIntentDestinationBindingRoot()`, `machineMutationCandidatePath()`, `machineMutationCandidatePayloadPath()`, and `machineMutationResolutionPath()`.

- [ ] **Step 1: Write RED domain tests**

Create `test/mutation-gate-domain.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  mutationCandidateIdFor,
  mutationIntentIdFor,
  mutationResolutionIdFor,
  parseExternalMutationCandidateRecord
} from "../src/domain/mutation-gate";

describe("mutation gate domain", () => {
  it("derives deterministic project-bound ids", async () => {
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

    const resolution = await mutationResolutionIdFor("PRJ-0002", candidate, "candidate.reject");
    expect(resolution).toMatch(/^MUTRES-[A-F0-9]{24}$/);
  });

  it("rejects candidate evidence bound to another project namespace", () => {
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
      immutable_payload_path: "/PROJECT_OS/.project-os/projects/PRJ-0003/mutation-gate/payloads/candidates/MUTCAND-111111111111111111111111/payload",
      detected_at: "2026-08-25T16:00:00+01:00"
    })).toThrow(/project/i);
  });
});
```

Extend `test/dropbox-paths.spec.ts` with exact expected mutation-gate paths and traversal/ID rejection.

- [ ] **Step 2: Run RED tests**

```bash
npx vitest run test/mutation-gate-domain.spec.ts test/dropbox-paths.spec.ts
```

Expected: FAIL because the domain file and layout helpers do not exist.

- [ ] **Step 3: Implement strict V1 record schemas and ID helpers**

Create `src/domain/mutation-gate.ts` with these core schemas:

```ts
import { z } from "zod";

const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const artifactRequestId = z.string().regex(/^ART-[A-Z0-9-]{10,}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const intentId = z.string().regex(/^MUTINT-[A-F0-9]{24}$/);
const candidateId = z.string().regex(/^MUTCAND-[A-F0-9]{24}$/);
const resolutionId = z.string().regex(/^MUTRES-[A-F0-9]{24}$/);

export const mutationDetectionSourceSchema = z.enum(["incremental", "baseline", "cursor_reset"]);
export type MutationDetectionSource = z.infer<typeof mutationDetectionSourceSchema>;

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
  detection_source: mutationDetectionSourceSchema,
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

Add `superRefine` checks that provider paths stay under the bound project's workspace and immutable payload paths stay under `/PROJECT_OS/.project-os/projects/<PRJ>/mutation-gate/`.

Use the existing Web Crypto SHA-256 pattern for IDs.

- [ ] **Step 4: Add exact path helpers and validators**

In `src/dropbox/layout.ts` add:

```ts
export function machineMutationGateRoot(projectId: string): string {
  return `${machineProjectRoot(projectId)}/mutation-gate`;
}

export function machineMutationIntentPath(projectId: string, requestId: string): string {
  return `${machineMutationGateRoot(projectId)}/intents/artifacts/${assertSafeArtifactRequestId(requestId)}.json`;
}

export function machineMutationIntentDestinationBindingRoot(projectId: string, pathHash: string): string {
  return `${machineMutationGateRoot(projectId)}/intent-bindings/destination/${assertSafeSha256(pathHash)}`;
}

export function machineMutationCandidatePath(projectId: string, candidateId: string): string {
  return `${machineMutationGateRoot(projectId)}/candidates/${assertSafeMutationCandidateId(candidateId)}.json`;
}

export function machineMutationCandidatePayloadPath(projectId: string, candidateId: string): string {
  return `${machineMutationGateRoot(projectId)}/payloads/candidates/${assertSafeMutationCandidateId(candidateId)}/payload`;
}

export function machineMutationResolutionPath(projectId: string, candidateId: string, resolutionId: string): string {
  return `${machineMutationGateRoot(projectId)}/resolutions/${assertSafeMutationCandidateId(candidateId)}/${assertSafeMutationResolutionId(resolutionId)}.json`;
}
```

Add exact regex validators for `MUTCAND-*` and `MUTRES-*`; reuse the existing artifact request and SHA-256 validators.

- [ ] **Step 5: Run GREEN tests**

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
- Consumes Task 1 schemas and path helpers.
- Produces `MutationGateRepository` methods:
  - `ensureArtifactIntent(record)`
  - `readArtifactIntent(projectId, requestId)`
  - `listArtifactIntentsForDestination(projectId, destinationPath)`
  - `captureCandidate(input)`
  - `readCandidate(projectId, candidateId)`
  - `writeResolution(record)`
  - `readResolutions(projectId, candidateId)`
  - `hasTerminalResolution(projectId, candidateId)`

- [ ] **Step 1: Write RED repository tests**

Create `test/mutation-gate-repository.spec.ts` with a transport that implements strict add, `getMetadata`, `copy`, and `listFolder`.

```ts
it("captures candidate bytes before immutable candidate metadata", async () => {
  const transport = new FakeMutationGateDropbox();
  const visible = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/direct.md";
  const metadata = transport.seed(visible, "direct bytes", "id:direct");
  const repo = new MutationGateRepository(transport);

  const result = await repo.captureCandidate({
    projectId: "PRJ-0002",
    detectionSource: "incremental",
    visiblePath: visible,
    metadata,
    detectedAt: "2026-08-25T16:10:00+01:00"
  });

  expect(result.created).toBe(true);
  expect(transport.copies).toEqual([{ from: visible, to: result.record.immutable_payload_path }]);
  expect(await repo.readCandidate("PRJ-0002", result.record.candidate_id)).toEqual(result.record);
});

it("replays the same candidate without duplicating payload evidence", async () => {
  const transport = new FakeMutationGateDropbox();
  const visible = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/direct.md";
  const metadata = transport.seed(visible, "direct bytes", "id:direct");
  const repo = new MutationGateRepository(transport);
  const input = {
    projectId: "PRJ-0002",
    detectionSource: "incremental" as const,
    visiblePath: visible,
    metadata,
    detectedAt: "2026-08-25T16:10:00+01:00"
  };

  const first = await repo.captureCandidate(input);
  const replay = await repo.captureCandidate(input);

  expect(replay.created).toBe(false);
  expect(replay.record.candidate_id).toBe(first.record.candidate_id);
  expect(transport.copies.filter((entry) => entry.to === first.record.immutable_payload_path)).toHaveLength(1);
});

it("rejects a second conflicting terminal resolution", async () => {
  const repo = seededRepositoryWithCandidate();
  await repo.writeResolution(rejectResolution("MUTRES-111111111111111111111111"));
  await expect(repo.writeResolution(adoptResolution("MUTRES-222222222222222222222222")))
    .rejects.toThrow(/conflicting terminal resolution/i);
});
```

Also add a test that the same artifact request ID cannot be rebound to different request JSON or destination.

- [ ] **Step 2: Run RED tests**

```bash
npx vitest run test/mutation-gate-repository.spec.ts
```

Expected: FAIL because `MutationGateRepository` does not exist.

- [ ] **Step 3: Implement safe-add repository semantics**

Core intent behavior:

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

`captureCandidate()` must:

1. derive deterministic candidate ID from project + file ID + provider rev;
2. derive hidden payload path;
3. server-side copy visible bytes to that path;
4. on copy conflict, verify existing payload metadata `content_hash` and size exactly match;
5. only then safe-add candidate JSON;
6. on candidate JSON replay, require semantic equality.

- [ ] **Step 4: Implement bounded destination intent lookup**

Hash the physical destination path with SHA-256. Store one immutable binding file per artifact request under that hash directory. `listArtifactIntentsForDestination()` lists only that directory and validates every referenced intent before returning it.

- [ ] **Step 5: Run GREEN tests**

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
- Test: `test/artifact-mutation-intent.spec.ts`
- Extend: `test/legacy-artifact-managed.spec.ts`
- Extend: `test/project-guard-artifact.spec.ts`

**Interfaces:**
- Produces `PreparedArtifactMutation { intent: MutationIntentRecord; destination: ResolvedArtifactDestination }`.
- Produces `ArtifactMutationIntentService.prepare(state, request)`.
- Changes `ProjectRepository.writeArtifact(state, request, destination?)` and `LegacyArtifactDocumentWriter.writeIfManaged(state, request, destination?)` so exact recovery can consume the frozen destination.

- [ ] **Step 1: Write RED intent-before-effect test**

```ts
it("persists mutation intent before the first visible artifact write", async () => {
  const mock = installDropboxMock();
  const project = await createRoutedProject();
  const guard = testEnv.PROJECT_GUARD.getByName(project.project_id);
  const artifact = await artifactRequest(project.project_id, "ART-MUTATION-INTENT-0001", "# governed");

  const response = await guard.fetch("https://project-guard.internal/artifact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(artifact)
  });
  expect(response.status).toBe(200);

  const intentIndex = mock.uploadCalls.findIndex((path) =>
    path.endsWith("/mutation-gate/intents/artifacts/ART-MUTATION-INTENT-0001.json")
  );
  const visibleIndex = mock.uploadCalls.findIndex((path) =>
    path.includes(`/WORKSPACE/PROJECTS/${project.project_id}-`) && path.endsWith("/DELIVERABLES/REVENUE-OS/foo.md")
  );
  expect(intentIndex).toBeGreaterThanOrEqual(0);
  expect(visibleIndex).toBeGreaterThan(intentIndex);
});
```

- [ ] **Step 2: Write RED route-drift recovery test**

Use an isolated state/repository fixture:

```ts
it("replays an interrupted artifact at its frozen original destination", async () => {
  const firstState = routedState("DELIVERABLES/REVENUE-OS");
  const request = await artifactRequest("PRJ-0003", "ART-ROUTE-DRIFT-0001", "# payload");
  const prepared = await intentService.prepare(firstState, request);
  await simulateProviderCreateOnly(prepared.destination.path, request.content);

  const changedState = routedState("DELIVERABLES/NEW-REVENUE-OS");
  const recovered = await repository.writeArtifact(changedState, request, prepared.destination);

  expect(recovered).toBe("idempotent");
  expect(dropbox.files.get(prepared.destination.path)).toBe("# payload");
  expect([...dropbox.files.keys()].some((path) => path.includes("/DELIVERABLES/NEW-REVENUE-OS/foo.md"))).toBe(false);
});
```

- [ ] **Step 3: Run RED artifact tests**

```bash
npx vitest run test/artifact-mutation-intent.spec.ts test/legacy-artifact-managed.spec.ts test/project-guard-artifact.spec.ts
```

Expected: FAIL because artifact intent/frozen-destination support does not exist.

- [ ] **Step 4: Implement `ArtifactMutationIntentService`**

```ts
export interface PreparedArtifactMutation {
  intent: MutationIntentRecord;
  destination: ResolvedArtifactDestination;
}

export class ArtifactMutationIntentService {
  constructor(private readonly repository: MutationGateRepository) {}

  async prepare(state: ProjectState, request: ArtifactWriteRequest): Promise<PreparedArtifactMutation> {
    const existing = await this.repository.readArtifactIntent(request.project_id, request.request_id);
    if (existing) {
      return { intent: existing, destination: destinationFromIntent(existing) };
    }

    const destination = resolveArtifactDestination(state, request.relative_path);
    const requestJson = JSON.stringify(request);
    const intent = await this.repository.ensureArtifactIntent({
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
    return { intent, destination };
  }
}
```

On replay, verify request JSON/hash matches the stored intent before returning `destinationFromIntent()`.

- [ ] **Step 5: Wire ProjectGuard before provider write**

In `handleArtifact`, after existing project/hash validation:

```ts
const prepared = await this.artifactMutationIntent.prepare(state, artifact);
await this.assertNoUnresolvedCandidateAtPath(state.project_id, prepared.destination.path);
await this.repository.writeArtifact(state, artifact, prepared.destination);
return this.finalizeArtifact(artifact, this.artifactReceipt(artifact, "committed"));
```

The candidate-collision helper is implemented in Task 5; until then use a local fail-closed stub covered by Task 5 RED tests, and keep Task 3 tests scoped to paths without candidates.

- [ ] **Step 6: Make repository and legacy writer honor frozen destination**

Change signatures to:

```ts
writeArtifact(
  state: ProjectState,
  request: ArtifactWriteRequest,
  destination?: ResolvedArtifactDestination
): Promise<"written" | "idempotent">;
```

and:

```ts
writeIfManaged(
  state: ProjectState,
  request: ArtifactWriteRequest,
  destination: ResolvedArtifactDestination = resolveArtifactDestination(state, request.relative_path)
): Promise<LegacyManagedArtifactWriteResult | null>;
```

Validate the frozen path is still inside `workspaceProjectRoot(state.project_id, state.slug)` before use.

- [ ] **Step 7: Run GREEN artifact suites**

```bash
npx vitest run test/artifact-mutation-intent.spec.ts test/legacy-artifact-managed.spec.ts test/artifact-routing.spec.ts test/project-guard-artifact.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/mutation-gate/artifact-intent.ts src/durable/project-guard.ts src/dropbox/repository.ts src/documents/legacy-artifact.ts test/artifact-mutation-intent.spec.ts test/legacy-artifact-managed.spec.ts test/project-guard-artifact.spec.ts
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
- Produces `FinalZoneMutationClassifier.classify(state, change, detectionSource)` returning `not_final_zone`, `governed_current`, `governed_inflight`, or `external_candidate`.
- Final-zone classification runs before any `published` bootstrap.

- [ ] **Step 1: Write RED incremental/baseline/reset table tests**

```ts
it.each([
  { source: "incremental" as const, reset: false },
  { source: "baseline" as const, reset: false },
  { source: "cursor_reset" as const, reset: true }
])("does not publish an unknown deliverable seen via $source", async ({ source, reset }) => {
  const fixture = await createChangeFixture({ seedBeforeBaseline: source !== "incremental", cursorReset: reset });
  if (source === "incremental") await fixture.establishBaseline();
  await fixture.writeExternalDeliverable("direct.md", "# bypass");

  const result = await fixture.reconcile();
  expect(result.candidates).toBe(1);
  expect(result.last_candidate_detection_source).toBe(source);

  const documentId = await documentIdFor(fixture.projectId, "direct.md");
  const status = await fixture.guard.fetch(`https://project-guard.internal/document-status?document_id=${documentId}`);
  expect(status.status).toBe(404);
});
```

- [ ] **Step 2: Write RED governed-inflight tests**

```ts
it("recognizes interrupted managed publish as governed inflight", async () => {
  const fixture = await createInterruptedManagedPublishFixture();
  const classification = await fixture.classifyPublishedChange();
  expect(classification).toMatchObject({ kind: "governed_inflight" });
  expect(await fixture.candidateCount()).toBe(0);
});

it("recognizes matching artifact intent as governed inflight", async () => {
  const fixture = await createInterruptedArtifactFixture();
  const classification = await fixture.classifyVisibleArtifactChange();
  expect(classification).toMatchObject({ kind: "governed_inflight", requestId: fixture.requestId });
  expect(await fixture.candidateCount()).toBe(0);
});
```

- [ ] **Step 3: Run RED tests**

```bash
npx vitest run test/mutation-gate-classifier.spec.ts test/document-change-coordinator.spec.ts test/document-bootstrap.spec.ts
```

Expected: current unknown DELIVERABLE behavior fails these assertions.

- [ ] **Step 4: Implement classifier**

```ts
export type FinalZoneClassification =
  | { kind: "not_final_zone" }
  | { kind: "governed_current" }
  | { kind: "governed_inflight"; requestId?: string }
  | { kind: "external_candidate" };

export class FinalZoneMutationClassifier {
  async classify(
    state: ProjectState,
    change: DropboxChangeEntry,
    detectionSource: MutationDetectionSource
  ): Promise<FinalZoneClassification> {
    const finalPath = classifyFinalBusinessPath(state, change.path);
    if (!finalPath || change.tag !== "file") return { kind: "not_final_zone" };
    if (await this.matchesManagedCurrent(state, finalPath, change)) return { kind: "governed_current" };
    if (await this.matchesManagedInflight(state, finalPath, change)) return { kind: "governed_inflight" };
    const artifactIntent = await this.matchArtifactIntent(state, finalPath, change);
    if (artifactIntent) return { kind: "governed_inflight", requestId: artifactIntent.request_id };
    return { kind: "external_candidate" };
  }
}
```

`matchArtifactIntent()` must verify physical destination and exact candidate content against stored artifact request content for this text-oriented artifact API; do not match by path alone.

- [ ] **Step 5: Remove unconditional published baseline adoption**

In `ManagedDocumentChangeCoordinator`, do not emit a generic `{ stage: "published" }` bootstrap candidate for every `DELIVERABLES/**` file. Route final-zone files through the classifier first.

Keep `WORKING`, `REVIEW`, and `REFERENCES` baseline compatibility adoption.

- [ ] **Step 6: Add explicit provenance requirement to published bootstrap**

Change signature:

```ts
bootstrapExistingManagedPath(
  state: ProjectState,
  visiblePath: string,
  metadata: DropboxFileMetadata,
  inferredStage: BootstrapManagedStage,
  options: { publishedProvenance?: "managed_recovery" | "legacy_artifact" } = {}
)
```

Fail closed when `inferredStage === "published"` and `publishedProvenance` is absent.

- [ ] **Step 7: Run GREEN classifier/bootstrap suites**

```bash
npx vitest run test/mutation-gate-classifier.spec.ts test/document-change-coordinator.spec.ts test/document-bootstrap.spec.ts test/document-external-edits.spec.ts test/managed-document-faults.spec.ts
```

Expected: PASS and existing managed edit/recovery behavior remains intact.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/mutation-gate/classifier.ts src/documents/change-coordinator.ts src/documents/bootstrap.ts test/mutation-gate-classifier.spec.ts test/document-change-coordinator.spec.ts test/document-bootstrap.spec.ts
git commit -m "feat: gate final-zone bootstrap by provenance"
```

---

### Task 5: Capture candidates, block unresolved-path overwrite, and expose compact status

**Files:**
- Create: `src/mutation-gate/service.ts`
- Modify: `src/documents/change-coordinator.ts`
- Modify: `src/durable/project-guard.ts`
- Modify: `src/index.ts`
- Modify: `src/env.ts`
- Test: `test/mutation-gate-candidate.spec.ts`
- Extend: `test/project-guard-artifact.spec.ts`
- Extend: `test/index.spec.ts`

**Interfaces:**
- Produces `MutationGateService.captureExternalCandidate()`, `assertDestinationClear()`, `status()`, and `listUnresolved()`.
- Adds `PROJECT_OS_MUTATION_GATE_MODE?: "observe" | "enforce"`, default `observe`.
- Adds ProjectGuard internal reads `GET /mutation-candidates` and `GET /mutation-candidate-status?candidate_id=...`.

- [ ] **Step 1: Write RED non-destructive capture test**

```ts
it("preserves candidate bytes and leaves visible bytes untouched", async () => {
  const fixture = await createGateFixture("observe");
  const path = await fixture.writeExternalDeliverable("direct.md", "# preserve me");
  const revisionBefore = await fixture.canonicalRevision();

  const result = await fixture.reconcile();

  expect(result).toMatchObject({ candidates: 1, mutation_gate_mode: "observe" });
  expect(fixture.mock.files.get(path)).toBe("# preserve me");
  expect(await fixture.canonicalRevision()).toBe(revisionBefore);
  expect([...fixture.mock.files.keys()].some((p) => p.includes("/mutation-gate/payloads/candidates/"))).toBe(true);
});
```

- [ ] **Step 2: Write RED unresolved destination collision test**

```ts
it("blocks normal artifact replace when the destination has an unresolved candidate", async () => {
  const fixture = await createRoutedGateFixture("observe");
  await fixture.writeExternalRoutedDeliverable("# external");
  await fixture.reconcile();

  const response = await fixture.postArtifact(await fixture.replaceArtifact("# governed replacement"));
  expect(await response.json()).toMatchObject({
    status: "conflict",
    code: "UNRESOLVED_EXTERNAL_CANDIDATE"
  });
  expect(await fixture.visibleContent()).toBe("# external");
});
```

Repeat the same test with mode `enforce`; both modes must preserve data correctness.

- [ ] **Step 3: Write RED cache-loss replay test**

Capture a candidate, delete any new mutation-gate SQLite cache rows if the implementation adds them, reconcile again, and assert the same candidate ID/payload remain with no duplicate immutable evidence.

- [ ] **Step 4: Implement mode parser**

```ts
export function parseMutationGateMode(value: string | undefined): "observe" | "enforce" {
  if (value === undefined || value === "observe") return "observe";
  if (value === "enforce") return "enforce";
  throw new Error(`Unsupported PROJECT_OS_MUTATION_GATE_MODE: ${value}`);
}
```

In V1, both modes enforce the same non-governance and unresolved-path collision rules. `observe` versus `enforce` is a rollout/readiness signal: observe reports candidates as warnings; enforce reports them as active policy violations. Neither mode automatically deletes unknown files.

- [ ] **Step 5: Wire `external_candidate` classification to immutable capture**

Add reconcile summary fields:

```ts
candidates: number;
mutation_gate_mode: "observe" | "enforce";
policy_violations: number;
last_candidate_detection_source?: MutationDetectionSource;
```

For `external_candidate`, call `captureExternalCandidate()` before cursor advancement.

- [ ] **Step 6: Implement unresolved-path guard**

```ts
async assertDestinationClear(projectId: string, destinationPath: string): Promise<void> {
  const unresolved = await this.listUnresolved(projectId, { destinationPath });
  if (unresolved.length > 0) {
    throw new UnresolvedExternalCandidateError(destinationPath, unresolved.map((item) => item.candidate_id));
  }
}
```

Call this guard before ordinary artifact writes to the destination. Candidate-resolution execution receives an explicit bypass capability object internal to `ProjectGuard`; do not expose a boolean `skipGuard` field in public request JSON.

- [ ] **Step 7: Add compact status/list endpoints**

Return candidate ID, project ID, path, detection source, detected time, gate mode, and resolution state. Do not return candidate payload contents through status endpoints.

- [ ] **Step 8: Run GREEN candidate/path-guard suites**

```bash
npx vitest run test/mutation-gate-candidate.spec.ts test/project-guard-artifact.spec.ts test/document-change-coordinator.spec.ts test/index.spec.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 5**

```bash
git add src/mutation-gate/service.ts src/documents/change-coordinator.ts src/durable/project-guard.ts src/index.ts src/env.ts test/mutation-gate-candidate.spec.ts test/project-guard-artifact.spec.ts test/index.spec.ts
git commit -m "feat: preserve and isolate external mutation candidates"
```

---

### Task 6: Add typed, idempotent candidate resolution through governed services

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
- Adds internal `POST /mutation-candidate-resolution` and public authenticated `POST /v1/mutation-candidates/resolve`.
- Resolution uses normal artifact/document service logic and never directly publishes a provider file.

- [ ] **Step 1: Write RED resolution parser tests**

```ts
it.each([
  {
    operation: "candidate.reject",
    resolution_id: "MUTRES-111111111111111111111111",
    project_id: "PRJ-0002",
    candidate_id: "MUTCAND-111111111111111111111111"
  },
  {
    operation: "candidate.adopt_artifact",
    resolution_id: "MUTRES-222222222222222222222222",
    project_id: "PRJ-0002",
    candidate_id: "MUTCAND-111111111111111111111111",
    artifact_request: {
      request_id: "ART-CANDIDATE-ADOPT-0001",
      project_id: "PRJ-0002",
      relative_path: "REVENUE-OS/direct.md",
      content: "# candidate",
      content_sha256: "a".repeat(64),
      mode: "create"
    }
  }
])("parses $operation", (request) => {
  expect(parseMutationCandidateResolutionRequest(request)).toMatchObject({ operation: request.operation });
});
```

Add a test that `candidate.adopt_working` rejects any nested managed-document operation other than `working.write`.

- [ ] **Step 2: Write RED service behavior tests**

```ts
it("records adopt-as-artifact only after downstream artifact commit", async () => {
  const fixture = await candidateResolutionFixture("# candidate artifact");
  const receipt = await fixture.resolveArtifact();

  expect(receipt).toMatchObject({ status: "committed", action: "adopt_as_artifact" });
  expect(await fixture.artifactReceipt()).toMatchObject({ status: "committed" });
  expect(await fixture.resolutionRecord()).toMatchObject({
    action: "adopt_as_artifact",
    downstream_receipt_status: "committed"
  });
});

it("adopt-as-working never creates a published pointer", async () => {
  const fixture = await candidateResolutionFixture("# candidate working");
  const receipt = await fixture.resolveWorking();
  const status = await fixture.documentStatus(receipt.document_id);

  expect(status.working_version_id).toBeDefined();
  expect(status.published_version_id).toBeUndefined();
});

it("reject is idempotent and blocks a later conflicting adoption", async () => {
  const fixture = await candidateResolutionFixture("# rejected");
  const first = await fixture.reject();
  expect(await fixture.reject()).toEqual(first);
  await expect(fixture.resolveArtifact()).rejects.toMatchObject({ code: "CANDIDATE_ALREADY_RESOLVED" });
});
```

- [ ] **Step 3: Run RED resolution tests**

```bash
npx vitest run test/mutation-candidate-resolution.spec.ts test/project-guard-document.spec.ts test/project-guard-artifact.spec.ts
```

Expected: FAIL because resolution domain/service/routes do not exist.

- [ ] **Step 4: Implement strict resolution request schema**

Reuse exported `artifactWriteRequestSchema` and `managedDocumentRequestSchema` rather than duplicating them.

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

- [ ] **Step 5: Implement resolution service with content binding**

For adoption:

1. read candidate and ensure same project;
2. fail if terminal resolution already exists unless exact replay;
3. read immutable candidate payload only for the current text-oriented nested APIs;
4. compare exact text and SHA-256 to nested artifact/document request;
5. execute normal artifact/document service with an internal `candidateResolutionContext` that authorizes bypass of the unresolved-path guard for this candidate only;
6. require downstream `status === "committed"`;
7. write immutable resolution record;
8. return a compact committed resolution receipt.

If candidate payload cannot be represented safely as text, return `CANDIDATE_CONTENT_UNSUPPORTED` and preserve candidate unchanged.

- [ ] **Step 6: Wire ProjectGuard and public route**

ProjectGuard keeps same-project serialization. `src/index.ts` authenticates with `INGRESS_TOKEN`, validates the request, and routes to the bound ProjectGuard.

- [ ] **Step 7: Run GREEN resolution suites**

```bash
npx vitest run test/mutation-candidate-resolution.spec.ts test/project-guard-document.spec.ts test/project-guard-artifact.spec.ts test/document-lifecycle.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 6**

```bash
git add src/domain/mutation-candidate-resolution.ts src/mutation-gate/resolution-service.ts src/durable/project-guard.ts src/index.ts test/mutation-candidate-resolution.spec.ts test/project-guard-document.spec.ts test/project-guard-artifact.spec.ts
git commit -m "feat: resolve mutation candidates through governed flows"
```

---

### Task 7: Prove terminology, crash recovery, PRJ-0003-shaped bypasses, and isolation

**Files:**
- Create: `test/mutation-gate-status.spec.ts`
- Create: `test/mutation-gate-acceptance.spec.ts`
- Create: `test/mutation-gate-faults.spec.ts`
- Extend: `test/write-coordination-stress.spec.ts`
- Extend: `test/helpers/mock-dropbox.ts`

**Interfaces:** no new runtime API; this is the acceptance gate.

- [ ] **Step 1: Add exact status vocabulary tests**

```ts
it("does not call a durable artifact intent committed before terminal receipt", async () => {
  const fixture = await interruptedArtifactIntentFixture();
  expect(await fixture.status()).toMatchObject({ verification_state: "submitted" });
  expect(JSON.stringify(await fixture.status())).not.toContain('"accepted"');
});

it("reports an external candidate as unverified rather than published", async () => {
  const fixture = await directCandidateFixture();
  expect(await fixture.status()).toMatchObject({ verification_state: "external_candidate" });
  expect(JSON.stringify(await fixture.status())).not.toContain('"published":true');
});
```

- [ ] **Step 2: Add PRJ-0003-shaped bypass acceptance test**

Inject these exact relative shapes into an isolated routed project:

```ts
const directPaths = [
  "DELIVERABLES/REVENUE-OS/04-playbooks-sectoriels/04b-pest-control/08-recurrence-reactivation-recommandation-support/01a-kit-execution-avis-temoignages.md",
  "DELIVERABLES/REVENUE-OS/04-playbooks-sectoriels/04b-pest-control/08-recurrence-reactivation-recommandation-support/02a-kit-execution-referral-recommandation.md",
  "ARTIFACTS/plan-action-executabilite-revenue-os-2026-08-25.md"
];

for (const path of directPaths) await fixture.writeExternal(path, `# direct ${path}`);
const revisionBefore = await fixture.canonicalRevision();
const result = await fixture.reconcile();
expect(result.candidates).toBe(3);
expect(await fixture.canonicalRevision()).toBe(revisionBefore);
expect(await fixture.publishedHeadCountFor(directPaths)).toBe(0);
expect(await fixture.artifactCommittedReceiptCountFor(directPaths)).toBe(0);
```

- [ ] **Step 3: Add baseline and cursor-reset regression tests**

Run the same unknown deliverable through first baseline and injected `DropboxCursorResetError`; assert candidate detection source differs but no published head is created.

- [ ] **Step 4: Add artifact crash-after-provider-write recovery test**

Inject failure after visible provider create and before managed artifact/version/receipt completion. Assert:

```ts
expect(await fixture.intentExists()).toBe(true);
expect(await fixture.candidateCount()).toBe(0);
const replay = await fixture.replayArtifact();
expect(replay).toMatchObject({ status: "committed" });
expect(await fixture.versionCountForRequest()).toBe(1);
```

- [ ] **Step 5: Add route-drift and managed-publish crash regressions**

Route drift must use stored artifact destination. Existing managed publish crash replay must remain `governed_inflight` and candidate count zero.

- [ ] **Step 6: Add 50-operation multi-project stress test**

```ts
for (let index = 0; index < 25; index += 1) {
  await Promise.all([
    projectA.writeGovernedArtifact(index),
    projectB.writeExternalCandidate(index)
  ]);
}
await Promise.all([projectA.reconcile(), projectB.reconcile()]);
expect(await projectA.foreignMutationGateRecordCount(projectB.projectId)).toBe(0);
expect(await projectB.foreignMutationGateRecordCount(projectA.projectId)).toBe(0);
expect(await projectA.duplicateIntentCount()).toBe(0);
expect(await projectB.duplicateCandidateCount()).toBe(0);
```

Also delete Durable Object hot caches and replay one artifact intent plus one candidate to prove Dropbox evidence remains authoritative.

- [ ] **Step 7: Run focused acceptance/fault/stress matrix**

```bash
npx vitest run \
  test/mutation-gate-status.spec.ts \
  test/mutation-gate-acceptance.spec.ts \
  test/mutation-gate-faults.spec.ts \
  test/write-coordination-stress.spec.ts \
  test/managed-document-faults.spec.ts \
  test/document-change-coordinator.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Run full repository gate**

```bash
npm run check
npx wrangler deploy --dry-run
```

Expected: both exit 0.

- [ ] **Step 9: Commit Task 7**

```bash
git add test/mutation-gate-status.spec.ts test/mutation-gate-acceptance.spec.ts test/mutation-gate-faults.spec.ts test/write-coordination-stress.spec.ts test/helpers/mock-dropbox.ts
git commit -m "test: prove mutation gate acceptance and recovery"
```

---

### Task 8: Operator docs, implementation PR, observe-mode production proof, enforcement gate, and canonical closure

**Files:**
- Create: `docs/mutation-gate.md`
- Modify: `docs/project-os-sop.md`
- Modify: `docs/managed-documents.md`
- Modify: `docs/project-os-improvement-roadmap.md`
- Modify: `docs/deployment.md`

**Interfaces:** release/operations gate only.

- [ ] **Step 1: Update SOP with exact operator routing invariant**

Add this normative rule:

```text
Project OS agent/operator writes must use typed transaction, artifact,
managed-document, or candidate-resolution ingress. A generic Dropbox write
into a governed final business destination is never an equivalent durable
Project OS mutation. If such a file appears, treat it as external/unverified
until ProjectGuard evidence proves otherwise.
```

Document exact `SUBMITTED`, `COMMITTED`, `CANONICAL VERIFIED`, and `ACCEPTED` distinctions.

- [ ] **Step 2: Write runtime/operator mutation-gate documentation**

`docs/mutation-gate.md` must explicitly include the B2 record paths, intent-before-effect ordering, final-zone classification, baseline/cursor-reset rule, unresolved-path guard, candidate resolution, observe/enforce semantics, crash recovery, rollback, PRJ-0003 repair sequence, SECURITY boundary, and SCHEMA boundary.

- [ ] **Step 3: Update managed-document docs and improvement roadmap truthfully**

State that unknown final-zone files are no longer eligible for implicit published bootstrap. Insert `IMP-MUTATIONGATE001` before `IMP-SCHEMA001` and mark it active/pending implementation until production proof exists.

- [ ] **Step 4: Update deployment docs with exact configuration**

Document:

```text
PROJECT_OS_CONTINUITY_MODE=stable
PROJECT_OS_MUTATION_GATE_MODE=observe
```

and rollback:

```text
PROJECT_OS_MUTATION_GATE_MODE=enforce -> observe
```

Do not document or require any new secret for B2.

- [ ] **Step 5: Review exact implementation diff before PR**

Reject the diff if any of these patterns exist:

```text
unconditional DELIVERABLES baseline -> published adoption
artifact provider write before durable mutation intent
artifact exact replay that recomputes a changed route
candidate deletion/move before immutable preservation
ordinary artifact/document overwrite of unresolved candidate path
candidate detection that increments ProjectState revision
content or secret logging
cross-project mutation-gate paths
ProjectState schema bump introduced by MUTATIONGATE
```

- [ ] **Step 6: Open implementation PR and verify exact head**

PR body must include exact head SHA, new/changed tests, `PROJECT_OS_MUTATION_GATE_MODE=observe`, continuity `stable`, and the statement that PRJ-0003 repair remains deferred.

Verify exact PR head:

```bash
npm run check
npx wrangler deploy --dry-run
```

Require GitHub CI green for that exact SHA before merge.

- [ ] **Step 7: Merge exact green SHA and deploy observe mode**

Deploy with continuity stable and gate mode observe. Verify `/health`, continuity status, mutation-gate mode, managed-document reconciliation, and that candidate inventory alone does not advance canonical project revisions.

- [ ] **Step 8: Run non-destructive production inventory and false-positive proof**

Inventory active-project candidates using IDs/path-safe metadata only. Then prove one normal governed artifact write and one normal managed-document publish are not candidates; prove one isolated raw final-zone test file is a candidate and remains non-governed.

- [ ] **Step 9: Request explicit enforcement approval**

Present observe evidence. Do not switch to `PROJECT_OS_MUTATION_GATE_MODE=enforce` until the user explicitly approves enforcement behavior.

- [ ] **Step 10: After approval, switch to enforce and repeat proof**

Keep continuity stable. If candidate classification unexpectedly catches governed writes, roll configuration back to observe and keep all durable candidate evidence.

- [ ] **Step 11: Canonically close MUTATIONGATE only after production proof**

Refresh PRJ-0002 revision. Add production research/evidence and complete `TASK-IMPMUTATIONGATE001` only through supported typed transactions with committed receipts and exact GitHub merge/deployment references.

- [ ] **Step 12: Repair PRJ-0003 separately**

Bind PRJ-0003, refresh its canonical revision, inventory the known direct files as candidates, preserve bytes, and route accepted content through explicit candidate adoption. Do not resubmit `DEC-EXECUTABILITY001`.

- [ ] **Step 13: Revalidate SCHEMA before resuming it**

Return to PRJ-0002, refresh canonical revision, include mutation-gate record families in SCHEMA compatibility/recovery review, and request explicit approval for the still-withheld SCHEMA rollout/implementation section.

---

## Plan self-review checklist

Before requesting implementation approval, verify:

- every unknown final-zone path is classified before published bootstrap;
- artifact intent is durable before provider effect;
- resolved artifact destination is frozen for replay;
- candidate bytes are preserved server-side before resolution;
- candidate capture does not change ProjectState revision;
- baseline and cursor reset cannot legitimize an unknown deliverable;
- ordinary writes cannot overwrite an unresolved candidate path;
- managed-document crash recovery remains intact;
- candidate resolution calls normal governed services;
- observe mode is the first production mode;
- no automatic destructive candidate cleanup exists;
- SECURITY anti-forgery work remains separate;
- SCHEMA remains blocked until post-MUTATIONGATE revalidation.

## Execution handoff

After the user reviews and explicitly approves this written spec and plan, execute in a **separate isolated implementation branch/worktree**. Recommended execution mode is subagent-driven development with a fresh reviewer gate per task; inline execution is acceptable if each task preserves the same TDD and review boundaries.
