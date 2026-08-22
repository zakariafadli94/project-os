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

### 3. Dropbox client absorbs transient infrastructure failures

Add a reusable retry policy around write operations (`upload`, `move`, and folder creation where appropriate).

Retry only when evidence marks the failure transient:
- HTTP 429;
- HTTP 500, 502, 503, 504;
- Dropbox response containing `too_many_write_operations`;
- Dropbox response containing `internal_error`.

Do not retry semantic conflicts such as path already exists with different content, malformed paths, permission failures, or immutable-path conflicts.

Backoff policy: bounded exponential backoff with jitter, maximum five attempts. Tests use an injectable sleeper/random source so the suite remains deterministic.

### 4. Receipt gate remains the business barrier

Canonical transactions remain receipt-gated. Dependent business actions use the committed receipt and refreshed state before constructing a new transaction. This design does not add arbitrary settling sleeps after receipts: correctness comes from serialized mutation plus idempotent retry, not timing guesses.

### 5. Observability

For each internal Dropbox write attempt, emit structured logs containing:
- `project_id` when available;
- `request_id` or `transaction_id` when available;
- operation type;
- path;
- attempt number;
- duration;
- Dropbox request id/error classification;
- retry delay when a retry occurs.

No secret values or artifact contents are logged.

## Agent operating rule

Once `/artifact` is available, ChatGPT must not directly mutate files inside `WORKSPACE/PROJECTS/<project>/ARTIFACTS`. It submits artifact writes through ProjectGuard. Direct Dropbox reads remain allowed. Canonical writes continue to use typed Project OS transactions.

## Failure semantics

- Transient infrastructure error exhausted after five attempts: return terminal infrastructure failure to the caller; do not create another business transaction automatically.
- Same artifact request replay: idempotent success.
- Same request id, different request: rejected.
- `create` to existing different content: explicit conflict.
- Canonical `base_revision` conflict: unchanged and still visible.

## Acceptance tests

1. Transient Dropbox write failure retries and succeeds without duplicate file.
2. A semantic path/content conflict is not retried into an overwrite.
3. Two concurrent artifact writes for the same project execute serially.
4. Artifact requests for two different project Durable Objects are not globally serialized.
5. Exact artifact replay returns one committed receipt and one file.
6. Same request id with different hash/path is rejected.
7. A canonical transaction followed immediately by artifact publication for the same project completes without write overlap inside ProjectGuard.
8. Fifty sequential mixed transaction/artifact mutations complete without manual intervention in the deterministic stress harness.
9. Existing transaction/reducer tests remain green.
10. `npm run check` and `npx wrangler deploy --dry-run` pass.
