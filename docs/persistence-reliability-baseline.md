# Persistence reliability baseline — 2026-09-24

## Reference

- Branch: `fix/permanent-convergence-rectification`
- Local baseline: `91c34301b46e742d7baffc98d63c83fa80efe8a9`
- Production baseline: `fe1eb15a49ee5baac855d49f5580335ac5f07ae1`
- Production version: `d18858f2-380d-45e6-aa24-a8ff8681a324`
- PRJ-0003 canonical and materialized revision: 353
- PRJ-0003 convergence: no active/requested/parked work and no pending obligation at observation time

This baseline is evidence for the reliability intervention. It does not certify future availability and does not close the wider SOP program.

## Public state contract

| State | Meaning |
|---|---|
| `not_received` | No durable intent, receipt, execution, or queued recovery was found. |
| `unknown` | The system could not establish absence or outcome within the read budget. |
| `admitted_uncommitted` | Durable admission exists without a committed receipt. |
| `recovery_scheduled` | Recoverable durable intent exists and a wake is scheduled. |
| `recovery_blocked` | Recovery stopped after a bounded terminal failure. |
| `committed` | Canonical business intent has a committed receipt; physical finalization may remain. |
| `finalizing` | Required physical effects or postchecks remain in progress. |
| `finalized` | Required effects and postchecks have verified evidence. |
| `rejected` / `conflict` / `failed` | Terminal outcomes with their existing domain meanings. |

Local cache absence alone must never produce `not_received` when remote evidence is unavailable.

## Measured and code-proven gaps

| Area | Deployed/current behavior | Required behavior | Evidence / owner |
|---|---|---|---|
| Fresh context | Snapshot is downloaded and parsed before immutable suffix verification; `include_state=false` only changes the response body. | Proven monotone local baseline plus bounded suffix; full rebuild only when needed. | ProjectGuard and repository, Task 3 |
| Chat context | Current phase uses the nonexistent `phases` field; a phase record is unbounded; active tasks are silently cut at 50. | Correct `plan_phases`, bounded fields, total/truncation/cursor. | Control Tower, Task 4 |
| Receipt | `get_receipt` aliases the deep request-status route. | Dedicated bounded receipt lookup; deep status remains separate. | Control Tower, Task 2 |
| Submission | Control Tower GET reads have 10 s deadline/correlation, submission context+POST does not. | One bounded correlated submission contract and explicit uncertain state. | Control Tower, Task 5 |
| Project creation | `PRJ-AUTO` allocation has no Control Tower status lookup by original transaction ID. | Registry request-status resolves allocation and receipt. | RegistryGuard/Control Tower, Task 5 |
| Fallback | Lost encrypted response requires client knowledge of inner transaction ID; exchange ID alone cannot resolve outcome. | Durable mapping/status or explicit recovery contract tested after lost response. | Fallback/RegistryGuard, Task 5 |
| Finalization | Batch limit counts certificates produced, not candidates examined. | Every dequeue counts against time/call/item budget. | ProjectGuard, Task 6 |
| Other hot paths | Materialization canonical suffix and completed-record head repair contain unbudgeted scans. | Persistent cursors and bounded work where measurements show production impact. | MaterializationGuard/coordinator, Task 8 |
| Documents/artifacts | Some replay identity comparisons rely on `JSON.stringify` property order. | Canonical semantic serialization for idempotency. | ProjectGuard/ledgers, Task 5 |
| Readiness | `/health` can pass while context/status routes exceed their caller deadline. | Functional probes for context, receipt, submission status, and finalization. | Deployment gates, Tasks 9–10 |

## Production observations

- Context requests were observed both timing out at the 10 second caller boundary and succeeding later.
- One successful ProjectGuard context trace completed in about 7.7 seconds.
- One request-status trace completed in about 3.1 seconds.
- A synthetic run of the deployed `boundedContext` logic with a large current phase and 51 active tasks produced about 203 KiB, returned only 50 tasks, and provided no truncation marker.
- Existing focused read/context tests were green while these production defects remained observable, so the missing scenarios are required regression cases.

## Plan relationship

The runtime intervention is governed by `docs/superpowers/plans/2026-09-24-end-to-end-persistence-reliability.md`. The broader SOP registry, enforcement, coverage, activation, exception, and historical repair program remains open and must retain separate acceptance evidence.
