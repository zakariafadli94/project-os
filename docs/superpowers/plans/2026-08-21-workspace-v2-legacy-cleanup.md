# Workspace V2 Legacy Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all remaining legacy audit history into Workspace V2, preserve Obsidian configuration, and safely remove obsolete root-level legacy folders after verified parity.

**Architecture:** Extend the existing restartable immutable migration helper rather than inventing a second migration mechanism. Add one authenticated admin route for ledger migration, then perform operational parity checks and cleanup in Dropbox only after production deployment is verified.

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest, Dropbox API, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-21-workspace-v2-legacy-cleanup-design.md`

## Global Constraints

- `PROJECT_OS_LAYOUT_MODE` remains `v2`.
- Durable Object bindings and `exports` configuration remain unchanged.
- Migration must not change any business revision.
- Existing identical immutable files are accepted; differing content is a hard conflict.
- Legacy folders are not deleted until exact ledger parity is verified.
- `WORKSPACE` is the only Obsidian Vault root; `.project-os` remains outside it.

---

### Task 1: Specify ledger migration behavior

**Files:**
- Modify: `test/workspace-migration.spec.ts`

**Interfaces:**
- Consumes: existing `mirrorImmutableFile` behavior.
- Produces: tests for `mirrorLegacyLedger(transport)` returning `{ transactions: number; receipts: number }`.

- [ ] **Step 1: Write failing tests** for idempotent legacy committed transaction + receipt mirroring, interrupted migration recovery, and immutable-content conflict.
- [ ] **Step 2: Run `npm test -- test/workspace-migration.spec.ts`** and confirm the new tests fail because `mirrorLegacyLedger` does not exist.
- [ ] **Step 3: Commit the failing tests** with message `test: specify workspace v2 ledger migration`.

### Task 2: Implement immutable ledger migration

**Files:**
- Modify: `src/migration/workspace-v2.ts`
- Test: `test/workspace-migration.spec.ts`

**Interfaces:**
- Produces: `mirrorLegacyLedger(transport: MigrationTransport): Promise<{ transactions: number; receipts: number }>`.
- Uses legacy roots `/PROJECT_OS/TRANSACTIONS/{committed,rejected,conflicts}` and `/PROJECT_OS/RECEIPTS`.
- Writes via `machineTransactionPath()` and `machineReceiptPath()`.

- [ ] **Step 1: Implement `mirrorLegacyLedger`** by listing each legacy terminal transaction folder, sorting JSON files, and mirroring through `mirrorImmutableFile`; then list legacy receipts and mirror each JSON receipt.
- [ ] **Step 2: Run `npm test -- test/workspace-migration.spec.ts`** and confirm all migration tests pass.
- [ ] **Step 3: Run `npm run typecheck`** and confirm zero errors.
- [ ] **Step 4: Commit** with message `feat: migrate legacy ledger to workspace v2`.

### Task 3: Add authenticated admin migration route

**Files:**
- Modify: `src/index.ts`
- Create: `test/admin-workspace-v2-ledger.spec.ts`

**Interfaces:**
- Produces: `POST /v1/admin/workspace-v2/migrate-ledger`.
- Response: `{ transactions: number; receipts: number }` on success.
- Auth: same bearer authorization as existing admin endpoints.

- [ ] **Step 1: Write a failing route test** that verifies unauthorized requests return 401 and an authorized request mirrors a legacy transaction and receipt and returns exact counts.
- [ ] **Step 2: Run `npm test -- test/admin-workspace-v2-ledger.spec.ts`** and confirm failure because the route does not exist.
- [ ] **Step 3: Implement the route** using one `DropboxClient` and `mirrorLegacyLedger`.
- [ ] **Step 4: Run the targeted route test** and confirm pass.
- [ ] **Step 5: Run `npm run check`** and confirm all tests/typechecks pass.
- [ ] **Step 6: Commit** with message `feat: add workspace v2 ledger migration endpoint`.

### Task 4: CI, merge, and production verification

**Files:**
- No code changes expected.

**Interfaces:**
- Consumes: GitHub Actions CI and Cloudflare production deployment.

- [ ] **Step 1: Open a PR** from `finalize/workspace-v2-cleanup` to `main` describing migration and cleanup gates.
- [ ] **Step 2: Wait for CI** and inspect failures if any; do not merge until green.
- [ ] **Step 3: Merge with expected head SHA** once mergeable and green.
- [ ] **Step 4: Verify `main`** contains the migration endpoint and still has `PROJECT_OS_LAYOUT_MODE: "v2"`.
- [ ] **Step 5: Verify Cloudflare production deployment** corresponds to the merged commit before using the new endpoint.

### Task 5: Migrate and verify Dropbox history

**Files / Dropbox paths:**
- Read legacy: `PROJECT_OS/TRANSACTIONS`, `PROJECT_OS/RECEIPTS`.
- Read V2: `PROJECT_OS/.project-os/transactions`, `PROJECT_OS/.project-os/receipts`.

**Interfaces:**
- Consumes: production admin migration endpoint.
- Produces: exact filename parity between legacy and V2 audit history.

- [ ] **Step 1: Invoke the authenticated migration endpoint** without exposing secret values.
- [ ] **Step 2: List legacy and V2 terminal transaction folders and receipt folders** and compare exact filenames.
- [ ] **Step 3: Stop immediately** if any legacy file is missing or differs in V2.

### Task 6: Move Obsidian config and remove verified legacy roots

**Dropbox mutations:**
- Move: `/Applications/project-os/PROJECT_OS/.obsidian` → `/Applications/project-os/PROJECT_OS/WORKSPACE/.obsidian`.
- Delete after parity: `/Applications/project-os/PROJECT_OS/PROJECTS`, `/SYSTEM`, `/TRANSACTIONS`, `/RECEIPTS`.

**Interfaces:**
- Produces final root with only `WORKSPACE` and `.project-os`.

- [ ] **Step 1: Confirm `WORKSPACE/.obsidian` does not already contain conflicting config.**
- [ ] **Step 2: Move root `.obsidian` into `WORKSPACE/.obsidian`.**
- [ ] **Step 3: Delete the four verified legacy data roots as one Dropbox batch.**
- [ ] **Step 4: List `PROJECT_OS` root and confirm only `WORKSPACE` and `.project-os` remain.**
- [ ] **Step 5: List `WORKSPACE` and confirm `PROJECTS`, `PORTFOLIO`, and `.obsidian` are present.**

### Task 7: Final canonical verification

**Files:**
- Read: `WORKSPACE/PROJECTS/PRJ-0002-project-os/STATE.md`
- Read: `.project-os/projects/PRJ-0002/state.json`
- Read: `.project-os/receipts/TXN-V2CUT-VALIDATE-20260821-0935.json`

**Interfaces:**
- Produces evidence that cleanup did not mutate business state.

- [ ] **Step 1: Verify PRJ-0002 remains revision 23 and active.**
- [ ] **Step 2: Verify EVT-000023 and the V2 cutover receipt still exist.**
- [ ] **Step 3: Verify the final Dropbox root structure.**
- [ ] **Step 4: Only then report the V2 delivery complete and provide Dropbox recovery guidance for deleted legacy folders.**
