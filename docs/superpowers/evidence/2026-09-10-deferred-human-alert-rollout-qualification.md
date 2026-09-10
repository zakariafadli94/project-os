# Deferred human-alert rollout policy — qualification record

**Qualified implementation commit:** `de7cd36`

**Latest qualified branch tip:** `ddcdf53dde4609daf4f4f6a3d7a8f9450b91412b`

**Qualification date:** 2026-09-10

## Scope

This record qualifies one narrow policy change: a rollout review may explicitly
defer a missing human-notification acknowledgement.  The default remains
`required`; omission never grants the exception.  When `deferred` is selected,
only `notification_ack_proven: false` is removed from the pure review blocker
list.

The change does not start a notification channel, claim a delivery ACK, alter
incident/retry/metric persistence, activate a rollout mode, deploy a Worker,
mutate canonical Dropbox content, merge an integration, or repair PRJ-0003.

## Verified behaviour

| Check | Observed result |
| --- | --- |
| Default policy | Missing `notification_ack_proven` remains a blocker. |
| Explicit exception | `deferred` removes only that one blocker; missing transport, capacity, recovery, reader, writer, fencing, RegistryGuard or compatible-stable evidence still blocks. |
| Regression test | `test/convergence-rollout.spec.ts`: 1 file, 10 tests passed. |
| Complete suite | 201 test files and 973 tests passed. |
| Search-off prerequisite | 1 test file and 4 tests passed. |
| Task-16 persistence selection | 12 test files and 56 tests passed, including commit recovery, materialization faults/isolation, rollback, RegistryGuard, direct concurrency, provider resilience and materialization compatibility. |
| Static gates | Persistence boundary, production promotion authority, MutationGate repair workflow, INDEX001, binary ingress, recover-inputs and fallback-ingress boundary checks passed. |
| Type checks | `wrangler types` then `tsc --noEmit` completed successfully; the generated local type file was removed afterward. |
| Cloudflare dry run | `wrangler deploy --dry-run` completed, listed the existing six Durable Object bindings, and ended with `--dry-run: exiting now.` No Worker was published. |

## Post-review requalification

The later branch tip closes four implementation-review findings without
activating production: non-regressing conditional materialization-head writes
with post-publication verification, full provider re-verification before a
head repair, a fail-closed inactive V2 admin writer, and fleet wakes bounded
to four concurrent projects with cancellation propagation.  Recovery never
rewrites a completed workspace generation merely to repair its head: every
recorded output must still match its durable evidence.

| Check | Observed result at latest tip |
| --- | --- |
| Complete suite | 202 test files and 982 tests passed. |
| V2 activation boundary | Direct V2 workspace materialization is `409` while the writer is `off`; a repair-mode request is bounded and returns `202` while convergence remains pending. |
| Recovery evidence | Targeted ledger, writer, coordinator and provider-fault tests passed; a changed non-critical completed output prevents head repair with no workspace overwrite. |
| Fleet capacity | Targeted tests prove a maximum of four concurrent wakes and stop starting new wakes once the maintenance signal is aborted. |
| Static gates | All seven project checks listed above passed again. |
| Search-off prerequisite | 1 test file and 4 tests passed again. |
| Type checks and dry run | `wrangler types`, `tsc --noEmit`, and `wrangler deploy --dry-run` passed. The generated local type file was removed; no Worker was published. |

## Integration observations

Read-only checks on 2026-09-10 found `origin/main` at
`a7b927499265c625ab3f5827f34d94235ea19d0b`.  Promotion PR #147 remains open
and draft at `fcedf969e7d7e3e0de18ed258eb151f3f9699e75`; encrypted fallback PR
#139 remains open at `900dace142b8d73b08a9192a162befaa5016c7af`.  Neither is
treated as integrated by this branch.

## Production gates still blocking

1. Revalidate and integrate the owner-compatible #147 and #139 interfaces
   against the selected main before an admission/transport rollout.
2. Obtain the separate authorization and evidence for an isolated synthetic
   canary and its at-least-24-hour qualification: recovery, capacity, fencing,
   continuation, archive and rollback observations.
3. Establish reader-first, single-writer and compatible rollback evidence per
   project.  A deferred notification ACK is not evidence for any of them.
4. Complete the guarded rollout gates before any deployment or canonical
   change.  PRJ-0003 / REV-000263 remains untouched until then and must use
   the ordinary typed transaction plus a committed receipt.
