# SOP Runtime Coverage Matrix

Status: baseline before L1–L6 implementation. Authority: `docs/superpowers/plans/2026-09-12-sop-enforcement-runtime.md`; accepted SOP baseline `DEC-SOPS001`, `DEC-SOPENF002`, `DEC-SOPBASE003`. Inputs `ANOM-ARTIFACT-LIFECYCLE-ENFORCEMENT-GAP` and `ANOM-DISTRIBUTED-ARCHIVE-ROUTING-GAP` remain unaccepted investigation inputs.

## Canonical baseline

- PRJ-0002 is active at revision 169; its generated STATE/HANDOFF declare no blocker and list `TASK-GOVRUNTIME001` as pending.
- The accepted decisions make the SOP suite normative, but they do not make prose executable or prove runtime enforcement.
- The two anomaly reports are preserved as evidence and proposals. They authorize no repair or rule activation by themselves.

## Declared mutation entries

| Entry | Normalized operations | Current gate | Required owner |
|---|---|---|---|
| API/connector | transactions, documents, artifacts | admission envelope / ProjectGuard | L3 |
| Control Tower | transactions, documents, artifacts | canonical context → Guard | L3 |
| Fallback | transactions | encrypted relay → transaction route | L3 |
| Inbox | transactions, artifact manifests | processor → Guard | L3 |
| Dropbox change feed | INPUT intake, external candidates, reconciliation | project-scoped jobs | L3/L6 |
| Admin/recovery | INPUT recovery, candidate resolution | dedicated auth + Guard | L3/L4 |
| Repair/convergence | technical effects and resume | journals and guards | L3/L4/L6 |
| Internal Guard routes | transaction, artifact, document, materialization and reconciliation | Durable Object serialization | L3/L4 |

The baseline contains 28 typed business transactions plus managed-document, working-head, artifact, mutation-candidate, INPUT lifecycle and technical reconciliation operations. No raw Dropbox CRUD route is a supported final-state mutation entry; an external write must be observed and classified.

## Guarantee coverage

| Guarantee | Baseline | Required evidence before activation |
|---|---|---|
| G01 common admission | Partial | Same deny through every declared entry |
| G02 server resolution | Missing | Server ruleset plus no client subset or bypass |
| G03 qualified activation | Missing | Lifecycle, check, coverage, contradiction and drift qualification |
| G04 cumulative scopes | Missing | Global inheritance and project isolation tests |
| G05 exact rule evidence | Partial | Exact versions, verdict and evidence in durable intent |
| G06 version-bound approval | Partial | Immutable version/package approval test |
| G07 committed versus finalized | Partial | Postcheck-backed finalization state |
| G08 idempotent resume | Partial | Boundary interruption and obsolete-target tests |
| G09 external drift | Partial | Expected/unexpected move and disappearance tests |
| G10 project isolation | Partial | Cross-project permit, rule and resume tests |
| G11 bounded exceptions | Missing | Exact scope plus expiry/revocation tests |
| G12 no admin bypass | Partial | Recovery/repair rejection parity tests |
| G13 data-only extension | Missing | New global/local rule using current check without route/service edit |
| G14 visible gaps | Partial | Unequipped/qualitative rules visibly inactive or unavailable |

## Mandatory SOP controls and gaps

| Rule family | Source and trigger | Existing control | Gap and implementation owner |
|---|---|---|---|
| Project identity and context | Project-management SOP; every project-bound operation | Project ID binding, registry resolution and referral isolation | No shared actor/project/ruleset evidence across entries — L2/L3 |
| Durable truth and decisions | Project OS and knowledge/decision SOPs; accepted facts | Typed transactions, decision accept/supersede, events and receipts | No exact actor/rule evidence or common finality — L3/L4 |
| Project/task/phase lifecycle | Project OS SOP; lifecycle mutations | Legal project/task/phase transitions and unique current phase | Phase completion currently permits unfinished attached tasks — L5 |
| Deliverable lifecycle | Deliverables SOP and DEC-SOPENF002 | Canonical planned → review → accepted lifecycle | Physical package/version approval and postcheck absent — L5 |
| Document identity and portability | Handoff/portability SOP and managed-document contract | Managed identity, expected head, verified archive for working heads | No frozen package manifest or unique navigation head by zone — L5 |
| INPUT intake/recovery | INPUT lifecycle design and Project OS SOP | Resumable snapshot/reference/removal postconditions; explicit recovery | No shared ruleset evidence or generalized drift status — L3/L4/L6 |
| Artifact lifecycle anomaly | Unaccepted PRJ-0002 INPUT; document/package changes | Partial working-head and candidate controls | Workstream/package/head-zone semantics and acceptance authority remain unspecified — L5, then governance acceptance |
| Distributed archive anomaly | Unaccepted PRJ-0002 INPUT; archive destination | Configurable archive prefix and working archive behavior | Unique `ARCHIVES/` policy, collision/migration/retention parameters unspecified — L2/L5/L6, then governance acceptance |

