# Chat Artifact Persistence Preflight and Binary Ingress Design

## Status

Proposed design for PRJ-0002. This document defines implementation scope only. It does not authorize production deployment, activation, canonical closure, or migration of the existing PRJ-0003 artifact bundle.

## Problem statement

The PRJ-0003 chat produced a large binary artifact set before proving that its active ChatGPT Dropbox tool surface could persist those files. The chat could read Dropbox and perform some non-destructive operations, but reported no usable arbitrary-file creation or binary-upload path for the generated outputs. Consequently, local generation was mistaken for durable availability, while the Dropbox `WORKING` head remained incomplete.

Project OS currently compounds this client limitation in two ways:

1. its operating contract tells chats to submit artifact requests but does not require a live persistence-capability proof before bulk production; and
2. `ArtifactWriteRequest` embeds `content` as a text string, so the governed artifact ingress is not a suitable transport for DOCX, XLSX, PPTX, PDF, or other opaque binary payloads.

This incident is separate from the Durable Objects `retryable_failure` observed during rebaseline and separate from IMP-INDEX001.

## Goals

- Fail closed before expensive generation when the active chat cannot demonstrate durable persistence.
- Provide a governed binary artifact path that preserves ProjectGuard serialization, artifact routing, MutationGate intent, idempotency, and terminal receipts.
- Distinguish local generation, staged provider presence, committed publication, canonical verification, and human acceptance.
- Keep the existing inline text artifact API compatible.
- Define a separate recovery route for the already-generated PRJ-0003 bundle without treating reported counts or hashes as verified facts.

## Non-goals

- Changing or repairing the ChatGPT or Dropbox connector implementation.
- Granting a chat credentials or tools it does not already possess.
- Allowing direct writes into governed `WORKING`, `REVIEW`, or `DELIVERABLES` paths.
- Automatically accepting, publishing, or migrating the reported PRJ-0003 artifacts.
- Replacing Dropbox as the production persistence provider.
- Activating search read mode or changing INDEX001 behavior.

## Design overview

The remediation has two independently gated parts:

1. **Persistence preflight contract** — every chat must prove the exact persistence path it will use before a bulk or binary production run.
2. **Staged binary artifact ingress** — the client uploads opaque bytes into a dedicated non-business staging area and submits a small immutable manifest. ProjectGuard validates immutable provider evidence and performs the governed server-side publication.

The preflight can ship before binary ingress. Until binary ingress is production-active and end-to-end verified, preflight must report binary governed publication as unavailable rather than route around the guard.

## Persistence preflight contract

### Trigger conditions

A chat must perform the preflight before any operation that meets at least one condition:

- produces one or more opaque binary files;
- produces more than ten files in one accepted work package;
- is expected to run for more than fifteen minutes before its first durable output;
- claims a gate, milestone, delivery package, or canonical handoff depends on generated files.

### Required proof

The preflight is an actual canary, not a verbal capability assertion. It must demonstrate:

1. the chat can create or upload one uniquely named canary through the intended ingress path;
2. ProjectGuard returns a terminal `committed` receipt;
3. status verification reaches `canonical_verified` for the canary;
4. the final provider object can be read back and its verified integrity evidence matches the request;
5. the canary is cleaned up only through the governed lifecycle when cleanup is supported.

For a mixed text/binary package, the binary path must be tested. A successful text canary does not prove binary persistence.

### Failure behavior

If any required step is unavailable or fails:

- do not start the bulk production run;
- report the exact missing capability or failed boundary;
- keep the intended deliverables as an unstarted plan rather than claiming production;
- do not fall back to direct final-zone Dropbox writes;
- require a new verified persistence path before resuming.

### Chat-visible activation

The generated `OPERATING.md` contract must expose a compact preflight section. The section must describe trigger conditions, proof states, failure behavior, and the rule that tool availability is checked in the current chat rather than inferred from another chat or a prior session.

## Staged binary artifact ingress

### Staging boundary

Binary bytes are uploaded only below:

```text
/PROJECT_OS/.project-os/artifacts/staging/<request_id>/<file_name>
```

This is a machine-managed, non-business staging area. Presence there is never publication, acceptance, a managed-document head, or canonical business state.

The client must use a fresh artifact `request_id`, a safe file name, and add-only upload semantics. A staging collision fails closed.

### Manifest

The client submits an immutable manifest to the existing artifact incoming queue or the authenticated artifact API. The binary variant contains:

```json
{
  "request_id": "ART-BINARY-000001",
  "project_id": "PRJ-0003",
  "relative_path": "DELIVERY/example.pdf",
  "source": {
    "kind": "staged_provider_object",
    "path": "/PROJECT_OS/.project-os/artifacts/staging/ART-BINARY-000001/example.pdf",
    "object_id": "id:provider-stable-id",
    "revision_token": "opaque-revision",
    "size": 12345,
    "integrity": {
      "algorithm": "dropbox-content-hash",
      "value": "provider-integrity-value"
    }
  },
  "mode": "create"
}
```

The existing inline text request remains unchanged. The schema is a discriminated union between inline text content and a staged provider object; the two payload forms cannot be mixed.

### Validation and publication flow

ProjectGuard processes a staged request in this order:

1. validate request syntax, project binding, safe logical destination, and staging-path ownership by `request_id`;
2. resolve the governed artifact route and freeze the final destination in durable intent evidence;
3. read current metadata for the staged object;
4. require exact matches for stable object ID, revision token, size, integrity algorithm, and integrity value;
5. reject any source outside the dedicated staging subtree;
6. create the normal durable artifact intent before the final provider effect;
7. use the provider's explicit server-side copy capability to publish the exact staged object to the frozen destination;
8. verify final metadata and integrity evidence;
9. write the normal terminal artifact receipt;
10. delete the staging source only after committed and canonical-verification evidence exists.

