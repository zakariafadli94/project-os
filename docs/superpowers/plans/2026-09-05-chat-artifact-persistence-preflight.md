# Chat Artifact Persistence Preflight and Binary Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent unsupported bulk generation and add a governed, replay-safe path for opaque binary artifacts staged in Dropbox.

**Architecture:** Preserve the inline text artifact flow and extend `ArtifactWriteRequest` with a discriminated staged-object variant. A focused staged-artifact service validates immutable provider metadata, records the existing MutationGate intent, copies opaque bytes server-side to the frozen governed destination, verifies final provider evidence, and cleans staging only after the terminal receipt is durable. The generated operating contract adds a current-chat canary gate before qualifying bulk work.

**Tech Stack:** TypeScript, Zod, Cloudflare Workers, Durable Objects, Dropbox provider adapter, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-05-chat-artifact-persistence-preflight-design.md`

## Global Constraints

- Existing inline text `POST /v1/artifacts` requests remain compatible.
- Binary bytes never pass through text decoding or direct final-zone writes.
- Staged presence is not publication, canonical verification, or acceptance.
- ProjectGuard remains the single serialized artifact publication boundary.
- MutationGate intent is durable before the final provider effect.
- A staged source must match request ID, stable object ID, revision token, size, integrity algorithm, and integrity value.
- `PROJECT_OS_BINARY_ARTIFACT_INGRESS_MODE` defaults to `off`.
- Source cleanup occurs only after a committed receipt and verified final provider evidence.
- PRJ-0003 recovery is not part of this implementation package.
- No deployment, mode activation, recovery, or canonical closure is implied by completing this plan.

---

### Task 1: Staged artifact request contract and safe layout

**Files:**
- Modify: `src/domain/artifact-write.ts`
- Modify: `src/persistence/layout.ts`
- Modify: `src/env.ts`
- Modify: `wrangler.jsonc`
- Create: `test/artifact-domain.spec.ts`
- Create: `test/layout.spec.ts`

**Interfaces:**
- Consumes: existing artifact identifiers, safe relative paths, provider observation vocabulary.
- Produces: `InlineArtifactWriteRequest`, `StagedArtifactWriteRequest`, `ArtifactWriteRequest`, `isStagedArtifactWriteRequest()`, and `machineArtifactStagingPath(requestId, fileName)`.

- [ ] **Step 1: Write failing request-schema tests**

Add cases proving that the current inline request still parses and the following staged shape parses:

```ts
const staged = parseArtifactWriteRequest({
  request_id: "ART-BINARY-000001",
  project_id: "PRJ-0003",
  relative_path: "DELIVERY/example.pdf",
  content_sha256: "a".repeat(64),
  source: {
    kind: "staged_provider_object",
    path: "/PROJECT_OS/.project-os/artifacts/staging/ART-BINARY-000001/example.pdf",
    object_id: "id:source",
    revision_token: "rev-1",
    size: 123,
    integrity: { algorithm: "dropbox-content-hash", value: "provider-hash" }
  },
  mode: "create"
});
expect(isStagedArtifactWriteRequest(staged)).toBe(true);
```

Reject mixed `content` + `source`, absent `content_sha256`, unsafe source paths, a staging request-ID mismatch, empty integrity fields, negative/unsafe sizes, and extra fields.

- [ ] **Step 2: Run the schema tests and verify RED**

Run: `npm test -- test/artifact-domain.spec.ts`

Expected: FAIL because the staged union and type guard do not exist.

- [ ] **Step 3: Implement the discriminated union**

Keep the current inline schema unchanged and add:

```ts
export const stagedArtifactWriteRequestSchema = artifactBase.extend({
  content_sha256: hash,
  source: z.strictObject({
    kind: z.literal("staged_provider_object"),
    path: stagedPath,
    object_id: z.string().min(1),
    revision_token: z.string().min(1),
    size: z.number().int().nonnegative().safe(),
    integrity: z.strictObject({
      algorithm: z.string().min(1),
      value: z.string().min(1)
    })
  })
});
```

Use a union that cannot accept both payload forms. Make the staging-path refinement require `/PROJECT_OS/.project-os/artifacts/staging/<request_id>/<safe-file-name>` for the same request ID.

- [ ] **Step 4: Add the layout helper and default-off environment contract**

Add `machineArtifactStagingPath(requestId, fileName)` with the existing safe request-ID validator and a new single-segment safe filename validator. Add:

```ts
PROJECT_OS_BINARY_ARTIFACT_INGRESS_MODE?: "on" | "off";
PROJECT_OS_BINARY_ARTIFACT_MAX_BYTES?: string;
```

Set both Wrangler vars to `off` and `10485760` respectively. This commit must not enable production behavior.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm test -- test/artifact-domain.spec.ts test/layout.spec.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/artifact-write.ts src/persistence/layout.ts src/env.ts wrangler.jsonc test/artifact-domain.spec.ts test/layout.spec.ts
git commit -m "feat(artifact): define staged binary request contract"
```

