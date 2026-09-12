# Project OS SOP Enforcement Runtime — Execution Plan

**Project:** PRJ-0002 — Project OS  
**Branch:** `fix/permanent-convergence-rectification`  
**Specification authority:** the founder-approved “Cahier des charges et plan d’exécution — Respect des SOP dans Project OS” accepted on 2026-09-12.

## Global constraints

- Dropbox remains canonical; never modify machine-managed canonical files directly.
- Every durable mutation uses a typed operation and a committed receipt.
- Reuse RegistryGuard, ProjectGuard, convergence, journals and existing provider boundaries.
- No new service, database, subscription, dashboard, production test project, chat, worktree or automation.
- SOP text is never executable code and a model declaration is never activation evidence.
- The server resolves all applicable global and local rules; clients cannot select or bypass them.
- Active rules are immutable and cumulative; local rules cannot weaken global rules.
- A rule cannot become active until its check, parameters, entry-point coverage, positive/negative tests, contradiction scan and historical-drift inventory are qualified.
- `committed` records durable intent; `finalized` additionally proves required effects and postconditions.
- External Dropbox mutations lose compliant status until observed and reconciled.
- Repairs and administrative operations use the same admission path.
- Human notifications are deferred and are not a production gate.
- Use test-first implementation and preserve all existing behaviour unless this specification changes it.

## Required guarantees

The implementation must demonstrate G01–G14 exactly as defined in the accepted specification: common admission, server-side resolution, qualified activation, cumulative scope, exact rule-version evidence, version-bound approvals, committed/finalized separation, idempotent resume, external-drift invalidation, project isolation, bounded exceptions, no admin bypass, data-only extension with existing checks, and visible coverage gaps.

## Task 0 — Inventory and coverage matrix (L0)

**Owner:** Agent C, read-only analysis; principal integrates documentation.

1. Refresh PRJ-0002 `STATE.md`, `HANDOFF.md`, relevant accepted decisions, SOPs and both anomaly inputs.
2. Inventory normalized mutation operations and every supported entry point: connector, Control Tower, API, inbox, fallback and admin/repair routes.
3. Map each mandatory rule to its source, scope, triggers, expected condition, current check, entry coverage, postcheck, external observability, known drift, implementation action and acceptance scenario.
4. Mark ambiguous or qualitative obligations explicitly; do not invent acceptance criteria.
5. Record file/interface ownership for Tasks 1–7 and every pre-flight dependency or overlap.

**Deliverable:** `docs/superpowers/specs/2026-09-12-sop-runtime-coverage-matrix.md`.

**Acceptance:** every mandatory rule found has a source, scope and coverage state; every supported entry is accounted for; gaps are linked to Tasks 1–7.

## Task 1 — Canonical rule and exception model (L1)

**Owner:** Agent A.

1. Add versioned global and project rule records with the exact fields from section 5.1 of the accepted specification.
2. Add lifecycle states `draft`, `accepted_unenforced`, `active`, `superseded`, `retired` and validate legal transitions.
3. Add bounded exceptions tied to exact rule/version, project, resources, operations and mandatory expiry.
4. Extend ProjectState compatibly: missing local-rule data decodes as empty.
5. Store global governance in RegistryGuard and project governance in ProjectGuard using existing event/receipt persistence.
6. Separate rule-management authority from ordinary project-mutation authority.
7. Add typed operations `rule.propose`, `rule.accept`, `rule.activate`, `rule.retire`, `rule.exception.grant`, `rule.exception.revoke`.

**TDD acceptance:** illegal transitions, mutation of active versions, authority escalation, implicit global override and unbounded exceptions fail; old states decode; complete legal lifecycle passes.

## Task 2 — Check catalogue, resolution and evaluator (L2)

**Owner:** Agent A.

1. Introduce a coded check catalogue declaring supported operations, parameter schema, required evidence, execution stage and result codes.
2. Register adapters for existing checks before adding new logic: expected version, allowed destination, exact approval, current-head uniqueness, verified archive, valid links, coherent phase, useful resume, terminal staging and verified presence.
3. Resolve active global plus local rules on the server; reject known activation contradictions and return `RULESET_CONFLICT` if discovered at runtime.
4. Implement `evaluateRules(operationContext)` with `allow`, `deny`, `approval_required`, `unavailable`.
5. Produce actionable refusals containing rule/version, expected condition, observed fact and required action.
6. Fail closed for missing global rule data or unsupported active checks while leaving independent reads available.

**TDD acceptance:** global inheritance, project isolation, contradictions, unknown checks, expired/revoked exceptions, qualitative rules without explicit approval and unavailable dependencies behave exactly as specified.

## Task 3 — Common admission across every entry (L3)

**Owner:** Agent B.

1. Normalize all supported mutation entry points into the same operation context.
2. Obtain RegistryGuard authorization bound to actor, project, request hash, global rule revision and short expiry.
3. Verify project rules inside ProjectGuard serialization immediately before admission.
4. Persist the evaluated global/local rule versions and evidence references with the admitted intent.
5. Ensure connector, Control Tower, API, inbox, fallback, admin and repair routes cannot choose or omit rules.
6. Keep already committed operations pinned to their recorded rule set; new admissions use the currently active set.

**TDD acceptance:** the same violation is refused through every entry; cross-request permits, stale permits and client-selected rule subsets fail; a rule activation during admission has deterministic semantics.

## Task 4 — Evidence, finalization and bounded resume (L4)

**Owner:** Agent B; principal owns shared convergence contracts.

