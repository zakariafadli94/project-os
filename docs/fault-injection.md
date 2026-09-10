# Project OS deterministic fault-injection harness

Status: implementation baseline for `IMP-FAULTTEST001`.

## Purpose

Project OS must be able to reproduce partial Dropbox failures deterministically before recovery, commit, migration, or rollback changes are allowed to reach production. This harness is test-only and does not add a production failure mode or a user procedure.

## Failpoint model

`installDropboxMock()` accepts one-shot `faults`. Each fault can target:

- a Dropbox API endpoint;
- an optional HTTP method;
- an optional Dropbox path;
- the Nth request that matches those selectors;
- an injected HTTP status and `error_summary`.

Path matching supports both Dropbox content headers (`Dropbox-API-Arg.path`) and JSON request bodies (`path`, `from_path`, `to_path`). Occurrence counting is local to each fault and increments only when its selectors match.

After a fault fires it is consumed. Subsequent matching requests use normal mock behavior unless another fault is configured. This makes replay and recovery tests deterministic.

## Invariants established by the harness

The harness tests prove that:

1. a fault fires on exactly the configured matching occurrence;
2. earlier successful writes remain intact;
3. the failed operation does not silently mutate the mock filesystem;
4. a path-scoped fault does not perturb unrelated paths;
5. faults can target both content-endpoint paths and JSON-body paths;
6. normal behavior resumes after a one-shot failure.

These are test-infrastructure invariants, not claims that Project OS already has complete crash recovery.

## Continuity boundary

This improvement changes test infrastructure only. It does not change transaction routing, artifact routing, ProjectGuard persistence, canonical Dropbox state, user-facing behavior, or the production continuity mode. Production remains `stable` under `IMP-CONTINUITY001`.

## Use by later roadmap packages

`IMP-RECOVERY001`, `IMP-COMMIT001`, and `IMP-ROLLBACK001` must use deterministic failpoints to reproduce specific write windows and prove their invariants before activation. A later change must not replace a deterministic fault test with timing-dependent sleeps or probabilistic failures.

When a newly tested failure window reveals an existing unsafe behavior, the failing invariant is evidence for the dependent improvement; it must not be hidden by weakening the assertion.

## Verification gate

Before this harness is merged:

- the red test for each new failpoint capability must fail for the intended missing behavior;
- the corresponding green implementation must make that test pass;
- the full `npm run check` suite must pass;
- Wrangler deploy dry-run must pass;
- PR review must confirm the harness is test-only and cannot affect runtime behavior.

## 2026-09-09 local qualification boundary

The complete local suite passed 935 tests and the persistence high-risk gate passed 148 tests on the permanent-convergence branch at `00250b623ee88bdcbed71252223b4adaee179c17`. Synthetic revision-258 recovery and virtual capacity qualification also passed; both use the fictitious `PRJ-9258` fixture, never PRJ-0003. This is code-level fault evidence only. It does not substitute for the planned 24-hour isolated canary, real provider latency/capacity measurements, notification ACK exercise, or integration of the external promotion/fallback prerequisites.

Regression SHA `3bbf7d2102dffeca834368cc8c5336840a2f8fda` extends this evidence from a single failure to six consecutive HANDOFF failures. It verifies retry exhaustion, the immutable incident, preservation of the revision-257 head and revision-258 receipt, no synthetic revision 259, and scheduled recovery/resolution after 20 minutes with no new input. The 13-file focused selection passed 58 tests and the complete suite passed 936 tests. It remains a test-only synthetic proof and does not replace any production gate.

The virtual capacity qualification is provider-free and deterministic: it simulates 24 hours of 10 projects × 5 commits/minute, 200 outputs/project, 20 changed outputs/commit and 1 MiB/commit at provider concurrency 1 and 4, with fleet concurrency 4. It verifies the 32-call slice ceiling, persisted continuation availability, p99/p99.9 SLO arithmetic, the 300-second fleet-visit limit, and explicit admission backpressure beyond the envelope. Its synthetic call latency is intentionally not cloud evidence; the isolated 24-hour canary remains required for `capacity_qualified`.

The acceptance suite also models the observed PRJ-0003 263→264 shape under the fictitious identifier `PRJ-9263`: a valid generation/head at 264 explicitly coalesces 263 while only the immutable event and receipt for 263 are absent. Read-only health must stay non-converged until both exact derivatives are rebuilt; the existing generation, head, critical pair, and canonical commit chain are preserved. This fixture never reads or writes the real PRJ-0003 workspace.

At implementation SHA `b7bca495c4805256db49b8db937d4b4ffc133176`, this regression and the virtual capacity qualification ran inside the 201-file / 971-test local suite; the separate 26-file / 148-test persistence gate also passed. These results are deterministic fixture evidence only and do not authorize a real-project failpoint, canary, deployment, or PRJ-0003 repair.

Implementation SHA `d63578252e7d64329540ce001ad0dc908d906454` adds a deterministic monitoring-boundary case: a successful HTTPS response with a body that never resolves must become an unacknowledged delivery at the same five-second deadline, not stall the serialized repair slice. It was red before the implementation and green after it; the complete local suite then passed 201 files / 972 tests. This fixture exercises no real endpoint or project.

## 2026-09-10 canary boundary

The production canary has not used fault injection. It is limited to synthetic PRJ-0008, where an ordinary authenticated materialization returned revision 2 as current after its durable human handoff was verified. The follow-up read-only admission check for PRJ-0003 returned its existing revision 267 and performed no mutation. Production fault, retry-exhaustion, rollback, or recovery exercises continue to use only synthetic fixtures; PRJ-0003 remains excluded.
