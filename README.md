# Project OS

Deterministic project-state guard for a ChatGPT → Dropbox → Obsidian workflow.

## Purpose

Project OS lets one ChatGPT Project work across many independent real projects without treating conversation history as canonical state. ChatGPT expresses durable changes as typed transactions or artifact publication requests; a deterministic Cloudflare guard validates, serializes and persists them before Obsidian sees the resulting workspace.

## Architecture

```text
ChatGPT Project
      |
      | typed transaction JSON
      | artifact request JSON
      v
Dropbox incoming queues
      |
      v
Cloudflare Worker
      |
      +--> RegistryGuard (global project allocation / index)
      |
      +--> ProjectGuard (one Durable Object per PRJ-xxxx)
                   |
                   | one serialized mutation queue per project
                   | canonical writes + final business artifact writes
                   v
                Dropbox
                   |
                   v
                Obsidian
```

## Safety invariants

- ChatGPT never submits arbitrary canonical file paths or file patches.
- Only operations in the closed transaction schema are accepted for canonical state changes.
- Business artifacts under a project workspace are published by ProjectGuard, never by a competing direct write to their final path.
- Artifact paths are restricted to `WORKSPACE/PROJECTS/<project>/ARTIFACTS/` and validated as safe relative paths.
- Artifact request IDs are idempotency keys; exact replay is safe, while request-ID reuse with different content is rejected.
- Artifact `create` never overwrites different existing content; a real content conflict remains visible.
- Transient Dropbox infrastructure failures are retried with bounded exponential backoff and jitter; semantic conflicts are not retried into overwrites.
- `project.create` uses `PRJ-AUTO`; the global RegistryGuard allocates the canonical project ID.
- Each project has one Durable Object serialization boundary.
- Different project Durable Objects remain independent and can progress in parallel.
- Every committed canonical mutation increments the revision by exactly one.
- Every committed canonical mutation creates an immutable event.
- Transaction IDs are idempotency keys.
- Stale direction-changing operations conflict instead of being semantically merged.
- Canonical transaction receipts and artifact receipts are persistence gates.
- A dependent Dropbox inbox mutation is physically settled only after the prior receipt is committed **and** the prior source message has drained from its `incoming` queue.
- Connector-level `WRITE_CONFLICT` is treated as transient infrastructure only after target-state verification: retry the exact same path, ID and content when absent; accept an identical existing target idempotently; surface different content as a real conflict.
- Generated Markdown is rebuildable from structured state.
- Project deletion is intentionally absent from V1; archive is terminal.

## Artifact publication contract

For normal Dropbox-backed ChatGPT operation, write an immutable request message to:

```text
/PROJECT_OS/.project-os/artifacts/incoming/<request_id>.json
```

Example request:

```json
{
  "request_id": "ART-GROWTH-000001",
  "project_id": "PRJ-0003",
  "relative_path": "playbooks/06-acquisition-multicanale.md",
  "content": "# Acquisition",
  "content_sha256": "<64 lowercase hex chars>",
  "mode": "create"
}
```

The Worker processes canonical transactions first, then artifact requests, and routes the artifact request to the matching ProjectGuard. ProjectGuard recomputes the SHA-256 hash, serializes the final artifact write with canonical writes for the same project, writes the artifact receipt, and only then acknowledges the request as durable.

Receipt path:

```text
/PROJECT_OS/.project-os/artifacts/receipts/<request_id>.json
```

The source request is then moved to one of:

```text
/PROJECT_OS/.project-os/artifacts/committed/<request_id>.json
/PROJECT_OS/.project-os/artifacts/rejected/<request_id>.json
/PROJECT_OS/.project-os/artifacts/conflicts/<request_id>.json
```

Authenticated clients may instead call `POST /v1/artifacts`; it routes into the same ProjectGuard path. Direct Dropbox reads remain allowed. Direct final writes under a project's `ARTIFACTS/` subtree are not part of the supported operating contract.

## Dropbox-backed mutation barrier

For a sequence of dependent mutations submitted through Dropbox, use this order:

```text
write immutable incoming message
        ↓
receipt status = committed
        ↓
confirm that exact source message is no longer in incoming
        ↓
start the next dependent Dropbox mutation
```

A committed receipt is the business-persistence proof. Source drain is the additional physical Dropbox settlement barrier that prevents the next connector write from racing the scanner's terminal archival.

If the connector reports `WRITE_CONFLICT` while creating an incoming message:

1. Check whether the exact target path already exists.
2. If it exists with the exact intended content, treat the write as idempotently present and continue with the same ID.
3. If it does not exist, retry the exact same path, ID and content after the transient contention clears.
4. If it exists with different content, stop and surface a real conflict.
5. Never generate a replacement transaction/request ID merely because the first write was slow or conflicted at the infrastructure layer.

The Worker-side inbox scanner follows the same principle for terminal archival: exact terminal replays clean the duplicate source, and a file move conflict with an absent destination falls back to idempotent publish plus retryable source deletion. Different terminal content remains a semantic conflict.

## Current write-coordination design

- Design: `docs/superpowers/specs/2026-08-23-dropbox-write-coordination-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-23-dropbox-write-coordination.md`
- Deployment: `docs/deployment.md`

## Commands

```bash
npm install
npm run check
npm run deploy
```

Production secrets are never committed to GitHub. See `docs/deployment.md`.
