# Binary Artifact Ingress

## Purpose

Binary artifact ingress publishes opaque files through the same ProjectGuard and MutationGate boundary as text artifacts. It exists for chats or operators that can upload a file to Dropbox staging but must not write directly into a governed final zone.

Staging is temporary transport. It is not publication, canonical verification, acceptance, or proof that the user can retrieve the result.

## Preconditions

Before a qualifying generation job, the current chat must prove a representative canary through the same payload class and governed destination. A successful text write does not prove binary persistence.

Qualifying work includes binary output, more than 10 files, more than 15 minutes before the first durable output, or any package whose delivery depends on a governed gate. If the canary cannot reach `CANONICAL_VERIFIED`, do not begin bulk generation.

## Staging and request

Upload exactly one opaque object under:

```text
/PROJECT_OS/.project-os/artifacts/staging/<request_id>/<safe-file-name>
```

Capture the provider observation returned by that upload: exact path, stable object ID, revision token, byte size, integrity algorithm, and integrity value. Then submit a staged artifact request:

```json
{
  "request_id": "ART-BINARY-000001",
  "project_id": "PRJ-0003",
  "relative_path": "package/example.pdf",
  "content_sha256": "<64 lowercase hex characters>",
  "source": {
    "kind": "staged_provider_object",
    "path": "/PROJECT_OS/.project-os/artifacts/staging/ART-BINARY-000001/example.pdf",
    "object_id": "<provider object ID>",
    "revision_token": "<provider revision>",
    "size": 123,
    "integrity": {
      "algorithm": "dropbox-content-hash",
      "value": "<provider integrity value>"
    }
  },
  "mode": "create"
}
```

ProjectGuard freezes the request in a durable intent before any final provider effect. It checks the current staged object against every captured observation, performs an opaque server-side copy, rechecks the source after that path-based copy, verifies final size and integrity, writes the terminal receipt, and only then removes the exact staged source using its stable object ID plus a revision-conditioned delete. Exact replay is idempotent. Reusing a request ID with changed evidence conflicts.

## States and evidence

Use the states precisely:

```text
LOCAL_GENERATED → STAGED → SUBMITTED → COMMITTED → CANONICAL_VERIFIED → ACCEPTED
```

- `STAGED` proves only that temporary provider bytes exist.
- `COMMITTED` proves the governed artifact receipt is terminal.
- `CANONICAL_VERIFIED` additionally proves the final provider object matches the frozen source evidence.
- `ACCEPTED` is a separate business or user decision; publication does not infer it.

## Safety and recovery

- The runtime mode defaults to `off`; a disabled request is rejected before Durable Object routing.
- The default maximum staged size is 10 MiB.
- Never decode or rewrite the binary as text.
- Never use a direct final-zone upload as a fallback.
- A source mismatch is rejected before copy and the staging object is preserved.
- A different existing destination conflicts in `create` mode.
- `replace` copies the observed destination into the frozen archive or rollback path, verifies it, and removes the original only through an identity-and-revision-conditioned delete before copying the new object. A failed publication persists request-specific rollback evidence before restoring the old bytes; MutationGate accepts that state only while the request has no terminal receipt and the exact governed backup still exists.
- If cleanup fails after a committed receipt, exact replay retries cleanup without duplicating the final object.
- Cleanup fails closed and preserves the object when either its stable identity or revision changed.
- Rollback is configuration-only: return the mode to `off`; retain receipts, intents, and provider evidence.

## Activation gate

Merging or deploying this code does not activate binary ingress. Enablement is a separate, explicitly authorized production action after CI, dry-run, health, controlled canary, replay, size-limit, mismatch, and cleanup evidence are accepted. PRJ-0003 recovery is a separate operation and is never implied by activation.

## Proposed REVIEW_CANDIDATE contract

This branch adds a separate, disabled-by-default capability for immutable review attachments. It does not activate production, publish files, accept business facts, or mutate a managed document head.

`operation: REVIEW_CANDIDATE` requires `mode: create`, current `base_revision`, a safe basename in `relative_path`, `media_type`, `content_sha256`, and the normal staged source with an additional `provider_id`. The exact source path must be `/PROJECT_OS/.project-os/artifacts/staging/<request_id>/<relative_path>`. Changing a rejected request ID requires restaging under the new matching directory and capturing fresh provider evidence.

The governed destination is `REVIEW/CANDIDATES/<request_id>/<relative_path>`. This reserved namespace holds independent immutable submissions, not sequential versions of an existing work product. It creates no working/review/published head. Managed operations cannot claim `CANDIDATES` as a logical root; ordinary artifact routes still cannot target REVIEW. A candidate never replaces or supersedes another. Promotion into a managed work product or DELIVERABLES requires a separately governed operation; this ingress does not provide promotion.

### Exact temporary authorization

`PROJECT_OS_REVIEW_CANDIDATE_INGRESS_MODE` stays `off` in repository configuration. `scoped` requires `PROJECT_OS_REVIEW_CANDIDATE_CAPABILITY` containing a strict JSON object:

