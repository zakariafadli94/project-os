# Project OS — End-to-End Persistence Reliability

## Goal

Make every supported Project OS operation recoverable and observable from admission through committed receipt, materialization, and finalization. A technical interruption must not lose accepted work, create duplicates, leave a result permanently ambiguous, or require the founder to restart review. Dropbox remains canonical and all durable business mutations remain typed and receipted.

## Global constraints

- Work only in the existing `fix/permanent-convergence-rectification` worktree.
- Preserve unrelated `worker-configuration.d.ts`.
- No new service, database, subscription, secret, worktree, or production test project.
- No direct canonical Dropbox writes and no replay of already committed business effects.
- API, Control Tower, connector, inbox, fallback, and admin paths share the same admission and recovery guarantees.
- Cache/read models are accelerators, monotone, provenance-checked, and reconstructible.
- Human alerts remain optional and non-blocking.
- Use tests that reproduce real boundary failures; avoid audit/test bloat.
- Production closure requires real classic ChatGPT, Work, and Codex qualification. A visible plugin is not proof that tools are callable.
- Preserve and report the unfinished global SOP program; runtime repair does not imply SOP completion.

## Task 1 — Establish the measured baseline and contract matrix

Record local/production SHA, current Project OS state, route contracts, latency boundaries, payload sizes, open plans, and the plan/code/deployed/proven matrix. Define public states for absent, unknown, received, committed, finalizing, finalized, conflict, and failed. Add correlation fields and a diagnostic test proving a timeout identifies the failing boundary without payloads or secrets.

**Gate:** every observed blocker has an owner, route, evidence, and acceptance scenario; the 5s versus 10s deadline behavior is explained.

## Task 2 — Split fast receipt lookup from deep request diagnostics

Write failing tests showing a locally known receipt remains readable while execution/provider reads stall and that local absence returns unknown when remote proof is unavailable. Route `project_os_get_receipt` to the dedicated receipt path; keep recovery/finalization diagnostics in request status. Ensure reads do not trigger recovery or serialize behind long mutations.

**Gate:** committed receipt lookup is bounded and independent of materialization; no false `not_found`.

## Task 3 — Build a monotone fresh-context read path

Write concurrency and cache-loss tests. Start from provenance-checked local committed state and verify only the immutable suffix; reconstruct fully only when cache is absent/invalid. Prevent an older asynchronous read from overwriting newer local state. Never sign partial or stale state.

**Gate:** repeated unchanged reads avoid full snapshot download, concurrent commits cannot cause revision rollback, and incomplete freshness fails closed.

## Task 4 — Bound and paginate chat-facing context

Write tests for a 200 KiB phase and more than 50 active tasks. Construct a compact server response with explicit totals, truncation/pagination metadata, stable cursors, and details-on-demand. Resolve the `current_phase: null` mapping defect without changing business state.

**Gate:** each response respects the measured budget, omissions are explicit, and all items remain retrievable.

## Task 5 — Make submissions recoverable across all entry paths

Write interruption tests before durable receipt, after durable intent, after canonical commit, and before response delivery. Apply one correlation/deadline/idempotency contract to API, Control Tower, connector, inbox, fallback, and admin routes. Exact ID+payload replay returns the original state; different payload is rejected; capacity/timeouts never create a second inbox request.

**Gate:** each interruption yields at most one commit and a status that can resolve without founder intervention.

## Task 6 — Bound materialization finalization by examined work

Write a red test with many absent/already-terminal candidates. Count every examined candidate, not only certificates created; enforce time/provider-call budgets, persist cursor, and schedule continuation before returning. Reuse already verified lineage and coalescence evidence.

**Gate:** a large historical tail cannot monopolize ProjectGuard and covered transactions finalize automatically.

## Task 7 — Correct capacity, obligations, invalid document jobs, and project isolation

Write tests for covered obsolete obligations, non-covered obligations, directory-as-file jobs, repeated identical failures, and two independent projects. Capacity counts executable work only. Quarantine invalid jobs with history preserved; retain bounded backoff and six-identical-failure stop.

**Gate:** terminal/non-executable debt releases capacity, no infinite retry occurs, and one project cannot block another.

## Task 8 — Enforce coherent current views and scalable hot paths

Verify `PROJECT.md`, `PLAN.md`, `STATE.md`, and `HANDOFF.md` as one publication group. Measure state/journal/provider-call growth and remove historical scans from frequent paths. Add checkpoints or indexes only where measured evidence requires them.

**Gate:** a published head proves four matching views and ordinary cost is governed mainly by recent changes.

## Task 9 — Qualify failure, concurrency, load, and compatibility

Run targeted RED→GREEN tests, typecheck, the required full suite, persistence/security gates, and Cloudflare dry-run build. Include rollback compatibility, cache rebuild, provider outage, mid-slice restart, concurrent commit/read, large context, terminal history, and multiple projects. Conduct independent cross-review.

**Gate:** zero blocking finding, zero failing required check, no secret/dependency/direct canonical write introduced.

## Task 10 — Integrate and deploy the exact qualified SHA

Create coherent separable commits, review the complete diff, integrate, and deploy exactly the qualified `main` SHA. Verify health, deployment identity, functional readiness, and rollback compatibility. Do not treat `/health` alone as readiness.

**Gate:** deployed identity matches qualified code and useful routes pass their functional probes.

## Task 11 — Recover existing technical debt without replaying business work

For affected projects, find existing receipts first, resume only technical materialization/finalization, verify certificates and views, and leave unrelated projects available. Inform affected tasks only with verified actions. Never create compensating business transactions for technical recovery.

**Gate:** debts are finalized or have a proven external blocker; no committed operation is replayed.

## Task 12 — Qualify real conversations and persist closure

Using separate authorized qualification conversations, test an existing and new classic ChatGPT conversation, local Work, and Codex: callable tools, fresh read, authorized real submission when one exists, receipt, finalization, and result reread. Never invent a production business mutation. Persist the final evidence and incident closure through governed transactions and record the exact remaining SOP lots.

**Gate:** classic chats do not require switching chats or direct Dropbox deposits; closure is recoverable from Project OS without chat history. If no real pending mutation exists, the write portion remains explicitly unproven rather than fabricated.

## Final acceptance

- Context and receipt reads remain useful under representative load.
- Interrupted submissions resolve without duplication.
- Finalization resumes without manual status reads.
- No revision rollback or silent context truncation.
- Current views agree with the published head.
- Capacity is released and projects remain isolated.
- Production SHA and evidence are identified.
- Real conversation surfaces pass qualification.
- Closure receipts are committed and finalization is verified.
- Remaining SOP work is explicit and is not falsely declared complete.