1. Model and expose `rejected`, `committed`, `finalizing`, `finalized`, `conflict`, `failed` without redefining historical committed receipts.
2. Persist actor, request hash, global/local revisions, exact rules, verdicts, approvals, exceptions and postcheck results by references in existing journals.
3. Persist step progress so resume verifies completed effects and never duplicates them or expands intent.
4. Treat a verified newer target as superseding obsolete work.
5. Fingerprint internal failures and stop identical no-progress retries after six attempts, leaving an incident visible; retain normal transient retries when progress occurs or the failure changes.
6. Require declared resources and diagnosed drift for typed repair operations.

**TDD acceptance:** interruption at each boundary resumes once, obsolete work closes, identical failures stop, changed/progressing failures retain safe retry, and independent projects continue.

## Task 5 — Document/package, navigation and phase controls (L5)

**Owner:** Principal, with non-overlapping implementation briefs.

1. Reuse managed-document identity and add package identity plus a frozen per-version manifest.
2. Implement replacement as prepare → verify → commit intent → archive predecessor under `ARCHIVES/` → update active heads → regenerate navigation → postcheck.
3. Bind review and approval to an exact immutable version; preserve a published version while its successor is in progress.
4. Enforce a single current navigation head per active zone and generate STATE/HANDOFF links from the same canonical references.
5. Prevent finalization when referenced files or links are absent.
6. Process large packages by persistent cursor; copy and verify each file before conditional source removal; never assume recursive folder deletion is safe.
7. Reject phase completion while dependent tasks are unfinished unless an already-supported explicit disposition closes them.
8. Classify terminal staged requests without discarding rejection evidence.

**TDD acceptance:** reproduce and prevent the artifact-lifecycle and distributed-archive anomalies, incomplete packages, stale approvals, broken links, concurrent replacements, unfinished phases and unsafe deletion.

## Task 6 — External drift observation (L6)

**Owner:** Agent B.

1. Extend the existing Dropbox change tracking to re-evaluate rules affected by an observed governed resource.
2. Reuse the existing scheduled convergence/alarm path for a bounded daily incremental verification; do not create a new automation.
3. Persist cursors, lateness and findings; do not rescan archive contents wholesale.
4. Attach expected changes to their operation, resume authorized moves, mark unexpected disappearance/move as conflict, and avoid recreating an obsolete package.
5. Route only deterministic authorized repair automatically; retain business choices as explicit conflicts.

**TDD acceptance:** external disappearance removes conformity; expected moves reconcile; unexpected moves do not trigger stale restoration; late verification remains visible; unrelated projects progress.

## Task 7 — Independent coverage and adversarial review (L7)

**Owner:** Agent C, read-only.

1. Compare Tasks 1–6 against every matrix row and G01–G14.
2. Search for mutation routes bypassing common admission and for active rules ignored by any runtime version.
3. Review concurrency, authorization, exception bounds, unavailable behaviour, evidence integrity, resume and project isolation.
4. Report only demonstrated defects with exact code/test evidence; owners correct blocking findings and C re-reviews them.

**Acceptance:** no unaddressed Critical/Important finding; every guarantee has executable evidence or is explicitly reported as not equipped.

## Task 8 — Integration and pre-production qualification (L8)

**Owner:** Principal.

1. Run focused suites throughout Tasks 1–6, then the full suite, type checks, persistence-boundary checks, deployment-authority checks and Cloudflare dry-run build.
2. Run the mandatory extensibility test: add one global and one local rule using an existing check without changing routes or adding a service.
3. Record commit SHA, build identity, coverage matrix and residual unsupported obligations.
4. Obtain final whole-branch review and fix all blocking findings.

**Acceptance:** pristine complete verification, dry-run success, reviewed branch and explicit residual-gap list.

## Task 9 — Deploy, activate and repair (L9)

**Owner:** Principal only.

1. Deploy the qualified version through the existing production promotion path and verify its identity and health.
2. Import accepted historical rules according to available evidence; unequipped rules remain `accepted_unenforced`.
3. Activate only qualified rules using typed governance operations and committed receipts.
4. Refresh PRJ-0002, PRJ-0003, PRJ-0007 and PRJ-0008 before repair.
5. Repair through typed transactions only:
   - PRJ-0007: stop obsolete convergence work, consolidate archive routing, classify duplicates by identity/role, repair indexes.
   - PRJ-0003: reconcile missing/obsolete active references, current navigation and tasks attached to completed phases.
   - PRJ-0002: link the two anomaly reports to rules and correction tasks while preserving them as evidence.
   - PRJ-0008: verify test evidence, explicitly resolve remaining tasks, then complete/archive only if canonical conditions are satisfied.
6. Verify every committed repair physically; never delete based only on name and size.

**Acceptance:** deployed identity is observable; activation and repair receipts are committed; required finalization/postchecks pass; unresolved business choices remain conflicts rather than invented decisions.

## Task 10 — Final qualification and handoff (L10)

**Owner:** Agent C plus principal.

1. Re-run the coverage matrix against production behaviour and physical Dropbox state.
2. Demonstrate G01–G14 with named tests, receipts and observations.
3. Distinguish `committed` from physically `finalized` in the report.
4. Publish the final evidence package: matrix, contracts, review report, deployed identity, activation/repair receipts, physical verification and residual unequipped rules.

**Definition of done:** all active rules are applied on every declared entry, admission and finalization evidence is durable, exceptions are bounded, resume is idempotent, external drift removes conformity, independent projects continue, current anomalies are repaired, production code is identifiable, and all G01–G14 are demonstrated. Anything not proven is reported as incomplete.