---

### Task 2: Provider-evidence validation and opaque publication service

**Files:**
- Create: `src/artifacts/staged-publication.ts`
- Modify: `src/persistence/provider/contract.ts`
- Modify: `src/persistence/provider/capabilities.ts`
- Modify: `src/persistence/providers/dropbox/adapter.ts`
- Modify: `test/helpers/persistence-runtime.ts`
- Test: `test/staged-artifact-publication.spec.ts`
- Test: `test/dropbox-provider-adapter.spec.ts`

**Interfaces:**
- Consumes: `StagedArtifactWriteRequest`, `ResolvedArtifactDestination`, `ProjectOsPersistenceRuntime`.
- Produces: `StagedArtifactPublisher.publish(request, destination): Promise<"written" | "idempotent">` and `verifyProviderObservation(expected, actual)`.

- [ ] **Step 1: Write failing exact-evidence tests**

Build a fake provider runtime with metadata and copy spies. Test exact success plus one test for each mismatch: missing metadata, path, object ID, revision token, size, integrity algorithm, and integrity value. Assert every mismatch occurs before `copyObject`.

- [ ] **Step 2: Write failing publication/replay tests**

Cover:

```ts
await expect(publisher.publish(request, destination)).resolves.toBe("written");
expect(runtime.serverSideCopy.copyObject).toHaveBeenCalledWith(
  request.source.path,
  destination.path
);
```

Also require:

- create conflict when a different destination object already exists;
- idempotent replay when destination evidence exactly matches source evidence;
- post-copy final metadata mismatch to fail without deleting the source;
- no call to `readText`, `createText`, or `upsertText` for the binary object.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm test -- test/staged-artifact-publication.spec.ts test/dropbox-provider-adapter.spec.ts`

Expected: FAIL because the staged publisher and explicit verified-copy result do not exist.

- [ ] **Step 4: Implement the focused publisher**

Create:

```ts
export class StagedArtifactPublisher {
  constructor(private readonly runtime: ProjectOsPersistenceRuntime) {}

  async publish(
    request: StagedArtifactWriteRequest,
    destination: ResolvedArtifactDestination
  ): Promise<"written" | "idempotent">;
}
```

The service must compare `ProviderObjectMetadata` structurally and use `serverSideCopy.copyObject`. Do not read bytes as text. For `replace`, preserve the existing archive rules by copying the observed destination to the frozen archive or rollback path, verifying the copy, and removing the original only through an identity-and-revision-conditioned delete before publication; do not overwrite through `upsertText`. Before restoring after a failed publication, persist request-specific rollback evidence tied to the exact governed backup. MutationGate may recognize the restored bytes only while that evidence and backup remain exact and no terminal receipt exists.

- [ ] **Step 5: Strengthen the copy capability contract**

Keep `copyObject(from, to)` provider-neutral but document and test that it copies opaque provider bytes and returns destination metadata. The Dropbox adapter continues to call `/files/copy_v2`; no content download is introduced.

- [ ] **Step 6: Run focused tests and static persistence guard**

Run: `npm test -- test/staged-artifact-publication.spec.ts test/dropbox-provider-adapter.spec.ts && npm run check:persistence-boundary`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/artifacts/staged-publication.ts src/persistence/provider/contract.ts src/persistence/provider/capabilities.ts src/persistence/providers/dropbox/adapter.ts test/helpers/persistence-runtime.ts test/staged-artifact-publication.spec.ts test/dropbox-provider-adapter.spec.ts
git commit -m "feat(artifact): publish staged bytes through provider copy"
```

