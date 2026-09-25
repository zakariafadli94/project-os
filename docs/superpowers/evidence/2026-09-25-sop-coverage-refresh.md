# SOP coverage refresh — 2026-09-25

This is a read-only reception assessment, not a new rule activation. The accepted SOP baseline is `DEC-SOPS001`, `DEC-SOPENF002`, and `DEC-SOPBASE003`; the global execution work is in `2026-09-12-sop-enforcement-runtime.md` and `2026-09-20-productivity-first-sop-completion.md`. The older September matrix predates runtime implementation and must not be reused as a current production verdict.

The rule-governance engine was present in both the previously observed Control Tower SHA `f8c26952cd37f2abfc4a3463009b13e1d278dbe5` and the newer Guard releases; this is not an assertion that both Workers had the same SHA at the time of this read. A read-only Dropbox-synced `RULE_GOVERNANCE.json` snapshot inspected on 2026-09-25 has revision 5 and one active global rule, `RULE-GLOBAL-REVIEW-DESTINATION` v2 (`artifact.write` / `allowed_destination`), with no exception; this snapshot is **not** a confirmed fresh RegistryGuard head. `GET /v1/rule-governance` can provide that head but requires the dedicated `RULE_GOVERNANCE_TOKEN`; an unauthenticated production call correctly returned HTTP 403, and ordinary Control Tower tools do not expose the read. No credential was sought or copied. PRJ-0002's Dropbox-synced state at revision 169 had an empty local rule set; fresh Control Tower context is revision 170 but does not expose the local rule list. Fixtures test broader capabilities, but neither code presence nor a single snapshot rule proves all accepted SOPs are enforced in production.

| Guarantee | State | Evidence and remaining gap |
|---|---|---|
| G01 common admission | partial | Shared evaluator and entry-parity fixtures exist; the same production refusal has not been observed across API, Control Tower, fallback, inbox, administrative/repair/convergence routes, Guard internal routes, and any change-feed entry that admits a governed mutation. Read-only change observation is assessed under G09 instead. |
| G02 server-side rule selection | partial | Signed permits and subset/stale-rule tests exist; fresh production ruleset/version evidence across those same mutation entries is absent. |
| G03 qualified activation | partial | Qualification tests and one active global destination rule exist; the other accepted SOP obligations have not all been equipped and activated. |
| G04 global/local accumulation | partial | Resolver inheritance/isolation is tested; no current production project has demonstrated concurrent active global and local rules. |
| G05 exact rule versions in admission proof | partial | Version/digest fields are implemented; a live cross-operation receipt audit of exact versions and verdicts remains. |
| G06 version-bound approval | partial | Version/CAS and approval-continuity fixtures exist; production evaluator currently supplies no approval reader (`approvals: []`). |
| G07 committed versus finalized | partial | Real PRJ-0002 documents and PRJ-0007 transaction have distinct committed receipts and finalized certificates; not all SOP postconditions/families have production proof. |
| G08 idempotent recovery | partial | Fault-boundary fixtures and a real rev121 automatic finalization exist; this is not every operation and entry. |
| G09 external drift invalidation | partial | Dropbox change coordinator and expected/unexpected-change tests exist; no fresh governed-object production drift proof was obtained. |
| G10 project isolation | partial | Code tests and independent PRJ-0003/0007 production progress exist; cross-project permit rejection under simultaneous work remains unproven in production. |
| G11 bounded exceptions | partial | Model and expiry/revoke fixtures exist; canonical production exceptions are empty, so no live use is qualified. |
| G12 no administrative bypass | partial | Repair/admin admission code and tests exist; a matching live ordinary/admin/repair refusal has not been demonstrated. |
| G13 data-only rule extension | partial | Existing `allowed_destination` check is qualified without route edits; extension using another check is not production-qualified. |
| G14 visible coverage gaps | partial | Gaps/deferred outcomes are represented; the accepted SOP inventory versus active rules has not yet been refreshed canonically. |

No G01–G14 guarantee is proven in its full accepted scope. This does **not** mean the runtime engine is absent: all are `partial`, while connector mounting in an individual old/Codex chat is an `external_dependency` of E14. An unavailable proof is never counted as conformance.

## Remaining global work

| Lot | Current state | Next exact operation |
|---|---|---|
| L0 inventory | partial/stale | Refresh accepted global and project SOP sources separately from recommendations; map every mandatory obligation to check, entry and result proof. |
| L1–L2 model, catalogue, qualification | implemented; one production rule active | Read fresh global/local rule states and authority transitions; leave unqualified checks `accepted_unenforced`. |
| L3 admission | fixtures pass; production coverage partial | Observe one identical safe refusal across all supported API/Control Tower/fallback/inbox/admin/repair/internal mutation entries, preserving request identity and no mutation; classify the change-feed path by whether it admits a mutation or only observes drift. |
| L4 proofs/recovery | implemented; selected real receipts/certificates | Map each operation family to its admission/postcondition evidence without replay. |
| L5 document/package/phase controls | partial | Inventory identity/version/hash and approved disposition for historical PRJ-0003 archives before any typed movement; qualify package/binary capability separately. |
| L6 external drift | partial | Qualify a real observed governed-resource change and resulting conformance withdrawal, without fabricating production drift. |
| L7 independent review | prior reviews exist | Review refreshed source-to-control matrix and resolve blocking findings. |
| L8 integration | deployed SHA known | Bind each G guarantee to local test and production receipt/observation evidence. |
| L9 activation/repairs | one active rule; historical repairs open | Refresh PRJ-0002/0003/0007/0008 and use only approved typed operations for actual repairs. |
| L10 final qualification | open | Require E14 surfaces and E15 canonical report, receipts, finalization and physical readback before certification. |

This persistence delivery does not silently authorize archive cleanup, package/binary schema expansion, REVIEW activation, or business phase closure. Those remain in the accepted global SOP programme and require their own gates.

Fresh PRJ-0002 context at revision 170 retains existing pending tasks `TASK-RECTIFYBASE001`, `TASK-GOVRUNTIME001` and `TASK-RECTIFYPROOF001`; do not create duplicates or mark them complete from this runtime delivery. Existing two convergence incidents are historical: their obligations are verified, active/requested targets and last error are null, and they are not current business blockers. Typed task operations allow status transitions, not arbitrary journal updates; the incident journal is not a task mutation route. An authorized fresh governance read and a source-to-control inventory are the next evidence needed for the global SOP programme.
