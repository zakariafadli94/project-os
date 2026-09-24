# Persistence V2 — qualification report (in progress)

This report is not a completion certificate. The local code candidate has passed its integrated suite, but CI, deployment, production recovery and four real-client writing probes remain pending. All numbers below are local fixtures, not Cloudflare production measurements.

## First integrated-suite run and triage

The first `pnpm test` candidate run exited 1: 1,602/1,626 tests passed; 24 tests failed across nine files. It is not a qualified SHA. Three independent triage groups owned disjoint file sets. The first group traced its 13 failures to an acceptance fake ledger missing the now-durable repair-scan checkpoint and to stale PV5 expectations; `dd1418e` updates those fixtures, and the principal independently reran its three files with 37/37 tests passing. ProjectGuard's recovery-order defect was subsequently fixed in `ddc96d2`. No production deployment or canonical write was made from this run.

The archive group exposed a genuine liveness defect: a repair wake with a persisted final-verification cursor re-entered discovery/derivative preflight, spending roughly 23 provider calls before a mandatory 12-call four-view proof. With a 32-call slice limit, 128 wakes could leave revision 2 unpublished behind revision 1. `4ddf253` resumes that specific final-verification phase through the bounded coordinator, still checks fresh four-view provider identities, and arms a subsequent wake to acknowledge the verified head in the convergence journal. The principal independently reran archive/fault/schema tests (11/11) and typecheck green; `224d3cb` additionally makes the archive fixture fail if its alarm sequence does not quiesce. This is local evidence, not a production recovery claim.

The second full-suite candidate run passed 1,626/1,627 tests; the sole failure was a callback-concurrency test object constructed without the newly required durable ledger seam. The real guard always constructs that ledger. `7a10bd6` supplies it to the isolated test object, and the principal reran all six callback-concurrency tests green. `ddc96d2` also corrects a separate ProjectGuard queue-order defect: document recovery no longer consumes transaction cursor positions or schedules a premature transaction wake. Its 36 targeted tests were independently rerun green, then reviewed by a different agent without a blocking finding.

The third integrated run exited 0: **256/256 test files and 1,627/1,627 tests passed** in 191.71 s. Its printed `uncaught exception` traces were reviewed against explicit fault-injection/negative tests: Dropbox change-listing 400/reset, staged intent/commit/post-commit failures, current-view drift and invalid head/canonical bindings, and forbidden schema-writer downgrade. Each corresponding test asserts failure or recovery and passes; these are harness logs from intentional rejected promises, not unexplained green-suite exceptions. The repeated form-urlencoded `.text()` warnings come from the fixture transport parser. No unclassified exception was found in the run log.

After the synthetic writer-cadence fixture and a fallback-ingress receipt-collision regression were added, a fourth integrated run exited 0: **257/257 files and 1,629/1,629 tests passed** in 191.62 s. The same intentional fault-injection traces and fixture parser warnings were classified again. Independent review then found a further legacy fallback ambiguity with an intent but no receipt or exact request digest. That finding was subsequently corrected; the fourth run was therefore **not** the final qualified code tree.

`6bcd205` closes that ambiguity. The failing regression bound a fallback exchange to payload B while an older durable intent for payload A used the same transaction ID: prior status incorrectly reported `admitted_uncommitted`. RegistryGuard now requires the exact execution request digest before attributing receipt, intent or progress to an exchange; only ProjectGuard's verified `not_received` absence may produce a safe same-request retry without that digest. Targeted encrypted-fallback tests pass 13/13, including the legacy committed receipt, legacy pending intent, verified absence and strict lost-response cases. B independently reviewed the final diff and found no blocker.

The fifth complete suite on this exact code tree exited 0: **257/257 files and 1,631/1,631 tests passed** in 189.41 s. The intentional fault-injection traces and fixture form-urlencoded parser warnings were again classified; no new unexplained exception appeared. `pnpm run typecheck`, all seven static repository gates, `pnpm run test:search-sync-off` (4/4), both Wrangler deployment dry-runs and `git diff --check` passed on this code tree. The generated local `worker-configuration.d.ts` remains untracked and is excluded from the candidate. No package manifest, lockfile, secret file or canonical Dropbox state is in the diff. This is local qualification, not production acceptance.

## Historical-size cost profile

Command: `pnpm exec vitest run test/persistence-cost-profile.spec.ts --silent=false --reporter=verbose`.