```json
{
  "issued_at": "2026-09-07T12:00:00.000Z",
  "expires_at": "2026-09-07T12:30:00.000Z",
  "requests": [
    {
      "request_id": "ART-REVIEW-EXAMPLE-0001",
      "project_id": "PRJ-0002",
      "operation": "REVIEW_CANDIDATE",
      "base_revision": 149,
      "relative_path": "example.pdf",
      "media_type": "application/pdf",
      "content_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "mode": "create",
      "source": {
        "kind": "staged_provider_object",
        "provider_id": "dropbox",
        "path": "/PROJECT_OS/.project-os/artifacts/staging/ART-REVIEW-EXAMPLE-0001/example.pdf",
        "object_id": "id:example",
        "revision_token": "example-revision",
        "size": 123,
        "integrity": {
          "algorithm": "dropbox-content-hash",
          "value": "0000000000000000000000000000000000000000000000000000000000000000"
        }
      }
    }
  ]
}
```

The example uses expired dates and illustrative provider observations/hashes. Replace these with the freshly verified complete request and a separately authorized validity window; a request ID or content hash alone is insufficient. Maximum: ten requests, 64 KiB configuration, one-hour validity, 10 MiB per file. Unknown keys, wildcards, missing fields, future issuance and expiry fail closed. No capability is installed by this branch.

The public endpoint remains authenticated. REVIEW requests reach ProjectGuard so terminal replay can be recovered before checking authorization for new work. ProjectGuard requires V2 layout and enforced MutationGate, checks the exact capability, and rechecks expiration after reading bytes and immediately before copy. Global binary `on` cannot authorize REVIEW. Setting the dedicated mode back to `off`, removing the capability, or letting it expire prevents new copies while preserving exact terminal replay. Previously terminally rejected IDs remain rejected: create a new request/staging directory after correcting the cause.

### Explicit promotion into managed deliverables

`REVIEW_CANDIDATE` is a durable review submission, not a published document. A separately authenticated `review_candidate.promote` request is required to make an explicit acceptance decision and create a managed work-product version:

```json
{
  "operation": "review_candidate.promote",
  "request_id": "DOCREQ-REVIEW-PROMOTE-0001",
  "project_id": "PRJ-0002",
  "candidate_request_id": "ART-REVIEW-EXAMPLE-0001",
  "logical_path": "dg-v2.0/example.pdf",
  "expected_project_revision": 150,
  "accepted": true,
  "created_at": "2026-09-07T12:45:00.000Z"
}
```

The promotion gate requires the candidate's immutable terminal receipt to be `committed`, revalidates its provider ID, path, object ID, revision, size and integrity, verifies the supported binary signature, and checks the project revision immediately before the provider effects. The destination is exactly `DELIVERABLES/<logical_path>`. Promotion is create-only: an existing managed head or a different object at that destination is a conflict. The candidate remains in `REVIEW/CANDIDATES/` for audit and replay.

The promotion receipt carries `accepted: true`, `published: true` and `candidate_request_id`. It is backed by an immutable version, an immutable provider payload snapshot and an immutable promotion record under `.project-os/projects/<PRJ>/documents/promotions/`. Exact request replay repairs a missing head or receipt after a partial provider success, but never overwrites a different visible object or rebinds a request ID to new content. No automatic promotion or bulk PRJ-0007 publication is performed by this flow.

### Verification and receipts

Supported declared formats are PDF (`.pdf`), PNG (`.png`), JPEG (`.jpg`/`.jpeg`) and ZIP (`.zip`). The runtime verifies the byte signature and matching extension, not a complete semantic document parse or malware scan. DOCX/XLSX/PPTX are not validated as Office documents; package them inside a ZIP candidate if needed. Do not merely rename an Office document and claim Office validation.

The provider must implement bounded binary reads. The reader cancels an oversized stream without trusting Content-Length. Source bytes are checked against raw SHA-256 and the provider's identified integrity algorithm, then source identity/revision is rechecked before and after copy. Transient provider failures remain retryable. The final verified copy observation is frozen under `.project-os/artifacts/review-observations/`; a subsequent identity/revision change cannot be silently adopted into the receipt.

Receipts explicitly carry `operation: REVIEW_CANDIDATE`, `accepted: false`, `published: false`, and, on commit, the exact final provider observation. An immutable full-request terminal record under `.project-os/artifacts/review-terminals/` precedes the ordinary receipt and SQLite record, so a crash between writes can recover the same outcome. The status endpoint reports `canonical_verified` only while the visible identity, revision, size and integrity still match the frozen receipt. Unknown/altered candidate files remain external mutations under MutationGate. They are never bootstrapped as managed document heads.

### Bounded batch execution

Each invocation processes transactions first, then at most four artifact work items from a scan of at most sixteen entries. Malformed requests consume work budget. Retry backoff and the eight-attempt ceiling remain in force. A durable scan cursor advances past exhausted prefixes across invocations; a failure does not force every later invocation to start with the same first entries. The legacy neutral entrypoint uses the same bounds. Writes remain sequential through per-project ProjectGuard.

### Review gate

Before any separately authorized live activation, prove the exact file class/destination with a representative canary and verify committed receipt, final observation, replay, expiry, mismatches and rollback. Production deployment, activation, canonical SOP acceptance and any PRJ-0007 file submission are outside this branch's mandate.