An interrupted operation replays from the durable intent. Exact matching final bytes complete idempotently. A different destination object is a conflict and is never overwritten by retry.

### Provider boundary

Core code consumes provider-neutral object metadata, stable-object-ID, revision-token, integrity-hash, and server-side-copy capabilities. Dropbox path syntax and `dropbox-content-hash` parsing remain inside the Dropbox adapter and compatibility seam.

The staged-object request persists the existing evidence fields and their explicit integrity algorithm. If the required persisted union cannot be added compatibly under the current schema writer stage, implementation must stop and route the schema change through the existing schema-version mechanism rather than silently extending schema `1.0`.

### Limits

- Maximum staged object size is an explicit configured limit and is enforced before publication.
- One manifest publishes one object. Batch orchestration submits independent request IDs so every artifact has independent idempotency and receipt evidence.
- Staging retention is bounded. Cleanup may remove only terminally committed/rejected staging objects whose durable evidence identifies the exact object ID and revision.
- Orphaned staging objects are reported for recovery; age alone does not authorize deletion.

## State semantics

The following states remain distinct:

```text
LOCAL_GENERATED
  -> STAGED
  -> SUBMITTED
  -> COMMITTED
  -> CANONICAL_VERIFIED
  -> ACCEPTED (only by an explicit business lifecycle rule)
```

`LOCAL_GENERATED` and `STAGED` are operational observations, not Project OS publication states. A manifest without a committed receipt is only `SUBMITTED`. A committed receipt without matching final provider evidence is `COMMITTED`, not `CANONICAL_VERIFIED`.

## PRJ-0003 recovery package

Recovery of the reported PRE-G8 bundle is a separate, explicitly authorized operation after the new binary path is production-active and end-to-end verified.

Recovery must:

1. inventory actual source files from the producing chat's local storage or attachments;
2. recompute per-file size and integrity evidence;
3. compare the observed inventory with the reported counts and bundle SHA-256 without assuming either is correct;
4. map each object to a governed logical destination and lifecycle state;
5. publish each object with a fresh idempotent binary artifact request;
6. retain per-object committed receipts and canonical-verification evidence;
7. update PRJ-0003 ledgers, handoff, and gate status only through accepted typed mutations after verification.

Missing source bytes remain an explicit recovery blocker. The system must not create placeholder artifacts to satisfy reported counts.

## Security and failure handling

- The public manifest never exposes a general `skipGuard` or arbitrary final provider path.
- Staging ownership is bound to the request ID and exact immutable provider evidence.
- A source mutation between submission and execution is rejected.
- Source deletion is post-commit cleanup, never part of the publication proof.
- Provider timeouts and retryable failures use existing bounded resilience; semantic mismatches and destination conflicts are terminal.
- Unknown objects written directly into strict business zones remain MutationGate candidates.
- Logs must not contain artifact contents, credentials, or signed download links.

## Testing strategy

### Contract tests

- existing inline text request compatibility;
- staged manifest schema acceptance and mixed-form rejection;
- safe staging path and request-ID ownership validation;
- explicit persisted-schema compatibility gate.

### ProjectGuard tests

- successful staged binary publication with committed receipt and matching final metadata;
- source metadata mismatch for object ID, revision, size, algorithm, and integrity value;
- destination conflict;
- crash after intent, after copy, after receipt, and before source cleanup;
- exact replay and request-ID reuse with different source evidence;
- no staging deletion before canonical verification.

### Provider tests

- Dropbox stable-ID/revision/integrity mapping;
- server-side copy of opaque bytes without text decoding;
- retry classification without content logging.

### Operating-contract tests

- `OPERATING.md` contains the current-chat preflight gate;
- a failed canary forbids bulk start;
- a text canary cannot authorize binary production;
- activation vocabulary remains `IMPLEMENTED`, `PRODUCTION DEPLOYED`, `RUNTIME ACTIVE`, `PROJECT ACTIVATED`, `CHAT CONTRACT ACTIVE`, and `E2E VERIFIED`.

### Production proof

After separately authorized deployment, use one harmless small binary canary through the complete staged path. Confirm the committed receipt, canonical verification, final readback, and safe staging cleanup before authorizing any PRJ-0003 recovery.

## Rollout and rollback

1. Implement schema and ProjectGuard support behind a default-off binary-ingress mode.
2. Deploy only after normal CI, persistence high-risk tests, and independent review.
3. Exercise a default-off health check with no provider mutation.
4. Enable binary ingress for a single controlled canary.
5. Verify the full activation chain and keep the preflight contract active.
6. Authorize PRJ-0003 recovery separately.

Rollback disables new binary submissions while retaining all intents, receipts, and staging evidence. Existing inline text ingress remains available. Rollback never deletes unresolved staging objects or rewrites terminal evidence.

## Acceptance criteria

- A chat cannot legitimately start a qualifying bulk run without current-session canary evidence.
- Binary artifacts can traverse a governed staging path without text conversion or direct final-zone writes.
- Every published binary object has immutable source evidence, a committed receipt, and verified final provider evidence.
- Interrupted and replayed publication cannot overwrite different destination content or delete an unverified source.
- Existing inline text artifact requests remain compatible.
- PRJ-0003 recovery remains blocked until the new path is production-active and end-to-end verified.

