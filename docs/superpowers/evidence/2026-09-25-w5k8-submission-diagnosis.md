# PRJ-0003 W5K8 — recorded decision, transport diagnosis

## Scope

Exact original transaction `TXN-PRJ0003-SUJET1-ACCEPT-20260925-W5K8`, operation `decision.accept`, base revision358. Source bytes supplied by PRJ3 owner in local `CANDIDATS/PRJ0003-CONCEPTION/PUBLICATION-20260925.json`; no content changed and no new request identity generated. Founder authorization remains the original decision approval.

## Observations

- Native read-only status at2026-09-25T13:40:37.045Z: `not_received`, no receipt, no execution, no durable intent; correlation `6af299f5-ce36-49aa-a1c9-f22746c0b7e7`.
- Fresh canonical context revision358 confirmed; signed token not retained in this report.
- Exactly one diagnostic submission through the normal native ControlTower tool, which obtains fresh context server-side. Correlation `b52ca958-3eb3-41d6-9114-c4eedbbf2b70`.
- Tower deployed version `bff00ccb-153d-4266-895f-9cfe634ca8c3`: returns `unknown / PROJECT_OS_SUBMISSION_UNAVAILABLE` at10000ms after POST started.
- Guard deployed version `8196974f-5394-45b6-aa0b-41497574181e`: context completed1550ms; transaction acquired immediately (`queue_ms:0`). The event is reported canceled after18484ms, but the correlated guard-finished log later reports200 at29799ms. This proves response waiting expired before the operation completed; it does not prove earlier failed attempts had this same cause.
- Native receipt subsequently confirmed `committed`,358→359,`EVT-000359`. Persisted receipt `committed_at` is2026-09-25T11:09:07.543Z (the original request timestamp), not the time of this diagnostic observation.
- At13:47:47 status was `finalizing / MATERIALIZATION_PENDING`; no finalization claim.
- Physical convergence progress modified13:49:56: observed canonical359, active359/PV6, only remaining obligation `human_handoff`, `human_slice_pending`, failure_count0, second attempt. Official materialization head still358 at that observation.

## Consequences

Never resubmit this committed transaction. PRJ3 owner notified and independently confirmed the receipt. Finalization must be verified separately. The two published documents remain finalized; their publication does not imply this transaction's finalization.

The transport's fixed10-second response window can produce ambiguous user feedback for legitimate operations. A durable fix must preserve bounded execution and exact idempotency, and must not convert timeout into a false rejection or bypass admission. Investigation of a bounded server continuation is separate from zone-index repair.

## Closure and remaining work

- At13:52:28.783Z native status confirmed `finalized`, `terminal:true`, recovery complete/action none. Certificate: `/PROJECT_OS/.project-os/projects/PRJ-0003/convergence/executions/d983b3e8966bc6e7457d07a419581d42e8ef0a7210f283cef01cf4e3870b9612/finalizations/4cadce860c2731292a512c8fc7739240bc78b0390ede4d980e704ee2882cb8aa.json`. Correlation `0f24c893-3ad4-458c-a1e6-1ce926290d43`. Owner informed. Physical readback remains a separate verification.
- Subsequent live Dropbox readback confirmed head359/PV6, completed13:51:15.955Z, result root311092f8b77e74ca0e60af1f80144adc6003f5dd07d380928b688e378e8573d8; PROJECT.md, PLAN.md, STATE.md and HANDOFF.md each declare359. The current W5K8 recording/finalization defect is closed; transport cutoff remains a separate code change.
- Transport correction qualification and deployment.
- Three zone indexes: engine independently reviewed and accepted locally; runtime integration in progress. No production repair claimed.