Observed on 2026-09-24: one test passed. The fixture grows accepted research records, seeds the exact canonical head record and snapshot, reads fresh context, then measures a second unchanged read. It separately invokes the local commit-cache persistence step and counts SQLite's actual `rowsWritten`; this is **not** the total cost of admission, canonical persistence, projection or finalization.

| Historical revisions | Warm provider calls | Warm downloads | Warm provider uploads | Local commit-cache SQLite rows written | Compact canonical record bytes | Compact state bytes |
|---|---:|---:|---:|---:|---:|---:|
| 50 | 1 | 1 | 0 | 3 | 9,023 | 8,080 |
| 1,000 | 1 | 1 | 0 | 3 | 153,396 | 152,434 |

The warm read probes only the next immutable commit path, not the history or full snapshot. Canonical commit records still contain full state: their bytes are **not constant** as the project grows.

A second probe submits an actual typed `research.add` through ProjectGuard with a fresh signed context and strict admission. Both submissions return `committed` at the next revision. This measures admission and commit only, not subsequent materialization/finalization or other actors' SQLite writes.

| Historical revisions | Submission provider calls | ProjectGuard SQLite rows written | Provider uploads | Uploaded-path final-byte estimate |
|---|---:|---:|---:|---:|
| 50 | 32 | 15 | 6 | 15,984 |
| 1,000 | 32 | 15 | 6 | 212,628 |

Fresh command: `pnpm vitest run test/persistence-cost-profile.spec.ts --reporter=verbose --silent=false`, one test passed. Byte estimates sum final mock contents for each uploaded path, not captured network payloads; repeated writes to the same path may differ. The 32 calls are the aggregate submission path, not one materialization slice. Complete end-to-end storage costs and production latencies remain unqualified; the separate 30-project/200-output projection workload is described below.

## Control Tower review correction

Independent review found two actionable-error gaps: ambiguous submission responses omitted ownership/action, and HTTP dependency failures bypassed the structured recovery response. Five added regression cases failed before the fix; after the fix, eight targeted files passed with 64 tests. Existing receipt-not-found semantics remain, with additive correlation and recovery fields. The response does not claim a scheduled retry when none was observed (`next_attempt_at: null`).

## Interim exception classification

The principal's cost/capacity/document-job run passed 15 tests across four files. Its `ProviderOperationError: Dropbox change listing failed` originates in the deliberate `list_folder` 400/reset fault in `document-change-job-faults.spec.ts`: that test catches the failed request and verifies that the old cursor survives. It is an expected fault-injection trace, not an unexplained production exception. The form-urlencoded `.text()` warnings originate in the mock transport body parser. These classifications do not replace the final integrated run's warning review.

## Direct and coalesced autonomous finalization

`pnpm vitest run test/persistence-finalization-sequence.spec.ts`: one test passed. Three real typed `task.create` requests pass strict admission in a local fixture. Revision 2 first materializes separately; revisions 3 and 4 are then submitted before the next materialization. Only MaterializationGuard and ProjectGuard alarms are run until their durable wakes are empty. Generation 4 explicitly lists revision 3 as coalesced. All three execution journals are then read as `finalized / terminal:true`, with their certificates present in the provider mock. No execution-status GET, synthetic completed generation, or manual finalization callback drives this test. C independently reviewed and reran it; committed with the cost fixture in `4a75bdb`.

## Entry and approval continuity fixtures

`05f059e`, principal command `pnpm vitest run test/persistence-entry-parity.spec.ts test/persistence-approval-continuity.spec.ts`: three tests passed. Fresh strict admissions, existing business refusal `RESEARCH_EXISTS`, and same-ID changed-payload collisions are exercised through API, inbox, MCP and encrypted fallback. Frozen approval evidence survives three injected after-write lost acknowledgments (HTTP 409 faults, not literal transport deadlines), followed by journal finalization; changed resource version/digest under the same identity is refused. This storage-contract fixture does not qualify production issuance/evaluation of approvals. Other fault-boundary evidence remains to be mapped before E10 closes.

C's fault-boundary review maps existing coverage as follows; all files still require the final integrated candidate run:

