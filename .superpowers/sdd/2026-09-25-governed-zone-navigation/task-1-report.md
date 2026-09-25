# Task 1 report — zone identity and resumable navigation engine

## Result

Implemented the Task 1 navigation request, receipt and engine in the three owned files. The engine binds `(project_id, zone)` to distinct machine navigation heads, validates the exact admitted request and effect scope, snapshots paged server-owned inventory, validates source metadata and bytes, preserves an adopted index in visible history, conditionally updates the index and head, and returns `pending`, `conflict` or `finalized` with a dedicated receipt/certificate reference.

## Interfaces for Task 2

- `NavigationReconcileRequest` / `navigationReconcileSchema`: strict `navigation.reconcile` request with request/project IDs, zone, expected project revision, expected navigation generation, exact optional index identity and creation timestamp.
- `ZoneNavigationReceipt`: separate `committed` navigation evidence with zone generation, index identity, source snapshot ID, coverage gaps, mutable head ref and immutable `finalization_ref`. It is not a managed document version.
- `ZoneNavigationEngine(runtime, inventory, postchecks?)`: `reconcile(request, state, admission, budget)` consumes the existing server-created `ExecutionAdmission`. Admission must bind the request hash, project/zone generation resource, exact zone index destination, and—when adopting an existing index—its source address and exact visible preservation-copy address.
- `NavigationInventoryPort`: paged canonical entries include project, zone, resource/version, safe zone-relative path, provider object/revision identity, content SHA-256 and byte size. Implementations receive `SliceBudget` and must charge every provider call. `verifyEntry` rechecks an exact saved reference; `verifySnapshot` verifies its stable generation marker without restarting an unbounded scan.
- `NavigationPostcheckPort`: optional trusted server adapter for deferred admission rules. The engine fails closed when deferred checks exist and no adapter is supplied, and records each post-execution result plus the published index identity in the progress journal before head finalization.
- `zoneNavigationHeadPath(project_id, zone)` exposes the fixed machine head path for Task2 status/recovery integration.

## RED/GREEN evidence

- Initial RED: `PATH="/Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" node_modules/.bin/vitest run test/zone-navigation.spec.ts --reporter=dot` failed at module resolution because the new domain module did not yet exist (1 failed suite, 0 tests). This was a missing-feature signal, not a behavioral assertion.
- Behavioral RED: after adding binary and deferred-rule assertions, the targeted run had 10 tests, 8 passing and 2 failing. Binary source inspection returned `navigation_target_missing_or_changed` because the engine only read text. A deferred rule escaped as a thrown `navigation_postchecks_unavailable` instead of the promised conflict result.
- Scope RED: `vitest run test/zone-navigation.spec.ts -t "requires the admission to bind" --reporter=dot` failed because an admission missing the exact preservation-copy address still finalized.
- Final GREEN: `vitest run test/zone-navigation.spec.ts --reporter=dot` passed all 12 tests (1 file).
- Typecheck: `node_modules/.bin/tsc --noEmit` passed.
- Hygiene: `git diff --check` passed.
- The repository full suite was not rerun for this slice. The unchanged-code baseline had already completed separately with 257 files / 1,652 tests passing; its pre-existing form-urlencoded warnings were reported by the parent task.

## Independent-review corrections (2026-09-25)

- Reproduced four review findings before correction. The focused suite reported 4 failed / 12 passed: a persisted intention without progress retried as `navigation_progress_missing`; a deferred postcheck denial left a visible index with no faithful progress state; overlapping inventory pages finalized a duplicate source; and a BOM-prefixed legacy index could not be safely observed for byte-exact preservation.
- Intention now contains the initial frozen progress envelope. If the progress create is interrupted, an identical admitted retry verifies and recreates progress instead of poisoning the request.
- The inventory checkpoint carries previously seen resource IDs, so overlap between separately persisted pages is rejected before verification/publication and is not counted twice.
- Legacy index observation hashes raw bytes and requires strict UTF-8 round-tripping for the Markdown archive. Visible history copies are create-only and verified byte-for-byte; a provider without byte-read support, or unsupported encoding, fails closed before index replacement.
- Deferred checks remain post-execution checks: the rule references do not carry enough check-stage detail to reinterpret them as preconditions. The engine therefore publishes the index effect first, durably records the exact published index identity and each allow/deny/unavailable outcome in its progress CAS journal, and withholds head/finalization on deny or unavailable. Unavailable checks can be retried against the already-published index; deny remains a durable conflict.
- Added interruption, deny, unavailable-resume, overlapping-page, and BOM-preservation regressions. Final targeted GREEN: `vitest run test/zone-navigation.spec.ts --reporter=dot` passed 17/17 tests. Final `tsc --noEmit` and `git diff --check` passed.
- These corrections were not included in the previously reported full-suite result; the full suite was not rerun. No production writes or deployment occurred.

## Coverage

Tests cover strict request validation, byte-exact visible legacy archiving, three distinct zone identities, changed index CAS refusal, dual-name conflict, missing canonical targets, interruption and resume, request-ID payload conflict, binary target verification, deferred postchecks fail-closed behavior, exact admission preservation scopes, multi-page progress across bounded slices, and replay of an old finalized request without overwriting a newer generation.

## Limits before integration

- Task 1 intentionally exposes the trusted inventory adapter boundary instead of claiming a stable default managed-head scanner. Task 2 must supply a bounded managed-head/package/artifact adapter with a stable source-generation token and exact per-entry recheck.
- Public routes, automatic source invalidation/wakeup, common admission wiring, the dedicated family finalization coordinator, and live Dropbox behavior remain Task 2/3 work.
- No full suite, deployment, production write, or user-task message was performed by this slice.