---

### Task 3: Durable intent, status verification, and terminal cleanup

**Files:**
- Modify: `src/mutation-gate/artifact-intent.ts`
- Modify: `src/mutation-gate/service.ts`
- Modify: `src/persistence/repository.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Test: `test/artifact-mutation-intent.spec.ts`
- Test: `test/mutation-gate-artifact-status.spec.ts`
- Test: `test/project-guard-artifact.spec.ts`
- Test: `test/staged-artifact-faults.spec.ts`

**Interfaces:**
- Consumes: staged request union and `StagedArtifactPublisher`.
- Produces: existing artifact receipt shape plus binary-aware `canonical_verified` status and safe post-terminal cleanup.

- [ ] **Step 1: Write the failing intent compatibility tests**

Prove that staged request JSON is frozen in the existing intent `request_json`, request-ID reuse with different source evidence conflicts, and `expected_content_sha256` retains the client-declared whole-file SHA-256 for audit compatibility. Assert the writer stage still produces a valid current MutationIntent V2 record; do not add fields to the strict persisted intent schema.

- [ ] **Step 2: Write failing binary status tests**

For a staged request, `artifactStatus()` must parse `intent.request_json`, obtain final provider metadata, and return `canonical_verified` only when final size and provider integrity exactly match the frozen source evidence. It must not call `readText()` on the binary destination.

- [ ] **Step 3: Write fault-boundary tests**

Add failpoints for:

- after durable intent and before copy;
- after copy and before receipt;
- after receipt and before final verification;
- after final verification and before staging cleanup.

For each case, replay the exact request and assert one final object, one compatible intent, one terminal receipt, and cleanup only after verification. A mutated staging revision on replay must reject and remain preserved.

- [ ] **Step 4: Run the focused suites and verify RED**

Run: `npm test -- test/artifact-mutation-intent.spec.ts test/mutation-gate-artifact-status.spec.ts test/project-guard-artifact.spec.ts test/staged-artifact-faults.spec.ts`

Expected: FAIL on missing binary branching and cleanup sequencing.

- [ ] **Step 5: Integrate staged publication into the repository**

In `PersistenceRepository.writeArtifact`, preserve this order:

```ts
const prepared = await intents.prepare(state, request);
await mutationGate.assertDestinationClear(replayState, prepared.destination.path, resolutionContext);
return isStagedArtifactWriteRequest(request)
  ? stagedPublisher.publish(request, prepared.destination)
  : writeExistingInlineFlow(...);
```

The managed Markdown compatibility writer must receive only inline requests. Binary requests targeting a managed zone use opaque publication evidence and must not invoke Markdown identity enrichment.

- [ ] **Step 6: Implement binary-aware status and cleanup**

Use final provider metadata for binary verification. Keep the existing SHA-256 text readback for inline requests. ProjectGuard writes the committed receipt, verifies status, then deletes the exact staged source only if its current metadata still matches the frozen source observation. If cleanup fails transiently, retain the committed receipt and retry cleanup idempotently.

- [ ] **Step 7: Run focused suites and high-risk persistence tests**

Run: `npm test -- test/artifact-mutation-intent.spec.ts test/mutation-gate-artifact-status.spec.ts test/project-guard-artifact.spec.ts test/staged-artifact-faults.spec.ts && npm run test:persistence-high-risk`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/mutation-gate/artifact-intent.ts src/mutation-gate/service.ts src/persistence/repository.ts src/durable/project-guard-neutral.ts test/artifact-mutation-intent.spec.ts test/mutation-gate-artifact-status.spec.ts test/project-guard-artifact.spec.ts test/staged-artifact-faults.spec.ts
git commit -m "feat(artifact): govern staged binary publication lifecycle"
```

