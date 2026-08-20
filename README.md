# Project OS

Deterministic project-state guard for a ChatGPT → Dropbox → Obsidian workflow.

## Purpose

Project OS lets one ChatGPT Project work across many independent real projects without treating conversation history as canonical state. ChatGPT expresses durable changes as typed transactions; a deterministic Cloudflare guard validates, serializes, versions and persists them before Obsidian sees the resulting Markdown.

## Architecture

```text
ChatGPT Project
      |
      | typed transaction JSON
      v
Dropbox /PROJECT_OS/TRANSACTIONS/incoming
      |
      | verified webhook
      v
Cloudflare Worker
      |
      +--> RegistryGuard (global project allocation / index)
      |
      +--> ProjectGuard (one Durable Object per PRJ-xxxx)
                   |
                   | immutable event + materialized views + receipt
                   v
                Dropbox
                   |
                   v
                Obsidian
```

## Safety invariants

- ChatGPT never submits arbitrary file paths or file patches.
- Only operations in the closed transaction schema are accepted.
- `project.create` uses `PRJ-AUTO`; the global RegistryGuard allocates the canonical project ID.
- Each project has one Durable Object serialization boundary.
- Every committed mutation increments the revision by exactly one.
- Every committed mutation creates an immutable event.
- Transaction IDs are idempotency keys.
- Stale direction-changing operations conflict instead of being semantically merged.
- Receipts are written last and are the only proof of persistence.
- Generated Markdown is rebuildable from structured state.
- Project deletion is intentionally absent from V1; archive is terminal.

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
