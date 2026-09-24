# Persistence reliability V2 — execution ledger

Authority: Founder explicitly approved V2 in this conversation on 2026-09-24.
Environment: existing local Work and worktree; principal orchestration and three Luna/high executors/reviewers. No cloud execution.

## Baseline

- Local HEAD at approval: `59a042c`; origin/main after fetch: `fe1eb15a49ee5baac855d49f5580335ac5f07ae1`.
- Production /health: same main SHA, version `d18858f2-380d-45e6-aa24-a8ff8681a324`.
- Control Tower deployments/version read through Wrangler: 100% version `fac275aa-7a0c-4209-a3b5-2315d59b97fb`, tag `git-cb9352645e63fd448727bd4771d01c47642ef2da`, created 2026-09-21T16:20:30.452Z. Guard and Tower therefore have distinct deployed revisions. GitHub PR-run lookup for Guard main SHA returned no rows (not proof of failed or absent CI).
- Read-only GitHub REST follow-up resolved baseline CI: main `fe1eb15a` has successful CI run `35771710714` and successful deployment run `35771766910`.
- Fresh context PRJ-0003 failed at Control Tower deadline: correlation `4d6ca3b2-0ecf-49dc-9292-4cfe6926dad2`.
- Fresh SOP request-status failed at the same boundary: correlation `7f3d57fa-f2ab-4e9c-b0ca-bc134983077a`.
- Fresh Dropbox reads: PRJ-0003 snapshot and materialization head 354/PV5; active/requested null and no pending obligations. PRJ-0007 head and human views 112. PRJ-0002 human views 170. These observations do not establish transport readiness.
- SOP request `TXN-PRJ0003-RESEARCHSOP-20260924T064940Z-Q7M4`: receipt committed 352→353, execution freshly read finalized/terminal true, certificate `finalizations/3eb59fb1446fdd5af9c914bf4c399508625798bd4bb6d891445c944de4568d6a.json` freshly read and bound to request hash `b46648af5447282b170fddf8b461e62a344d7992fac3cc97a73c21cda96e63d2`, revision 353/PV5. No replay needed or issued.
- Partial Registry/fallback changes belong to E6; two red MCP transport tests belong to E5. Preserve unrelated `worker-configuration.d.ts`.
- No ancestor AGENTS.md found in the specified repository ancestry; chat project instructions remain applicable.

| Lot | Owner | State | Next action / evidence |
|---|---|---|---|
| E0 | Principal | reviewed | Both deployed versions observed; canonical baseline and SOP certificate read; 39 baseline tests pass; baseline CI/deploy verified through REST |
| E1 | Principal | reviewed | b443ba7 adds explicit verified wake evidence after B review; 7 observation tests, 17 with fallback rerun green; owner adapters being integrated |
| E2 | A | reviewed | 726073f; canonical cache-loss path, bounded observations and strict receipt bindings reviewed by C; principal final 39 tests green after kind allowlist/artifact intent consistency fixes |
| E3 | A | reviewed | 4dbe2db; principal 31 tests pass: monotone proof, shared 5-second/32-call budget, newer checkpoint resume, no repeated checkpoint write |
| E4 | B | reviewed | 2c7691a + fa0a23d + 5ef0f54; principal 8 context tests/typecheck pass; escaped text and project/revision binding regressions fixed |
| E5 | B | reviewed | 7bc0214; C reviewed MCP and operator deadline correction; principal 37 targeted tests and typecheck passed before subsequent lots |
| E6 | C | reviewed | de02d12 + fa0a23d + b443ba7 + e1a6ce6; principal 15 tests green, canonical cache loss/allocation/lost response and key rotation retain identity |
| E7 | A | reviewed | f0e229b + eb31bf5: provider Retry-After and Dropbox timeout recovery; durable scoped legacy range cursor; PV6 coalescence gaps blocked visibly; no-progress finalization backoff/stop6 with intent preserved. Independent C review non-blocking; principal 59 E7/workload/cadence/sequence targeted tests and typecheck passed |
| E8 | C | reviewed | 37d1183 quarantines proven missing file targets; 534ab4e includes actual capacity and covered-obligation checks. Principal reran 127 E8/E9 tests; provider failures remain retryable, no old cursor starvation |
| E9 | B | reviewed | 534ab4e and 564f2bc: bounded canonical reconstruction, read-only diagnostics, four-view proof and 1000 eligible-reference paged scan. Warm-head provider drift now prevents acknowledgement; principal reran 64 E9 tests; stale scan checkpoint superseded by exact externally published head without head rewrite |
| E10 | C | reviewed | 05f059e + 7ee4a1f: fresh strict admissions/domain refusals/payload collisions on four entries, frozen approval evidence survives lost acknowledgments then finalizes; real inbox capacity refusal preserves the exact request without artificial receipt; principal tests green and fault boundaries mapped |
| E11 | Principal | locally_reviewed | 2a72d4f; B reviewed scopes/capabilities/errors; two findings corrected with five RED cases then 64 targeted tests green; final integration depends on E10 and real surfaces on E14 |
| E12 | Principal + reviewers | active | Cost, alarm-only three-commit, 30-project/five-active 200-output projection and typed-shape cadence fixtures green. 704e952 qualifies a one-shot PV5→PV6 full rebuild (201 outputs), not steady-state 20 changed outputs/commit; 362ef97 adds synthetic writer-only 20-change/five-per-minute stress. Final-proof starvation (4ddf253), recovery queue mixing (ddc96d2) and outdated fixtures fixed. 6bcd205 binds fallback status to exact request digest, reviewed by B. Fifth integrated run on that code tree: 257 files/1,631 tests green. Typecheck, seven static gates, search-sync-off 4/4, both dry-runs and diff check green. Report in qualification evidence; CI on PR head still required |
| E13 | Principal | not_started | Merge/deploy only after E12 |
| E14 | Principal + C | not_started | Real client qualification, no active-user chat mutations |
| E15 | Principal + C | not_started | Canonical closure and SOP remainder |