---

### Task 4: Default-off ingress policy and bounded intake

**Files:**
- Modify: `src/index-neutral.ts`
- Modify: `src/inbox/runtime.ts`
- Modify: `src/inbox/processor.ts`
- Create: `src/artifacts/policy.ts`
- Test: `test/index.spec.ts`
- Create: `test/inbox.spec.ts`
- Test: `test/artifact-binary-policy.spec.ts`

**Interfaces:**
- Consumes: `PROJECT_OS_BINARY_ARTIFACT_INGRESS_MODE`, `PROJECT_OS_BINARY_ARTIFACT_MAX_BYTES`, parsed artifact requests.
- Produces: `parseBinaryArtifactPolicy(env)` and deterministic rejection codes `BINARY_ARTIFACT_INGRESS_DISABLED` and `BINARY_ARTIFACT_TOO_LARGE`.

- [ ] **Step 1: Write failing default-off and size-limit tests**

Assert that inline text remains accepted while staged requests are rejected when the mode is absent or `off`. With mode `on`, accept size `<= maxBytes` and reject size `> maxBytes` before routing to ProjectGuard.

- [ ] **Step 2: Write failing inbox-terminalization tests**

An invalid, disabled, or oversized staged manifest must move to the normal rejected terminal area with one deterministic receipt. It must not block later transaction or text-artifact work items.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm test -- test/index.spec.ts test/inbox.spec.ts test/artifact-binary-policy.spec.ts`

Expected: FAIL because binary policy parsing is absent.

- [ ] **Step 4: Implement policy parsing at both ingress boundaries**

Use one shared parser for the public API and Dropbox inbox. Reject before Durable Object dispatch. The maximum must be a positive safe integer; an invalid configured value fails composition rather than silently removing the limit.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm test -- test/index.spec.ts test/inbox.spec.ts test/artifact-binary-policy.spec.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index-neutral.ts src/inbox/runtime.ts src/inbox/processor.ts src/artifacts/policy.ts test/index.spec.ts test/inbox.spec.ts test/artifact-binary-policy.spec.ts
git commit -m "feat(artifact): gate binary ingress with bounded policy"
```

---

### Task 5: Current-chat persistence preflight contract

**Files:**
- Modify: `src/render/operating.ts`
- Modify: `src/render/handoff.ts`
- Modify: `docs/operational-activation.md`
- Modify: `docs/project-os-sop.md`
- Modify: `README.md`
- Create: `test/human-views.spec.ts`
- Create: `test/operating-contract.spec.ts`

**Interfaces:**
- Consumes: current project rendering and activation vocabulary.
- Produces: operating contract version `3` with a discoverable persistence-preflight section.

- [ ] **Step 1: Write failing operating-contract tests**

Assert that rendered `OPERATING.md` requires a current-chat canary before opaque binary output, more than ten files, more than fifteen minutes before first persistence, or a gate-dependent package. Require the exact state distinction:

```text
LOCAL_GENERATED -> STAGED -> SUBMITTED -> COMMITTED -> CANONICAL_VERIFIED -> ACCEPTED
```

Also assert that a text canary cannot authorize binary production and that missing capability stops work before bulk generation.

- [ ] **Step 2: Run focused rendering tests and verify RED**

Run: `npm test -- test/human-views.spec.ts test/operating-contract.spec.ts`

Expected: FAIL because contract version 2 lacks persistence preflight.

- [ ] **Step 3: Update the generated contract and bootstrap wording**

Increment `OPERATING_CONTRACT_VERSION` to `3`. Add compact instructions for the canary, receipt gate, final readback, failure behavior, and current-chat tool discovery. Keep canonical routing and session-binding language unchanged.

- [ ] **Step 4: Update durable documentation**

Document both client operations:

