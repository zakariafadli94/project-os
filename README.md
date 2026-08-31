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

Managed source changes use a separate trigger-first path:

```text
Dropbox file change
      |
      v
Dropbox webhook
      |
      | signature verified
      | durable notification handoff
      v
DropboxChangeGuard
      |
      v
Dropbox change feed
      |
      | durable per-change jobs
      v
ProjectGuard
      |
      +--> INPUTS intake state machine
      +--> managed-document reconciliation
```

The webhook is a trigger, not the changed-file payload. Exact paths come from the provider change feed. The cursor may advance after the page's relevant changes are durably journaled; individual jobs can safely finish afterward or retry from durable state.

## Safety invariants

- ChatGPT never submits arbitrary canonical file paths or file patches.
- Only operations in the closed transaction schema are accepted for canonical state changes.
- Business artifacts under a project workspace are published by ProjectGuard, never by a competing direct write to their final path.
- Artifact requests use safe logical relative paths. Their physical workspace root is resolved from canonical project `artifact_routes` when a governed route matches; otherwise the compatibility default remains `ARTIFACTS/`.
- A governed artifact route must reference accepted canonical decisions. If a governing decision is later superseded, publication through that route is blocked until governance is updated.
- Exclusive routes reject physical-path bypasses that would create a second active tree.
- Changing an existing route root requires a newly accepted governing decision; a platform convention cannot silently move a business tree.
- A configured `archive_prefix` keeps replaced content outside the active tree before overwrite.
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
- A visible file in a project's `INPUTS/` means its technical source ingestion has not reached a verified terminal state.
- INPUT source bytes are durably preserved and governed as references before the active inbox copy is removed.
- Source/referral ingestion never implies business acceptance and does not create a canonical project revision by itself.
- Managed provider changes are trigger-first; scheduled maintenance is not a hidden periodic `INPUTS/` scanner.
- Dropbox empty `INPUTS/` directories may remain because recursive folder deletion is not a race-safe empty-directory cleanup primitive.

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
  "relative_path": "REVENUE-OS/04-playbooks-sectoriels/example.md",
  "content": "# Example",
  "content_sha256": "<64 lowercase hex chars>",
  "mode": "create"
}
```

`relative_path` is a **logical artifact path**, not an instruction to write under a physical `ARTIFACTS/` folder. ProjectGuard resolves it against canonical project routing before publication.

For example, a project may canonically configure:

```text
REVENUE-OS
  → DELIVERABLES/REVENUE-OS
  archive → ARCHIVES/REVENUE-OS
  exclusive = true
```

The route is configured through the typed `artifact.route.configure` transaction and must reference one or more accepted decision IDs. A project with no matching route keeps the generic compatibility destination `ARTIFACTS/<relative_path>`.

The Worker processes canonical transactions first, then artifact requests, and routes the artifact request to the matching ProjectGuard. ProjectGuard recomputes the SHA-256 hash, resolves the governed destination, serializes the final write with canonical writes for the same project, writes the artifact receipt, and only then acknowledges the request as durable.

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

Authenticated clients may instead call `POST /v1/artifacts`; it routes into the same ProjectGuard path. Direct Dropbox reads remain allowed. Direct final writes into governed business trees are not part of the supported operating contract.

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

## Managed INPUTS lifecycle

`INPUTS/` is an active source inbox, not an archive. Ordinary files converge through:

```text
DETECTED
  -> SNAPSHOTTED
  -> REFERENCE_COMMITTED
  -> SOURCE_REMOVED
  -> COMPLETE
```

Terminal alternatives are `DUPLICATE_CLEANED`, `WITHDRAWN`, and `CONFLICT`.

Normal sources route to `REFERENCES/UNCLASSIFIED/`. Machine-verifiable governed cross-project referrals may route structurally to `REFERENCES/REFERRALS/<source_project_id>/`; a referral-looking file without trusted delivery provenance remains ordinary unclassified evidence.

Replay verifies the complete intended postcondition rather than treating an intermediate ledger record as success. If a governed reference already exists but the stale INPUT source remains, replay safely finishes source cleanup. If destination/source evidence diverges, Project OS preserves the source and fails closed as a conflict.

Historical stale inputs are repaired only through the authenticated, explicitly project-scoped route:

```text
POST /v1/admin/recover-inputs
Authorization: Bearer <INGRESS_TOKEN>

{"project_ids":["PRJ-0002","PRJ-0003"]}
```

The route validates the whole project list before dispatch, recovers only the selected projects through the same intake engine, and is never invoked by scheduled maintenance.

## Current write-coordination design

- Design: `docs/superpowers/specs/2026-08-23-dropbox-write-coordination-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-23-dropbox-write-coordination.md`
- Trigger-first INPUTS design: `docs/superpowers/specs/2026-08-31-input-lifecycle-triggered-ingestion-design.md`
- Trigger-first INPUTS implementation plan: `docs/superpowers/plans/2026-08-31-input-lifecycle-triggered-ingestion.md`
- Deployment: `docs/deployment.md`

## Persistence provider boundary

Project OS Core depends on a provider-neutral persistence runtime rather than Dropbox transport classes. The runtime exposes base object operations plus explicit conditional-write, server-side-copy, incremental-change-feed, stable-object-ID, revision-token, and integrity-hash capabilities. Provider errors and retry policy are neutral at the Core boundary; Dropbox status/error parsing stays inside the Dropbox adapter.

Production remains intentionally **Dropbox-only**. `createProductionPersistence` constructs the Dropbox adapter directly, there is no `PROJECT_OS_PROVIDER` selector, and the existing Dropbox secret names remain the production configuration contract. The Dropbox webhook is provider-specific by design.

Persisted records remain schema `1.0`. Historical fields such as `provider_file_id`, `provider_rev`, and `provider_content_hash` keep their exact Dropbox V1 meaning through an explicit compatibility seam. IMP-PERSIST001 is runtime-neutral, not persisted-format-neutral: adding a durable provider kind, generalized revision/hash tokens, migration/upcasting, or another provider is owned by IMP-SCHEMA001 rather than this boundary.

Operational modes remain unchanged: continuity is `stable` and MutationGate production mode remains `observe`.

## Commands

```bash
npm install
npm run check
npm run deploy
```

Production secrets are never committed to GitHub. See `docs/deployment.md`.
