# Dropbox Write Coordination Design

## Problem

Real Project OS usage on PRJ-0003 produced recurrent Dropbox `WRITE_CONFLICT`-class failures when ProjectGuard canonical regeneration and direct agent business-file writes occurred close together. ProjectGuard already serializes requests inside one project Durable Object, but direct connector writes bypass that queue. The internal Dropbox client also treats most write conflicts as terminal and has no generic retry/backoff for transient Dropbox contention.

## Goals

- Keep transient Dropbox contention invisible to the normal user workflow.
- Preserve real business conflicts as explicit failures.
- Guarantee idempotent artifact publication without duplicate files or duplicate business mutations.
- Serialize canonical writes and Project OS business-artifact writes per `project_id` through the same ProjectGuard queue.
- Preserve parallelism between different projects.
- Add enough observability to identify retry attempts and failures without exposing infrastructure noise in normal UX.

## Non-goals

- Do not change canonical transaction semantics or `base_revision` conflict rules.
- Do not auto-merge business-direction conflicts.
- Do not route arbitrary external Dropbox content through ProjectGuard.
- Do not make Dropbox the business-artifact source of truth outside Project OS project workspaces.

## Architecture

### 1. ProjectGuard becomes the mutation gateway for Project OS business artifacts

Add `POST /artifact` to the per-project ProjectGuard Durable Object. Requests are serialized by the same existing `serialize()` queue used by `/transaction` and `/materialize`.

Request shape:

```ts
interface ArtifactWriteRequest {
  request_id: string;
  project_id: string;
  relative_path: string;
  content: string;
  content_sha256: string;
  mode: "create" | "replace";
}
```

Artifact paths are restricted to `ARTIFACTS/` beneath the human project workspace. The API rejects traversal, absolute paths, generated canonical filenames, and any path outside that subtree.

Response shape:

```ts
interface ArtifactWriteReceipt {
  request_id: string;
  project_id: string;
  relative_path: string;
  content_sha256: string;
  status: "committed" | "conflict" | "rejected";
  code?: string;
  message?: string;
}
```

ProjectGuard stores artifact receipts in Durable Object SQL keyed by `request_id`. Replaying the same request id with the same project/path/hash returns the existing committed receipt. Reusing the same request id for different content/path is rejected.

### 2. Artifact writes are content-idempotent

`create` behavior:
- If target does not exist: create it.
- If target exists with exactly the same content: return committed idempotently.
- If target exists with different content: return a real conflict; never overwrite.

`replace` behavior:
- If target already equals requested content: return committed idempotently.
- Otherwise overwrite through the serialized ProjectGuard writer.

The agent must not create a second request id merely because a first attempt is slow. It replays the exact same request when transport delivery is uncertain.

### 3. Dropbox transport absorbs transient infrastructure failures

A reusable resilient transport wraps internal Dropbox writes used by ProjectGuard, RegistryGuard and inbox archival operations.

Retry only when evidence marks the failure transient:
- HTTP 429;
- HTTP 500, 502, 503, 504;
- Dropbox response containing `too_many_write_operations`;
- Dropbox response containing `internal_error`.

Do not retry semantic conflicts such as path already exists with different content, malformed paths, permission failures, or immutable-path conflicts.

Backoff policy: bounded exponential backoff with jitter, maximum five attempts. Tests use an injectable sleeper/random source so the suite remains deterministic.

### 4. Artifact inbox bridges the actual ChatGPT workflow to ProjectGuard

The normal Project OS workflow cannot assume ChatGPT can call an internal Durable Object endpoint directly. Therefore the supported ChatGPT mutation path is an immutable artifact request message in Dropbox:

```text
/PROJECT_OS/.project-os/artifacts/incoming/<request_id>.json
```

The webhook or scheduled inbox scanner processes canonical transaction messages first, then artifact request messages. Each artifact request is parsed and validated, then routed to the matching ProjectGuard `/artifact` endpoint. ProjectGuard remains the only writer of the final business artifact.

Terminal request-message locations are:

```text
/PROJECT_OS/.project-os/artifacts/committed/<request_id>.json
/PROJECT_OS/.project-os/artifacts/rejected/<request_id>.json
/PROJECT_OS/.project-os/artifacts/conflicts/<request_id>.json
```

The ProjectGuard publication receipt is written at:

```text
/PROJECT_OS/.project-os/artifacts/receipts/<request_id>.json
```

An authenticated `POST /v1/artifacts` route is also available for clients that can call the Worker directly. Both ingress methods route into the same per-project ProjectGuard serialization boundary.

### 5. Receipt gate remains the business barrier

Canonical transactions remain receipt-gated. Artifact publication is also receipt-gated: ProjectGuard writes the artifact receipt before durably acknowledging the request id. If the final artifact file was written but receipt publication failed, replaying the exact request is content-idempotent and retries receipt publication without creating a duplicate file.

Dependent business actions use the committed receipt and refreshed state before constructing a new canonical transaction. This design does not add arbitrary settling sleeps after receipts: correctness comes from serialized mutation plus idempotent retry, not timing guesses.

### 6. Observability

For each internal Dropbox retry, emit structured logs containing:
- `project_id` when derivable;
- operation type;
- path;
- attempt number;
- duration;
- Dropbox request id/error classification;
- retry delay when a retry occurs.

Inbox processing logs failed request ids and preserves failed messages for later retry. No secret values or artifact contents are logged.

## Agent operating rule

Once this baseline is deployed, ChatGPT must not directly mutate final business files inside `WORKSPACE/PROJECTS/<project>/ARTIFACTS`. In normal Dropbox-backed operation it writes an artifact request message to `.project-os/artifacts/incoming/` and waits for the corresponding artifact receipt. Direct Dropbox reads remain allowed. Canonical writes continue to use typed Project OS transactions.

## Failure semantics

- Transient infrastructure error exhausted after five attempts: leave the ingress message recoverable and do not create another business request automatically.
- Same artifact request replay: idempotent success.
- Same request id, different request: rejected.
- `create` to existing different content: explicit conflict.
- Canonical `base_revision` conflict: unchanged and still visible.
- A real content or business conflict is never converted into an infrastructure retry success.

## Acceptance tests

1. Transient Dropbox write failure retries and succeeds without duplicate file.
2. A semantic path/content conflict is not retried into an overwrite.
3. Two concurrent artifact writes for the same project execute serially.
4. Artifact requests for two different project Durable Objects are not globally serialized.
5. Exact artifact replay returns one committed receipt and one file.
6. Same request id with different hash/path is rejected.
7. A canonical transaction followed immediately by artifact publication for the same project completes without write overlap inside ProjectGuard.
8. Fifty sequential mixed transaction/artifact mutations complete without manual intervention in the deterministic stress harness.
9. Artifact inbox processing routes a Dropbox request message to ProjectGuard, writes the final artifact and receipt, and archives the source request.
10. Direct artifact ingress requires authentication and uses the same ProjectGuard path.
11. Existing transaction/reducer tests remain green.
12. `npm run check` and `npx wrangler deploy --dry-run` pass.