```text
upload opaque bytes to machine staging
write/call immutable artifact manifest
wait for committed receipt
verify canonical status
only then count the artifact as durable
```

Explicitly forbid direct final-zone upload and any claim that local generation equals persistence.

- [ ] **Step 5: Run rendering tests and materialization regressions**

Run: `npm test -- test/human-views.spec.ts test/operating-contract.spec.ts test/materialization-reconcile.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/render/operating.ts src/render/handoff.ts docs/operational-activation.md docs/project-os-sop.md README.md test/human-views.spec.ts test/operating-contract.spec.ts
git commit -m "docs(operating): require persistence canary before bulk work"
```

---

### Task 6: End-to-end proof package and rollout guard

**Files:**
- Create: `scripts/check-binary-artifact-ingress-gates.mjs`
- Modify: `package.json`
- Modify: `docs/deployment.md`
- Create: `docs/binary-artifact-ingress.md`
- Test: `test/staged-artifact-e2e.spec.ts`
- Create: `test/production-promotion-authority.spec.ts`

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: static rollout gate, full E2E test, operator evidence checklist, and rollback contract.

- [ ] **Step 1: Write a failing E2E test**

Exercise the real Worker entrypoint and Durable Object path with a mock opaque staged object. Assert:

- disabled-by-default rejection;
- enabled canary submission;
- intent before copy;
- committed receipt;
- `canonical_verified` final status;
- staging cleanup after verification;
- exact replay;
- no text decoding of binary bytes.

- [ ] **Step 2: Write the static rollout gate**

The script must fail unless:

- Wrangler defaults binary ingress to `off`;
- a positive byte limit exists;
- deployment documentation orders deploy before enablement;
- production promotion requires a separately authorized canary;
- PRJ-0003 recovery is explicitly outside automatic deployment.

- [ ] **Step 3: Run new gates and verify RED**

Run: `npm test -- test/staged-artifact-e2e.spec.ts test/production-promotion-authority.spec.ts && node scripts/check-binary-artifact-ingress-gates.mjs`

Expected: FAIL until the full path and rollout documentation are connected.

- [ ] **Step 4: Complete E2E wiring and operator documentation**

Add `check:binary-artifact-ingress` to `package.json` and include it in `npm run check`. Document the exact deployment evidence sequence: CI, version upload, zero-traffic/default-off validation, controlled enablement, one harmless canary, committed receipt, canonical verification, readback, cleanup, and rollback.

- [ ] **Step 5: Run complete verification**

Run:

```bash
npm run types
npm run typecheck
npm run check:persistence-boundary
npm run check:production-promotion-authority
npm run check:mutation-gate-repair-workflow
npm run check:index001-remediation
npm run check:binary-artifact-ingress
npm run test:persistence-high-risk
npm test
git diff --check origin/main...HEAD
```

Expected: all commands exit `0`; no generated or untracked runtime type file remains.

- [ ] **Step 6: Request independent code review**

The reviewer must verify source immutability, intent-before-effect ordering, exact replay, conflict behavior, default-off rollout, lack of binary text decoding, and separation of PRJ-0003 recovery.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-binary-artifact-ingress-gates.mjs package.json docs/deployment.md docs/binary-artifact-ingress.md test/staged-artifact-e2e.spec.ts test/production-promotion-authority.spec.ts
git commit -m "test(artifact): gate binary ingress rollout"
```

## Plan self-review

- Spec coverage: preflight, binary staging, immutable evidence, ProjectGuard serialization, MutationGate status, cleanup, activation, rollback, and separate PRJ-0003 recovery are each mapped to a task.
- Placeholder scan: no deferred implementation placeholders are present.
- Type consistency: the request type guard, staged publisher signature, provider metadata fields, policy variables, receipt vocabulary, and status names are consistent across tasks.
- Scope boundary: this plan implements platform capability only; it does not recover or publish the reported PRJ-0003 bundle.

## Execution handoff

Plan complete. Execute task-by-task using `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Do not begin implementation until the user explicitly authorizes remediation on this branch.
