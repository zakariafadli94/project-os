# IMP-MATERIAL001 TDD Execution Log

This file records implementation-stage RED/GREEN evidence for the approved Projection Engine plan.

## Task 1 — durable materialization evidence

RED commit: `2c1c9bfece617a64838d2ddf3602d39fb589418d`

RED reason: `test/materialization-repository.spec.ts` imported materialization domain/path/repository APIs that intentionally did not exist.

GREEN implementation reached head `fe9f8bebb17bc5e5b56fc7a93a8f8ec08a4e3a43`.

GREEN CI: `32748917162` — `npm run check` success and Wrangler deploy dry-run success.

Implemented: validated materialization contracts, deterministic paths, immutable completed-generation records, validated head publication, record listing, and canonical-derivatives materialization without human-view writes.

## Task 2 — semantic fingerprints and incremental planner

RED head: `e194acb7157626f18f81a4ead9a92f353d7ecd55`.

RED CI: `32749181790` — typecheck failed only because `src/materialization/hash.ts` and `src/materialization/planner.ts` were absent.

GREEN implementation included `src/materialization/hash.ts` and `src/materialization/planner.ts`.

GREEN CI: `32749357370` — full check and dry-run success.

Implemented: deterministic canonical hashing, exact semantic inputs, critical STATE/HANDOFF planning, entity-scoped rendering, carry-forward of unchanged views, and projection-version rematerialization.

## Task 3 — bounded projection writer

RED head: `419f3b1fe0df01d3faaef85d27c2b816e521844b`.

RED CI: `32749604544` — writer contract intentionally absent.

GREEN CI: `32749714876` — full check and dry-run success.

Implemented: bounded concurrency `1..4` (default 4), resilient Dropbox transport reuse, baseline destination preconditions, machine-managed bootstrap protection, content-hash idempotency, and critical read-back verification.

## Task 4 — SQLite hot ledger

RED head: `d60bec907df661918ba3343cac15a8c17f2544da`.

GREEN head: `7200eff3571d049063414b4dc8231c665dd917bc`.

GREEN CI: `32750032078` — full check and dry-run success.

Implemented: requested/active/completed target state, coalescing, per-output verified progress, baseline restore, and atomic local completion. SQLite remains rebuildable hot state and stores no Markdown/business truth.

## Tasks 5–6 — coordinator and asynchronous ProjectGuard integration

Implemented and covered before the Task 7 full gate:

- snapshot/delta completed generation records;
- bounded 128-record reconstruction chain;
- root-hash validation;
- record-before-head publication ordering;
- head repair from immutable evidence;
- per-output resume;
- safe revision coalescing;
- V2 canonical derivatives separated from human projection;
- ProjectGuard commit path returns from canonical business durability rather than full workspace completion;
- alarm scheduling/reconciliation;
- project-create standalone receipt ownership retained by RegistryGuard;
- exact replay/recovery/rollback compatibility suites retained.

The coordinator, ProjectGuard and recovery tests all passed inside the later Task 7/8 full-suite gates.

## Task 7 — fleet reconciliation and archive-safe materialization

Initial combined RED identified two real integration defects:

1. scheduled observability still asserted the old inbox-only lifecycle name;
2. coordinator always used the active workspace root and never completed archive projection/movement.

The archive correction then exposed one narrower retry defect: after a technical generation-record failure the workspace had moved correctly, but no explicit next alarm was visible for deterministic retry.

Corrections:

- scheduled maintenance now processes inbox + materialization reconciliation together;
- fleet reconciliation bounded to four projects with per-project failure isolation;
- archive projection stages/moves/verifies critical files and publishes `workspace_location=archive`;
- archived retries do not resurrect an active workspace;
- technical alarm failure explicitly schedules another alarm before rethrow;
- scheduled observability test aligned with the actual maintenance contract.

GREEN head: `d2c2d47be7437a4815cbb0edfbafa5bacf45326d`.

GREEN CI: `32755477169` — full suite (227 tests at that gate) and Wrangler dry-run success.

## Task 8 — efficiency, fault proofs and structured signals

Dropbox test instrumentation was extended with exact upload/download paths and maximum concurrent upload count without changing default mock semantics.

RED head: `675e21d92aa225620fc6b56a3f9d9862fba29c94`.

RED CI: `32755879774`:

- 53 test files;
- 231 tests total;
- 230 passed / 1 failed;
- the only failure was the intentionally missing `Project OS materialization attempt` structured log.

All Task 8 behavior assertions already passed in RED:

- task-only mutation avoided unrelated decision/research/deliverable uploads and avoided `BRIEF.md` upload;
- immutable generation evidence repaired a failed head with zero workspace rewrite;
- hot materialization state rebuilt from external completed evidence;
- burst revisions coalesced to newest projection while preserving every canonical commit;
- provider concurrency remained within the configured bound.

GREEN implementation added exact writer outcomes (`uploaded`, `content_hash`, `attempt_reuse`) and one structured materialization summary containing identifiers/counters only.

GREEN head: `bf26c5ce19abfb734564ec4b3f8cd62dc11ab878`.

GREEN CI: `32756466408` — `npm run check` success with 231 tests and Wrangler deploy dry-run success.

## Task 9 — documentation / final production gate

Implementation documentation now records the asynchronous canonical/projection contract in:

- `docs/materialization.md`;
- `docs/commit-consistency.md`;
- `docs/deployment.md`;
- `docs/project-os-sop.md`.

Final exact-head CI, merge, production deployment, health proof and canonical PRJ-0002 closure remain required before `IMP-MATERIAL001` is considered production-complete.
