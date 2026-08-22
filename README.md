# Project OS

Deterministic project-state guard for a ChatGPT → Dropbox → Obsidian workflow.

## Purpose

Project OS lets one ChatGPT Project work across many independent real projects without treating conversation history as canonical state. ChatGPT expresses durable changes as typed transactions; a deterministic Cloudflare guard validates, serializes, versions and persists them before Obsidian sees the resulting Markdown.

## Architecture

```text
ChatGPT Project
      |
      | typed transaction JSON / artifact write request
      v
Dropbox incoming queue or ProjectGuard endpoint
      |
      v
Cloudflare Worker
      |
      +--> RegistryGuard (global project allocation / index)
      |
      +--> ProjectGuard (one Durable Object per PRJ-xxxx)
                   |
                   | serialized canonical + artifact writes
                   | immutable event + materialized views + receipt
                   v
                Dropbox
                   |
                   v
                Obsidian
```

## Safety invariants

- ChatGPT never submits arbitrary canonical file paths or file patches.
- Only operations in the closed transaction schema are accepted for canonical state changes.
- Business artifacts under a project workspace are published through ProjectGuard `/artifact`, never by direct competing Dropbox mutation.
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
- Receipts are written last and are the only proof of canonical transaction persistence.
- Generated Markdown is rebuildable from structured state.
- Project deletion is intentionally absent from V1; archive is terminal.

## Artifact publication contract

`POST /artifact` on the project Durable Object accepts:

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

The server recomputes the SHA-256 hash, serializes the write with transactions for the same project, persists an idempotent artifact receipt, and writes only inside the project's `ARTIFACTS/` subtree. Direct Dropbox reads remain allowed; direct business-artifact writes into that subtree are not part of the supported operating contract.

## Repository status

Implementation is developed on `feat/project-os-v1` and reviewed through draft PR #1 before promotion to `main`.

- Design: `docs/superpowers/specs/2026-08-20-project-os-v1-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-20-project-os-v1-implementation.md`
- Deployment: `docs/deployment.md`

## Commands

```bash
npm install
npm run check
npm run deploy
```

Production secrets are never committed to GitHub. See `docs/deployment.md`.
