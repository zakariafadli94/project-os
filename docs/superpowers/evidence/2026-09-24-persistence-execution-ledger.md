# Persistence reliability V2 — execution ledger

Authority: Founder explicitly approved V2 in this conversation on 2026-09-24.
Environment: existing local Work and worktree; principal orchestration and three Luna/high executors/reviewers. No cloud execution.

## Baseline

- Local HEAD at approval: `59a042c`; origin/main after fetch: `fe1eb15a49ee5baac855d49f5580335ac5f07ae1`.
- Production /health: same main SHA, version `d18858f2-380d-45e6-aa24-a8ff8681a324`.
- Control Tower deployments/version read through Wrangler: 100% version `fac275aa-7a0c-4209-a3b5-2315d59b97fb`, tag `git-cb9352645e63fd448727bd4771d01c47642ef2da`, created 2026-09-21T16:20:30.452Z. Guard and Tower therefore have distinct deployed revisions. GitHub PR-run lookup for Guard main SHA returned no rows (not proof of failed or absent CI).
- Fresh context PRJ-0003 failed at Control Tower deadline: correlation `4d6ca3b2-0ecf-49dc-9292-4cfe6926dad2`.
- Fresh SOP request-status failed at the same boundary: correlation `7f3d57fa-f2ab-4e9c-b0ca-bc134983077a`.
- Fresh Dropbox reads: PRJ-0003 snapshot and materialization head 354/PV5; active/requested null and no pending obligations. PRJ-0007 head and human views 112. PRJ-0002 human views 170. These observations do not establish transport readiness.
- SOP request `TXN-PRJ0003-RESEARCHSOP-20260924T064940Z-Q7M4`: receipt committed 352→353, execution freshly read finalized/terminal true, certificate `finalizations/3eb59fb1446fdd5af9c914bf4c399508625798bd4bb6d891445c944de4568d6a.json` freshly read and bound to request hash `b46648af5447282b170fddf8b461e62a344d7992fac3cc97a73c21cda96e63d2`, revision 353/PV5. No replay needed or issued.
- Partial Registry/fallback changes belong to E6; two red MCP transport tests belong to E5. Preserve unrelated `worker-configuration.d.ts`.
- No ancestor AGENTS.md found in the specified repository ancestry; chat project instructions remain applicable.

| Lot | Owner | State | Next action / evidence |
|---|---|---|---|
| E0 | Principal | implemented | Both deployed versions observed; canonical baseline and SOP certificate read; 39 baseline tests pass; CI status unavailable from the two connector lookups, not assumed green |
| E1 | Principal | implemented | 2c81ac3 plus blocked-code refinement; pure observation contract, six tests green; owner adapters and integrated typecheck pending |
| E2 | A | active | 36a2a5e local receipt fast path; 28 targeted tests green; canonical cache-loss path and additive observations still pending review |
| E3 | A | active | Monotone proven context baseline; 5-second/32-call shared budget |
| E4 | B | active | 2c7691a independently rerun: 6 context tests + typecheck pass; JSON-escaped text boundary refinement requested before review closure |
| E5 | B | not_started | Deadline and uncertain submission recovery |
| E6 | C | active | Qualify create/fallback recovery; canonical business digest must exclude renewable admission envelope |
| E7 | A | not_started | Budgets/checkpoints/wakes; candidate-count fix 59a042c exists |
| E8 | C | not_started | Executable capacity and evidence-based obsolete closure |
| E9 | B | not_started | Four-view publication proof |
| E10 | C | not_started | Entry/approval continuity tests |
| E11 | Principal | not_started | Capabilities and real client contract |
| E12 | Principal + reviewers | not_started | Integrated qualification on fixed SHA |
| E13 | Principal | not_started | Merge/deploy only after E12 |
| E14 | Principal + C | not_started | Real client qualification, no active-user chat mutations |
| E15 | Principal + C | not_started | Canonical closure and SOP remainder |

No global completion claim until all required gates have evidence. Unknown production observations remain unknown.
