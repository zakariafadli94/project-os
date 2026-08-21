# Workspace V2 Legacy Cleanup Design

## Goal

Complete the Workspace V2 migration without losing any canonical history, leaving `PROJECT_OS/` with only `WORKSPACE/` and `.project-os/` as active top-level structures.

## Current state

Workspace V2 is deployed in production and validated by a committed V2 transaction. Human project material exists under `PROJECT_OS/WORKSPACE`, machine project state/events and the registry exist under `PROJECT_OS/.project-os`, and new V2 transactions/receipts are written under `.project-os`.

Legacy `PROJECTS`, `SYSTEM`, `TRANSACTIONS`, `RECEIPTS`, and the old root `.obsidian` still exist. The legacy transaction and receipt folders contain historical records that are not yet mirrored into `.project-os`, so deletion before migration would lose canonical audit history.

## Design

1. Extend the existing Workspace V2 migration module with an idempotent immutable-ledger migration. It mirrors legacy committed/rejected/conflict transaction files into `.project-os/transactions/<status>/` and legacy receipt files into `.project-os/receipts/`. Existing identical files are accepted; conflicting content fails closed.
2. Add an authenticated admin endpoint `POST /v1/admin/workspace-v2/migrate-ledger` that executes the ledger migration and returns exact mirrored counts. This gives future operators a reproducible migration mechanism rather than relying on manual Dropbox copying.
3. Keep business revisions unchanged. Ledger migration is infrastructure migration only and must not emit project events or receipts of its own.
4. After deployment, run the migration, compare legacy and V2 transaction/receipt inventories, and require exact filename parity before cleanup.
5. Move the old root `.obsidian` folder to `WORKSPACE/.obsidian` so the human-facing Workspace root carries the existing Obsidian configuration.
6. Only after parity verification, remove legacy `PROJECTS`, `SYSTEM`, `TRANSACTIONS`, and `RECEIPTS` from the active root. Dropbox deletion remains recoverable through Deleted files.
7. Verify the final root contains only `WORKSPACE` and `.project-os`; verify `WORKSPACE` contains `PROJECTS`, `PORTFOLIO`, and `.obsidian`; verify PRJ-0002 remains revision 23 and the V2 receipt/event/state remain intact.

## Safety properties

- No historical transaction, receipt, project event, registry record, or human project view is deleted before a corresponding V2 copy is verified.
- Migration is restartable and idempotent.
- Content mismatch at an existing V2 destination is a hard error, never overwritten.
- Cleanup does not modify business revision numbers.
- Legacy deletion is a separate operational step after migration and parity checks.
- `.project-os` remains outside the Obsidian Vault; `WORKSPACE` is the only Vault root.

## Validation

- Unit tests cover idempotent transaction and receipt mirroring, restart after interruption, and conflict detection.
- CI must pass `npm run check` and Wrangler dry-run before merge.
- Production deployment must correspond to the merged commit.
- Migration endpoint must return successful counts.
- Dropbox inventories must prove exact parity before legacy deletion.
- Final root and PRJ-0002 revision/state are re-read after cleanup.