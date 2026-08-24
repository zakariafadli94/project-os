# IMP-MATERIAL001 Execution Notes — Exact Existing Regression Suites

This note is normative for execution of `docs/superpowers/plans/2026-08-24-imp-material001-projection-engine.md` and replaces any conditional wording in that plan about discovering an existing regression-test filename.

The repository was inspected after the plan was drafted. Use these exact existing suites; do not create duplicate compatibility suites under guessed names.

## Task 2 Step 6 — rendering regression suites

Run:

```bash
npx vitest run \
  test/materialization-planner.spec.ts \
  test/render.spec.ts \
  test/rich-render.spec.ts
```

There is no `test/render-human-views.spec.ts` or `test/sop-rendering.spec.ts` in the current repository.

## Task 3 Step 4 — Dropbox resilience regression suites

Run:

```bash
npx vitest run \
  test/materialization-writer.spec.ts \
  test/resilient-dropbox-transport.spec.ts \
  test/dropbox-read-resilience.spec.ts \
  test/dropbox-read-failclosed.spec.ts \
  test/dropbox-retry.spec.ts
```

There is no `test/dropbox-write-resilience.spec.ts` in the current repository.

## Task 6 Step 8 — commit/recovery/rollback regression suites

Run:

```bash
npx vitest run \
  test/materialization-project-guard.spec.ts \
  test/commit-record.spec.ts \
  test/commit-repository.spec.ts \
  test/project-guard-commit-recovery.spec.ts \
  test/project-guard-recovery.spec.ts \
  test/project-guard-commit-compat.spec.ts \
  test/rollback-project-guard.spec.ts
```

There is no generic `test/recovery.spec.ts` in the current repository; recovery coverage is split across the ProjectGuard suites above.

## Task 7 Step 6 — inbox/archive regression suites

Run:

```bash
npx vitest run \
  test/materialization-reconcile.spec.ts \
  test/materialization-archive.spec.ts \
  test/admin-process-inbox.spec.ts \
  test/inbox-isolation.spec.ts \
  test/project-guard-commit-archive.spec.ts
```

## Additional high-value existing suites for the final `npm test` gate

The full suite already includes these relevant compatibility/stress tests and they must remain green:

- `test/inbox-replay-cleanup.spec.ts`
- `test/write-coordination-stress.spec.ts`
- `test/workspace-layout.spec.ts`
- `test/workspace-migration.spec.ts`
- `test/dropbox-repository.spec.ts`
- `test/project-guard.spec.ts`
- `test/operations.spec.ts`
- `test/index.spec.ts`

## Scope discipline

Do not rename or migrate `@cloudflare/vitest-pool-workers` as part of `IMP-MATERIAL001`. The existing package is currently part of the repository's working test setup; its ecosystem rename is unrelated to projection-engine correctness and belongs to a separate maintenance change if needed later.
