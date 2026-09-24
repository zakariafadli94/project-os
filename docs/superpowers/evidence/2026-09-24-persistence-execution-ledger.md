# Persistence reliability V2 — execution ledger

Authority: Founder explicitly approved V2 in this conversation on 2026-09-24.
Environment: existing local Work and worktree; principal orchestration and three Luna/high executors/reviewers. No cloud execution.

## Baseline

- Local HEAD at approval: `59a042c`; origin/main after fetch: `fe1eb15a49ee5baac855d49f5580335ac5f07ae1`.
- Production /health: same main SHA, version `d18858f2-380d-45e6-aa24-a8ff8681a324`.
- Fresh context PRJ-0003 failed at Control Tower deadline: correlation `4d6ca3b2-0ecf-49dc-9292-4cfe6926dad2`.
- Fresh SOP request-status failed at the same boundary: correlation `7f3d57fa-f2ab-4e9c-b0ca-bc134983077a`.
- Historical revision 353/finalization must not be represented as freshly verified. No business replay issued.
- Partial Registry/fallback changes belong to E6; two red MCP transport tests belong to E5. Preserve unrelated `worker-configuration.d.ts`.
- No ancestor AGENTS.md found in the specified repository ancestry; chat project instructions remain applicable.

| Lot | Owner | State | Next action / evidence |
|---|---|---|---|
| E0 | Principal | active | Refresh additional canonical reads; baseline above captures current unavailable boundary |
| E1 | Principal | active | Define pure observation contract and discriminating tests |
| E2 | A | not_started | Fast immutable receipt read |
| E3 | A | not_started | Monotone proven context baseline |
| E4 | B | not_started | UTF-8 bounded complete detail retrieval |
| E5 | B | not_started | Deadline and uncertain submission recovery |
| E6 | C | not_started | Qualify partial create/fallback recovery |
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