## Ambiguities that block activation, not implementation

- The anomaly reports do not define an executable `workstream`, frozen package-manifest schema, stale/orphan criteria, Founder-signature mechanism, archive collision policy or retention policy.
- A qualitative obligation without objective criteria requires explicit approval or remains `accepted_unenforced`; the runtime must not invent a deny condition.
- The six-identical-failure rule requires a stable failure fingerprint and an observable progress marker; the existing generic retry count is insufficient.
- Projects without a canonical `ARCHIVES/` root need an explicit migration policy before an archive-routing rule can be active.

## Trace evidence for L7

- Transaction operations and transitions: `src/domain/transaction.ts`, `src/domain/transitions.ts`.
- Public entries: `src/index-neutral.ts`, `src/index-mutation-gate.ts`, `src/control-tower/mcp.ts`.
- Guard admission and routing: `src/durable/project-guard-neutral.ts`, `src/durable/project-guard-mutation-gate.ts`.
- Document/artifact contracts: `src/domain/managed-document-request.ts`, `src/domain/working-head-request.ts`, `src/domain/artifact-write.ts`.
- INPUT recovery and observation: `src/documents/input-intake-service.ts`, `src/documents/input-recovery.ts`, `src/durable/dropbox-change-guard.ts`.

This file is a baseline coverage artifact, not a declaration that the missing controls are active.

## Detailed G01–G14 control matrix

Entry abbreviations: API = public connector/API; CT = Control Tower; FB = encrypted fallback; IN = inbox; CF = Dropbox change feed; AD = admin/recovery; RP = repair/convergence; GI = internal Guard routes. Coverage is E (equipped for the stated surface), P (partial) or N (not equipped). A partial mark never means a runtime ruleset is enforced.

