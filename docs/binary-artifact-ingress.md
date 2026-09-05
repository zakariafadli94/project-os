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
