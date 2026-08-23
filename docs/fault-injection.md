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