| Rule/source | Scope and trigger | Expected condition | Current control and exact reference | Entry coverage baseline | Postcheck/external gap | Required action and acceptance scenario | Owner |
|---|---|---|---|---|---|---|---|
| G01, plan lines 22–25 | Every supported durable mutation/effect | Same policy produces same verdict everywhere | Admission envelope and family-specific Guard checks, `src/index-neutral.ts:142-238`, `src/durable/project-guard-neutral.ts:158-264,338-585` | API P; CT P; FB P; IN P; CF P; AD P; RP P; GI P | No common verdict or proof across derived effects | Normalize all entries; inject one violation and prove identical refusal plus zero effects | L3 |
| G02, plan line 26 | Every admission | Server resolves complete effective ruleset | Signed MutationContext exists, `src/durable/project-guard-neutral.ts:693-734` | API N; CT N; FB N; IN N; CF N; AD N; RP N; GI N | No global/local rule revision | Resolve in RegistryGuard/ProjectGuard; reject client subset and stale cross-request permit | L1–L3 |
| G03, plan line 27 | Rule lifecycle | Activation only after complete qualification | No rule governance model | API N; CT N; FB N; IN N; CF N; AD N; RP N; GI N | No activation evidence or drift inventory | Add lifecycle and qualification; missing check/coverage/negative test must refuse activation | L1/L2/L7 |
| G04, plan line 28 | Global plus project rule resolution | Local requirements add but never weaken global | No versioned rule resolver | All entries N | No project-rule isolation evidence | Resolve cumulative sets; prove global inheritance, local isolation and override rejection | L1/L2 |
| G05, plan line 29 | Every admitted intent | Persist exact rule versions/verdict/evidence | Transactions retain revision/receipt; artifact intent retains route snapshot, `src/domain/mutation-gate.ts:35-89` | API P; CT P; FB P; IN P; CF P; AD P; RP P; GI P | No actor/request hash/global-local versions | Persist admission evidence; activate a rule between admission/replay and prove original set is retained | L3/L4 |
| G06, plan line 30 | Approval, promotion and publish | Approval targets immutable resource version | Expected document/head versions and verified working archive, `src/domain/managed-document-request.ts:25-85`, `src/documents/working-head-service.ts:223-280` | API P; CT P; FB NA; IN P; CF P; AD P; RP P; GI P | No frozen package approval | Approve v1, revise v2, prove v1 approval cannot publish v2 | L4/L5 |
| G07, plan line 31 | All multi-effect operations | committed intent distinct from verified finalization | Transaction committed receipt; INPUT COMPLETE postchecks, `src/durable/project-guard-neutral.ts:290-323`, `src/documents/input-intake-service.ts:217-267` | All entries P | Artifact/document families lack shared final states | Interrupt after commit and each effect; resume to exactly one finalized result | L4 |
| G08, plan line 32 | Retry/resume/obsolescence | No duplicate/widened effect; stop sixth identical no-progress failure | Request idempotency, INPUT replay and convergence retry, `src/convergence/engine.ts:1016-1108` | All entries P | No common progress/fingerprint contract | Fault each boundary; prove no duplicates, obsolete close, six-stop and unrelated progress | L4 |
| G09, plan line 33 | Observed governed Dropbox change | Drift removes conformity and is classified | Durable change jobs/candidates, `src/durable/dropbox-change-guard.ts:86-123`, `src/documents/change-coordinator.ts:105-191` | API P; CT P; FB P; IN P; CF P; AD P; RP P; GI P | No active-rule reevaluation or general conformity finding | Delete/move/edit governed resource; persist conflict and never restore obsolete target | L6 |
| G10, plan line 34 | All contexts, permits, evidence and repairs | Project A data cannot authorize or block B | Guard binding and candidate same-project validation, `src/durable/project-guard-neutral.ts:235-244`, `src/domain/mutation-candidate-resolution.ts:34-59` | API P; CT P; FB P; IN P; CF P; AD P; RP P; GI E | Future rule/permit isolation untested | Reuse A permit/exception in B: deny; prove an independent B operation continues | L2–L4 |
| G11, plan line 35 | Exception grant/use/revoke | Exact rule/version/project/resources/operations, expiry and authority | No exception model | All entries N | No expiry/revocation evidence | Test valid exact exception and deny mismatched, expired, revoked or unbounded variants | L1/L2 |
| G12, plan line 36 | Admin, candidate, recovery and repair | Same rule gate; declared repair drift/resources | Dedicated recovery auth and candidate effect admission, `src/index-mutation-gate.ts:151-188` | API P; CT P; FB P; IN P; CF P; AD P; RP P; GI P | No shared ruleset or typed repair evidence | Send same violation by ordinary/admin/repair paths and prove same deny/no write | L3/L4 |
| G13, plan line 37 | New rule using registered check | Data-only extension, no ingress/service change | No catalogue or dynamic rule data | All entries N | Impossible to qualify today | Add one global and one local rule using an existing check; routes remain untouched | L2/L8 |
| G14, plan line 38 | Every proposed/accepted rule | Missing coverage visible; never silently active | Static audit only | All entries N at runtime | Accepted SOP indistinguishable from active control | Unknown/qualitative rule remains accepted_unenforced or unavailable with precise reason | L1/L2/L7/L8 |

## SOP-specific trace rows