| Boundary | Existing executable evidence |
|---|---|
| Staged request before immutable intent upload | `project-guard-commit-recovery.spec.ts`: staged request recovery; no server recovery claim before any durable reception |
| Immutable intent before canonical commit | Same suite: failed commit write recovery and rejection of different bytes under the staged identity |
| Commit completed, response lost | Same suite: recorded commit recovery without second revision; `fallback-ingress.spec.ts`: exchange lookup after response loss/key rotation/cache loss |
| Physical effect before checkpoint/certificate | `execution-lifecycle.spec.ts`: copy/remove interruption, re-observation, checkpoint loss and finalization response loss; `persistence-finalization-sequence.spec.ts`: actual strict requests and alarm-only terminal certificates |
| Concurrent submissions | `project-guard-direct-concurrency.spec.ts`, `dropbox-change-guard-inbox.spec.ts`, `write-coordination-stress.spec.ts` |
| Capacity before inbox admission | New real-admin/real-DO fixture `persistence-inbox-capacity-boundary.spec.ts`; independent review and typecheck corrections completed |

The review does not equate an HTTP 409 injected after a durable write with a transport timeout. Shared transport deadlines and lost-response classification are independently exercised by E5.

## Interim convergence workload and warm-head drift

The local alarm-only workload fixture seeds 30 projects, of which five have an active 200-output projection. All five reach their materialized head in 97 durable wakes each; the 25 dormant projects acquire no alarm. The maximum measured MaterializationGuard slice is 28/32 provider calls and the maximum ProjectGuard finalization slice is 8/32. After the final-verification liveness fix, the observed maximum aggregate is 52 provider calls in one alarm because the verified-head acknowledgement and the resumed coordinator each have a separate bounded slice. E12 specifies 32 calls **per slice**, not per whole alarm; this is not evidence of a 52-call single-slice allowance. The fixture does not measure maximum real wall-clock time of that alarm, so runtime latency under production Dropbox remains an observation item rather than a claimed pass. This fixture measures projection catch-up after historical commits have been seeded, not the full commit-cadence profile or production latency.

The separate transient-provider profile passes locally: five independent 20-output projects, 13 historical commits preseeded per project, deterministic 100 ms virtual latency on 2,232 provider calls, one injected Dropbox 503 with `Retry-After: 30`, and all five heads reached by alarm. The measured retry delay is approximately 29.7 seconds and total virtual elapsed approximately 240.3 seconds; these are **virtual-clock**, not real production timings. `withProviderResilience` now propagates a long provider hint rather than sleeping inside a Worker, while a short hint remains eligible for inline retry. The independently rerun resilience/Dropbox/workload tests pass (13 tests). This profile does not yet demonstrate 20 modified outputs **per commit** or a five-commits/minute cadence.

`a19bc37` adds a separate cadence fixture: 30 projects are seeded, five active projects first reach PV6 heads with 200 outputs, and each then receives 20 `research.add`-shaped canonical fixture commits separated by one virtual minute. Alarm-only projection reaches revision 213/220 outputs per active project without duplicate output keys or paths; 25 dormant projects remain without head or alarm; the measured MaterializationGuard slice budget stays at or below 32. The principal reran this test green (14.08 s). These commits are **seeded**, not admitted through ProjectGuard, so this qualifies projection cadence only, not transaction admission throughput. A RED trial tried changing 20 existing research outputs within one synthetic `research.add` commit, but the planner treats that operation as affecting only its identified research entity. Therefore **20 changed outputs in one commit is not qualified**: there is no present typed operation that legitimately has this effect. The fixture proves the actual operation-shaped cadence and the larger 200-output initial projection separately, not an invented bulk mutation.

An independent review identified a legitimate *one-shot* >20-output event: a typed `research.add` while upgrading a rich project's baseline projection version (PV5→PV6) invokes the planner's full rebuild. `704e952` adds that migration fixture: it materializes a real PV5 baseline of 200 outputs, seeds the next typed research commit, and then uses alarms only. The principal reran it with 1/1 passing: the PV6 generation has 201 outputs, at least 20 rewritten outputs, no duplicate keys/paths, and at most 32 provider calls per slice. This is **not** steady-state 20 modified outputs on every commit; current typed entity operations target one ID and do not express that workload.

`362ef97` separately tests writer capacity under a **synthetic** 20-changed-output plan (not an admitted business transaction): 30 project IDs with five active, 200 baseline outputs per active project, five plans per minute/project spaced 12 virtual seconds apart, 20 changed and 180 carried per plan. The real `WorkspaceProjectionWriter` completes each plan in two slices and 40 counted calls/4 virtual seconds at 100 ms/call, max 28 calls/slice, checkpoint reserve ≥4, 50 total wakes and no duplicate writes/paths; the principal independently reran its one test green. The 30-second provider outage remains qualified by the separate runtime profile. This writer profile cannot prove that a current typed business operation causes 20 changed outputs every commit, nor can it prove ProjectGuard admission at that synthetic rate.