No global completion claim until all required gates have evidence. Unknown production observations remain unknown.

First PR-head CI `36015661958` on `370b45f` failed in a finalization-slice test assertion: a shared mock and a denied 33rd `beforeHttp` attempt were counted as provider calls. The counter has been scoped to the runtime and permitted calls; 38 targeted tests, independent review and a sixth complete local suite (257 files/1,631 tests) pass. CI on the revised head remains mandatory. No merge or deploy occurred on the failed SHA.

Second PR-head CI `36017834529` on `f0cb640` failed two further prototype-wide spy assertions in `execution-guard.spec.ts` while persisted cursor and stopped-failure checks passed. The fixture now binds those observations to the specific project/candidate and Durable Object instance. Targeted 38 tests pass; independent review, full suite and new CI pending. No merge or deploy occurred on this failed SHA.

Follow-up fixture audit found other prototype/mock-wide counts in the same file. They now use exact candidate IDs and durable queues, or a journal counter bound to project/request. The targeted file stays 38/38 green. A third PR-head CI must qualify the final SHA; previous failed runs do not authorize production.

Third PR-head CI `36021122090` on `5c22a90` failed a provider-conflict fixture: the prototype-wide one-shot `readMaterializationHead` rejection was consumed before the intended project's finalization, leaving the real absent head to produce `materialization_head_mismatch`. The runtime correctly classified that HTTP 409; no production defect is demonstrated by this failure. The temporary-provider, Retry-After, network-timeout, access and conflict fixtures now inject the failure only for their own project and delegate all other reads. Independent review concurred with the fixture diagnosis. Targeted 38/38, typecheck, and a fresh full local suite (257 files/1,631 tests) pass; PR-head CI remains required. No merge or deploy occurred on the third failed SHA.

Fourth PR-head CI `36023368241` on `7eba9d7` failed six tests after 11m15s of the full suite: three heavy integration cases timed out (two at 5 seconds, one at 20); a finalization fixture's 5 ms real-clock deadline expired before its first candidate read; one qualification cost test used generic `fetch` instead of the provider-only calls it intended to count; and the 50-vs-1,000-commit provider cost test observed 32 vs 33 calls without an endpoint trace. The latter remains a real test failure of unknown origin, not a production defect disproven by local success. The fixture clock is now deterministic, only the three heavy test timeouts are expanded, provider-only qualification calls are counted, and both cost tests now expose endpoint/path histograms on failure. Six targeted files/107 tests, typecheck and a fresh full local suite (257 files/1,631 tests) pass. A new CI run must establish the cause of any remaining count difference. No merge or deploy occurred on the fourth failed SHA.

Fifth PR-head CI `36026523970` on `1f12844` reached the full suite and had one remaining assertion: the qualification fixture's shared ProjectGuard stub observed five calls rather than four while the canonical qualification proof is explicitly limited to four distinct project states. The strict count was contaminated by scheduled project work, not evidence of a per-file REVIEW scan. The fixture now requires four-to-eight guard calls, exact four audit project states, zero REVIEW file-metadata calls, at most 50 provider calls for 160 REVIEW files, and no more than eight additional provider calls versus four files; this rejects linear per-file I/O while tolerating bounded shared alarm traffic. The separate 50-vs-1,000-commit cost equality passed in this CI. Independent review found no blocker in the revised I/O gate. Targeted 53/53, typecheck, and a fresh complete local suite (257 files/1,631 tests) pass. No merge or deploy occurred on the fifth failed SHA.

E12 preparation: `8173021` rejects JSON-RPC/MCP errors carried by HTTP 200 in deployment qualification. Principal six tests and typecheck passed; C independently reviewed helper and callers. An unauthenticated public probe remains explicitly insufficient for the real-client gate.

Read-only transport recheck, before current changes deploy: both the native `mcp__project_os_control_tower` handle and connected-app `mcp__codex_apps` handle returned the SOP request's committed receipt and finalized/terminal execution on 2026-09-24. This confirms that specific historical lookup at observation time, not a new client submission or stable transport guarantee. No transaction was replayed.

Git coordination: an agent amended the shared HEAD while another agent had just committed. Read-only reflog/tree comparison showed no lost content: `fa0a23d` replaces `f2822c4` and includes the E4 escaped-text fix plus a small E6 observation correction. No reset/rebase was performed. Principal now exclusively stages and commits all reviewed changes; agents edit only their owned files.
