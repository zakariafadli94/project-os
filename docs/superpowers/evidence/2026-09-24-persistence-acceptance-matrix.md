# Persistence V2 — acceptance evidence

This is the single reception checklist for the approved execution plan. A local test is not production or client qualification. Pending gates remain pending; `/health` is not a persistence probe.

| Gate | Local evidence | Production/client evidence | State |
|---|---|---|---|
| Known receipt readable during work | 726073f: queue occupied + local/canonical receipt regression | Pending deployment | Local reviewed |
| Receipt recoverable after cache loss | 726073f; strict project/request binding and bounded unknown | Pending | Local reviewed |
| Monotone proven context | 4dbe2db: verified checkpoints, 31 tests | Pending | Local reviewed |
| UTF-8 bounds and complete details | 2c7691a, fa0a23d, 5ef0f54: eight reconstruction/binding tests | Pending | Local reviewed |
| Unknown POST outcome preserves identity | 7bc0214: 37 tests, shared deadline including operator | Pending | Local reviewed |
| Creation/fallback outcome recovery | e1a6ce6 and preceding E6 commits: lost response/cache/key rotation | Pending | Local reviewed |
| Alarm-only finalization and bounded work | Three strict commits: direct revision 2 then 3 explicitly coalesced into 4, alarm-only to quiescence and all certificates present. f0e229b/eb31bf5: durable legacy cursor >32 calls, PV6 gap blocked, six no-progress failures visible; independent review and 59 principal targeted tests | Pending | Local reviewed |
| Executable capacity, isolation and quarantine | 37d1183 and 534ab4e: covered obligations excluded, proven missing file targets quarantined, independent projects progress; full E12 profile still pending | Pending | Local reviewed; E12 partial |
| Four-view publication proof | 534ab4e and 564f2bc: four-view bound proof; warm-head external drift fails closed, unchanged views acknowledge; 64 focused tests | Pending | Local reviewed |
| Approval and entry parity | 05f059e and 7ee4a1f: fresh strict admissions, domain refusal and payload collision across API/MCP/inbox/fallback; frozen approval storage/finalization fixture and inbox capacity retention, not production approval authority | Pending | Local reviewed |
| Honest capabilities | 2a72d4f; effective scopes, deny-default, honest manifest and actionable failures; 64 tests | Pending E13/E14 | Local reviewed |
| Integrated local regression | Fifth suite run on final code tree: 257 files/1,631 tests green. Typecheck, seven static gates, search-sync-off, both Cloudflare dry-runs and diff check green. Synthetic 20-output writer stress passes but is not an admitted business operation | No production validation yet; CI on exact PR head pending | Local qualified |
| Exact qualified SHA | Integrated E12 pending | Guard fe1eb15a; Tower cb935264 (baseline, not this delivery) | Pending |
| Canonical closure and SOP remainder | E15 pending | Pending receipts | Pending |

## Real client qualification

Do not operate in the Founder's active working conversations. Each writing probe uses its own approved PRJ-0002 qualification report, not a fictitious business decision. Record the exact content digest and request ID before submission. A successful replay proves idempotency, not a new admission.

| Surface | Conversation identity and model | Callable tools | Fresh read | New governed submission ID/digest | Receipt | Finalization and physical readback | State |
|---|---|---|---|---|---|---|---|
| Existing classic ChatGPT qualification chat | Not selected | Not observed | Pending | Not submitted | None | Pending | Pending |
| New classic ChatGPT qualification chat | Not created | Not observed | Pending | Not submitted | None | Pending | Pending |
| Local Work | `01a0d262-e6ee-7cc3-8f5a-a5df3192a37b`, “PRJ-0002 — Fiabilité complète · Work local”; model not inferred | Current tool inventory exposes get_context, get_receipt, get_request_status, submit_transaction under native and connected-app namespaces; new capabilities tool not yet present | Pending deployed probes | Not submitted | None | Pending | Pending |
| Codex | Not selected | Not observed | Pending | Not submitted | None | Pending | Pending |

Record a platform dependency separately if a client cannot mount the connector. Never mark it passed by testing only another surface. No secret belongs in this report.

Client qualification source checked on 2026-09-24: [OpenAI connection/testing guidance](https://developers.openai.com/plugins/deploy/connect-chatgpt) requires refreshing developer-mode metadata after compatible tool changes and checking actual calls. [Published metadata lifecycle](https://developers.openai.com/plugins/deploy/app-review#continuous-review-and-tool-updates) distinguishes live server fixes from tool-definition propagation. Determine which connection type is installed; do not infer that a server deployment remounts tools in existing conversations. Preserve old input contracts while additive tools are propagating.

## Explicit SOP boundary

The production qualification catalogue currently qualifies `allowed_destination` for artifact admission only (`src/rules/production-qualification.ts`). Production admission does not yet supply an approval reader (`approvals: []`). E10 can prove preservation of an already frozen `approval_id`/evidence references in the execution journal; that is not proof that all textual SOP approvals are enforceable in production. Missing readers/checks remain in the global SOP remainder and are not activated or silently declared covered by this persistence repair.

## Existing SOP transaction (not a new qualification write)

`TXN-PRJ0003-RESEARCHSOP-20260924T064940Z-Q7M4` was freshly observed committed at 353, finalized and terminal with a bound certificate. PRJ-0003's later observed snapshot/head is 354. This closes the uncertainty for that historical request only and is not evidence that the current transport is reliable. Do not replay it.