An independent review found that a locally cached materialization head could be acknowledged without re-reading externally mutable current views. `564f2bc` makes any needed acknowledgement recheck `PROJECT.md`, `PLAN.md`, `STATE.md` and `HANDOFF.md` against the exact recorded provider identities, revisions and hashes. A provider-side `PROJECT.md` drift fails closed and preserves the pending obligation; unchanged views still acknowledge. The principal reran 64 focused tests and current typecheck successfully. No claim is made for an idle wake needing no acknowledgement.

## Bounded finalization and retry review

`f0e229b` honors provider `Retry-After` in the bounded convergence path. A long hint is propagated out of the inline retry wrapper instead of sleeping for 30 seconds inside a Worker; a short hint can be retried within the remaining slice. The Dropbox parser accepts seconds/date values and bounds them at 24 hours. A 180-second hint no longer shortens to the former 120-second convergence cap. `dropbox_request_timeout` remains a transient failure across seven recovery attempts.

`eb31bf5` makes ProjectGuard finalization resumable under a shared provider scope: the legacy PV<=5 canonical-range proof persists its exact generation-bound `next_revision` and resumes beyond 32 reads. A second candidate in the same verified generation reuses the proof. For PV6+, an omitted coalesced revision produces `materialization_coalescence_gap`, retains request/work, leaves execution non-terminal, and exposes a blocked diagnosis only for omitted revisions; no certificate is created. A 202 callback with no durable progress applies backoff and stops after six identical internal failures, retaining the accepted intent. The recovery progress probe is separately bounded to five seconds/eight calls.

C independently reviewed these paths and found no remaining blocker. The principal reran seven focused suites with 59 tests passing and `pnpm run typecheck` exit 0. The final integrated suite and production behavior remain separate gates.

The principal reran seven static repository gates (`persistence-boundary`, `production-promotion-authority`, `mutation-gate-repair-workflow`, `index001-remediation`, `binary-artifact-ingress`, `recover-inputs-workflow`, `fallback-ingress-boundaries`) after the final integration correction; all exited 0. `pnpm run typecheck` and `pnpm run test:search-sync-off` (4/4) exited 0. Both Wrangler dry-runs (`wrangler.jsonc` and `wrangler.control-tower.jsonc`) exited 0. The only changed Wrangler configuration adds the existing Worker version-metadata binding to Control Tower, not a new subscription or storage resource. CI must still qualify the exact PR head before merge.

## Remaining gates

- E12: local gates and independent reviews are complete; CI on the exact PR head remains. The synthetic 20-changed-output writer fixture does not prove an actual typed operation with that steady-state shape or real Cloudflare latency. No E13 production promotion is authorized until CI and merge gates pass.
- E13: exact-main deployment and technical-only catch-up; production behavior remains unqualified.
- E14: separate classic ChatGPT, new classic ChatGPT, local Work and Codex probes, each including a new governed submission, finalization and physical readback.
- E15: governed qualification report and explicit global SOP remainder.

## Separate historical navigation-index gap (not authorized in V2)

Read-only coordination with PRJ-0003 found three pre-existing, untracked `00-CURRENT-INDEX.md` files in WORKING, REVIEW and DELIVERABLES. Their exact provider identities/hashes are held by the PRJ-0003 task; this V2 branch has not changed them. `working.write` rejects unlike existing bytes without a managed version (`UNTRACKED_VISIBLE_FILE`), candidate adoption shares that boundary, reconciliation cannot guarantee rediscovery after its cursor has advanced, and a generic published bootstrap requires provenance. `artifact.write` would falsely classify the human navigation index as a published legacy artifact. The three same relative paths also resolve to the same work-product document ID if bootstrapped naively. The other task explicitly disallowed treating that as a valid migration and did **not** authorize a new route here.

The separate SOP/document-lifecycle lot therefore remains unequipped: a narrow typed navigation-index adoption contract would need project/zone/path identity, exact file ID/revision/hash concurrency, immutable predecessor retention, per-zone navigation identity, common admission authority, idempotence, committed receipt, physical finalization and no false business validation. Neither DOCREQ-PRJ0003-ARCHIVE-BRAIN123-20260924-015 (outcome still unknown) nor the three index files are replayed or changed by V2. This is not counted as a V2 production success or a reason to fabricate a receipt.