| Rule/source | Trigger and condition | Current control | Missing coverage | Reception |
|---|---|---|---|---|
| Project identity/context — `docs/project-os/sop/01-PROJECT-MANAGEMENT-SOP.md:16-34`, `docs/project-os-sop.md:39-58` | Every project-bound operation resolves ID/name/alias without implicit rebind | Project ID binding and referral isolation | Actor/project/ruleset evidence is not common to all entries | Cross-project permit/referral cannot contaminate the target project |
| Durable facts/decisions — `docs/project-os-sop.md:144-203`, `docs/project-os/sop/02-KNOWLEDGE-DECISIONS-SOP.md:20-126` | Recommendation/input is not an accepted decision | `decision.accept/supersede`, event history, `src/domain/transitions.ts:248-278` | Exact acceptance actor and rule evidence absent | Unapproved decision returns approval_required; accepted mutation has receipt |
| Phase/dependent tasks — `docs/project-os-sop.md:331-348` | Phase completion requires coherent dependent work | Current/unique phase checks, `src/domain/transitions.ts:193-335` | Active child tasks do not prevent phase completion | Active attached task blocks completion; completed children do not |
| Deliverables — `docs/project-os/sop/03-DELIVERABLES-SOP.md:39-136`, `DEC-SOPENF002` | Review/accept/publish exact version | Canonical lifecycle, `src/domain/transitions.ts:388-497` | No package manifest or physical postcheck | Exact accepted package publishes; later external edit creates drift |
| Document portability — `docs/project-os/sop/04-HANDOFF-PORTABILITY-SOP.md:9-132`, `docs/managed-documents.md:199-285` | Unique current working/review head, archived predecessor, valid navigation | Working CAS/archive verification | No package identity or unique current navigation head per zone | Concurrent replace loses cleanly; predecessor and links verify before finalized |
| INPUT lifecycle — `docs/superpowers/specs/2026-08-31-input-lifecycle-triggered-ingestion-design.md:82-175`, `docs/project-os-sop.md:537-545` | Snapshot/reference verified before source removal; recovery explicit | `src/documents/input-intake-service.ts:217-267`, `src/documents/input-recovery.ts:39-76` | No generic rule verdict or conformity state | Crash/replay removes source once; divergent target conflicts and preserves source |
| Artifact lifecycle proposal — anomaly INPUT modified 2026-09-12T11:36:30Z | Proposed head/package/archive/index invariants | Partial working-head/candidate controls | Workstream, manifest, stale/orphan and approval authority unspecified | Do not activate; qualification waits for accepted parameters |
| Archive-root proposal — anomaly INPUT modified 2026-09-12T11:47:19Z | Proposed unique project `ARCHIVES/` root | Configurable prefix, `src/domain/transaction.ts:90-102` | Collision, retention, migration and restore provenance unspecified | Do not activate; future policy must reject local ARCHIVE and verify moves |

## Receipt and physical postcondition scenarios

| Scenario | Entries | Required receipt/verdict | Required postcondition |
|---|---|---|---|
| Same policy violation | API, CT, FB, IN, CF, AD, RP, GI | Same rule/version/code, rejected | No canonical or provider effect |
| Exact replay | API, CT, FB, IN, GI | Original request hash/ruleset/verdict | No duplicate event, file, move, version or receipt |
| Interrupted multi-effect work | API, IN, CF, AD, RP, GI | committed → finalizing → one terminal result | Every declared file/link/manifest/index verified |
| Six identical failures | IN, CF, RP, GI | Visible failed incident after sixth | No seventh identical no-progress attempt; independent work proceeds |
| Unexpected provider drift | CF, AD, RP, GI | conflict/nonconforming finding | External evidence preserved; no unsupported repair |
| Bounded exception | Every writing entry supporting its operation | Exact live exception reference | Expired/revoked/mismatched attempt denied |
| Rule activation | Governance GI plus all declared entry proofs | committed only after qualification | Positive/negative coverage and drift inventory linked |

## Ownership and integration boundaries

| Lot | Owned surfaces | Dependency and overlap rule | Completion evidence |
|---|---|---|---|
| L1 | ProjectState, transaction discriminants, RegistryGuard/ProjectGuard governance persistence | Freeze stored contracts before L2/L3 | Lifecycle, immutability, authority and compatibility tests |
| L2 | Check catalogue, resolver and evaluator | Consumes L1; does not wire routes or implement packages | Inheritance, isolation, conflict, unknown-check and unavailable tests |
| L3 | Admission transport, public/control/fallback/inbox/admin/internal routes | Consumes L2; freezes context/evidence contract for L4 | Entry-parity matrix |
| L4 | Receipts, journals, finalization, resume, typed repair | Consumes L3; shares only explicit postcheck contract with L5/L6 | Boundary fault, replay, obsolete and retry tests |
| L5 | Managed documents, packages, navigation, phase completion | Consumes L2–L4; does not own external scan scheduling | Manifest/archive/link/phase tests |
| L6 | Change guard/coordinator and existing alarm path | Consumes L2/L4/L5; creates no automation | Expected/unexpected drift and isolation tests |
| L7 | Read-only adversarial review | Runs after L1–L6; performs no fixes | G01–G14 evidence map with no open blocking finding |
