# IMP-INPUTLIFECYCLE001 — Trigger-first INPUTS lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `INPUTS/` a trustworthy trigger-driven active inbox whose ingestion is durable, replayable to a verified terminal postcondition, and safe across provider/webhook/cursor crashes without relying on periodic INPUTS scans.

**Architecture:** Keep ProjectGuard as the per-project serialization boundary. Add a narrow durable Dropbox change-signal guard for webhook handoff, durable per-change jobs plus cursor state inside each ProjectGuard, and a portable machine-layer intake ledger under each project's Managed Documents state. Intake converges source evidence → governed reference → verified source cleanup. Verified cross-project referrals use governed referral provenance; unverified referral-looking files fall back to `REFERENCES/UNCLASSIFIED/`. Historical cleanup is an explicit admin recovery operation using the same intake engine.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects/SQLite, Dropbox API through the existing provider-neutral persistence runtime, Vitest with `@cloudflare/vitest-pool-workers`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-31-input-lifecycle-triggered-ingestion-design.md` at founder-validated commit `23538875d2ac3ca42277eff04bfe81565b59a771`.

## Global Constraints

- Execute implementation on a new branch `imp/inputlifecycle001-trigger-first` created from the final approved plan commit, not on `main` and not directly on the design branch.
- Strict TDD: establish failing behavior before production implementation for every semantic change.
- Preserve ProjectGuard as the per-project correctness/serialization boundary; do not introduce a broad event bus.
- Preserve the provider-neutral Core boundary. Dropbox-specific webhook/cursor/API behavior stays in provider/integration code.
- Never trust user-authored Markdown/frontmatter alone as cross-project referral provenance.
- Source ingestion is technical document state and must not increment canonical project revision by itself.
- No periodic or scheduled scan of project `INPUTS/` may be added as nominal correctness machinery.
- Unknown/divergent provider realities fail closed; never overwrite or delete newer human/provider content to force convergence.
- Preserve existing reference `document_id`, version, provider-binding and fingerprint semantics unless a test proves a necessary incompatibility.
- `TASK-IMPINPUTLIFECYCLE001` remains `pending` until this plan, including the safety amendment below, is explicitly approved for execution.

## Safety Amendment Gate — Empty-directory cleanup

The validated spec currently requires automatically removing now-empty ancestor directories below `INPUTS/`. During implementation planning, the current Dropbox capability contract was inspected and a race was found: Dropbox `delete_v2` recursively deletes a folder and there is no atomic provider primitive meaning “delete this directory only if it is still empty.” A list-then-delete sequence could delete a file a human creates between those two calls.

The implementation must therefore amend the spec before production work begins:

- file-level intake cleanup remains mandatory;
- empty-directory cleanup becomes provider-capability-gated and optional for correctness;
- Dropbox production must **not** delete `INPUTS/` directories automatically while no atomic empty-only delete capability exists;
- harmless empty directories may remain;
- a future provider capability may safely implement conditional empty-directory cleanup;
- acceptance criterion AC-15 must be rewritten accordingly.

**Hard gate:** do not start Task 1 until the founder explicitly approves this safety amendment and the spec is updated/committed.

---

## Task 0 — Amend the validated spec for safe directory semantics

**Files**
- Modify: `docs/superpowers/specs/2026-08-31-input-lifecycle-triggered-ingestion-design.md`

- [ ] Update Section 6.5 `COMPLETE` so empty-directory removal is not a mandatory terminal postcondition.
- [ ] Update Section 10 to make empty-directory cleanup capability-gated and explicitly disabled for Dropbox until an atomic empty-only delete primitive exists.
- [ ] Update Section 13 crash matrix so directory cleanup is optional/non-correctness-critical.
- [ ] Rewrite AC-15 to prove that lack of safe directory deletion never blocks file-level intake completion and that Project OS never recursively deletes a concurrently populated INPUTS directory.
- [ ] Update required tests to include “Dropbox leaves empty INPUTS directories rather than risking recursive deletion.”
- [ ] Re-read the amended spec for any remaining statement that makes empty-folder deletion mandatory.
- [ ] Commit only the approved spec amendment.

**Verification**
```bash
git diff --check
```

**Commit**
```text
docs: make INPUTS directory cleanup fail-safe
```

---

## Task 1 — Add the durable provider-neutral input-intake domain and ledger

**Files**
- Create: `src/documents/input-intake.ts`
- Create: `src/documents/input-intake-repository.ts`
- Modify: `src/persistence/layout.ts`
- Create: `test/input-intake-repository.spec.ts`

### RED

- [ ] Add tests for a deterministic intake ID derived from project ID + provider ID + stable object identity + provider revision token.
- [ ] Add tests for immutable source evidence fields: source path, relative input path, provider identity, revision token, integrity hash, size and detected timestamp.
- [ ] Add tests for lifecycle phases:
  `DETECTED`, `SNAPSHOTTED`, `REFERENCE_COMMITTED`, `SOURCE_REMOVED`, `COMPLETE`, `DUPLICATE_CLEANED`, `WITHDRAWN`, `CONFLICT`.
- [ ] Add tests that legal forward transitions are accepted and terminal-state rewrites/downgrades are rejected.
- [ ] Add a durable source-path binding so a later deleted change can resolve the active/latest intake without guessing identity from the path.
- [ ] Add replay tests proving exact duplicate writes are idempotent while incompatible reuse of the same intake ID/path binding fails closed.
- [ ] Run the targeted test and prove it fails because the new domain/repository does not exist.

```bash
npx vitest run test/input-intake-repository.spec.ts
```

### GREEN

- [ ] Implement `InputIntakePhase` and `InputIntakeRecord` with schema version `1.0`.
- [ ] Implement deterministic `inputIntakeIdFor(...)` using Project OS SHA-256 and a stable `INTAKE-<24 uppercase hex>` identifier.
- [ ] Add safe machine paths under `.project-os/projects/<PRJ>/documents/intakes/` and `.../intake-bindings/source-path/`.
- [ ] Implement repository read/create/advance/bind methods using create-once/idempotent conflict verification patterns already used by Managed Document request and MutationGate ledgers.
- [ ] Keep the record provider-neutral; do not persist Dropbox-specific class/type names in the domain model.
- [ ] Run targeted tests and `npm run check:persistence-boundary`.

```bash
npx vitest run test/input-intake-repository.spec.ts
npm run check:persistence-boundary
```

**Commit**
```text
feat: add durable input intake ledger
```

---

## Task 2 — Implement postcondition-driven InputIntakeService and crash recovery

**Files**
- Create: `src/documents/input-intake-service.ts`
- Modify: `src/documents/repository.ts` only for small reusable reference-ledger helpers if required
- Modify: `src/persistence/layout.ts` only if Task 1 did not cover every path
- Create: `test/input-intake-service.spec.ts`
- Create: `test/input-intake-faults.spec.ts`
- Reuse helpers from: `test/helpers/persistence-runtime.ts`

### RED

- [ ] Test normal nested input ingestion reaches `COMPLETE`, preserves immutable provider payload, creates the governed reference and removes only the source file.
- [ ] Test exact replay after `COMPLETE` is idempotent.
- [ ] Test crash after `DETECTED`/before snapshot.
- [ ] Test crash after immutable snapshot and before visible reference copy.
- [ ] Test crash after visible reference copy and before ledger version/head write.
- [ ] Test crash after ledger reference write and before source deletion — this is the observed production regression class.
- [ ] Test crash after source deletion but before terminal intake marker.
- [ ] Test an already-existing version/head with the source still present converges cleanup instead of returning `ignored`.
- [ ] Test exact current-reference duplicate reaches `DUPLICATE_CLEANED` and no second document head is created.
- [ ] Test divergent destination content reaches `CONFLICT` and the input remains.
- [ ] Test source metadata changes to a newer revision before cleanup: preserve the source/newer reality and do not delete it.
- [ ] Test source disappears before governed capture: `WITHDRAWN`, no resurrection.
- [ ] Test source disappears after a fully verified governed reference: replay may converge to `COMPLETE`.
- [ ] Test an ordinary source routes to `REFERENCES/UNCLASSIFIED/<relative-input-path>`.
- [ ] Test Dropbox-safe directory behavior: source file disappears but empty ancestor folders are left untouched because no atomic empty-only delete capability exists.
- [ ] Prove the new tests fail against the existing reconciler-only behavior.

```bash
npx vitest run test/input-intake-service.spec.ts test/input-intake-faults.spec.ts
```

### GREEN

- [ ] Implement a small `InputIntakeService` whose public method accepts project state + one provider file change + optional trusted referral provenance.
- [ ] Order effects strictly:
  1. ensure `DETECTED` record,
  2. snapshot exact source bytes to immutable evidence,
  3. persist `SNAPSHOTTED`,
  4. resolve safe reference destination,
  5. handle exact current-reference duplicate if applicable,
  6. copy/reuse visible reference only when content evidence is compatible,
  7. write/reuse immutable version + head + provider-file binding + current fingerprint,
  8. re-read/verify governed reference postcondition,
  9. persist `REFERENCE_COMMITTED`,
  10. re-read source metadata and verify it is the exact recorded revision before deletion,
  11. delete source file only,
  12. verify source absence,
  13. persist `SOURCE_REMOVED` then terminal outcome.
- [ ] Reuse immutable snapshot, version and visible reference on replay rather than creating semantic duplicates.
- [ ] Return a structured result such as `completed | duplicate_cleaned | withdrawn | conflict` plus `resumed` and intake/reference identity.
- [ ] Do not perform automatic folder deletion on Dropbox.
- [ ] Run targeted tests and persistence-boundary check.

```bash
npx vitest run test/input-intake-service.spec.ts test/input-intake-faults.spec.ts
npm run check:persistence-boundary
```

**Commit**
```text
feat: make input intake postcondition driven
```

---

## Task 3 — Route INPUTS reconciliation through the intake engine and expose terminal outcomes

**Files**
- Modify: `src/documents/reconciler.ts`
- Modify: `test/document-reference-reconcile.spec.ts`
- Create: `test/input-intake-withdrawal.spec.ts`
- Modify: `test/document-change-coordinator.spec.ts` for compatibility assertions only

### RED

- [ ] Replace/extend regression tests to prove `existing version + stale INPUTS source` resumes cleanup and is not counted as generic ignored work.
- [ ] Test deleted INPUT change resolves through durable source-path binding and records `WITHDRAWN` when capture was incomplete.
- [ ] Test completed/ref-committed intake plus a deleted-source event converges terminal completion rather than resurrecting the source.
- [ ] Add summary assertions distinguishing:
  - `intake_completed`,
  - `duplicate_cleaned`,
  - `withdrawn`,
  - `intake_resumed`,
  - `conflicts`.
- [ ] Preserve compatibility counters `ingested`/`duplicates` if externally consumed, but forbid known partial intake from disappearing under `ignored`.
- [ ] Prove targeted tests fail before integration.

```bash
npx vitest run test/document-reference-reconcile.spec.ts test/input-intake-withdrawal.spec.ts
```

### GREEN

- [ ] Replace the private multi-effect `ingestInput()` implementation with delegation to `InputIntakeService`.
- [ ] Route INPUT deleted changes to intake withdrawal/convergence logic when a path binding exists; unrelated historical deleted entries remain conservative.
- [ ] Map structured intake outcomes into explicit reconciliation summary fields.
- [ ] Preserve WORKING/REVIEW/DELIVERABLES behavior unchanged.
- [ ] Run targeted reconciliation/change-coordinator suites.

```bash
npx vitest run test/document-reference-reconcile.spec.ts test/input-intake-withdrawal.spec.ts test/document-change-coordinator.spec.ts
```

**Commit**
```text
refactor: reconcile INPUTS through durable intake
```

---

## Task 4 — Make provider change pages durable before cursor advancement

**Files**
- Create: `src/documents/change-job-store.ts`
- Modify: `src/documents/change-coordinator.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: `test/document-change-coordinator.spec.ts`
- Create: `test/document-change-job-faults.spec.ts`

### RED

- [ ] Add a per-project Durable Object job-store test using SQLite storage.
- [ ] Test crash before atomic job registration/cursor commit: cursor remains old and the page replays.
- [ ] Test crash after jobs are durably registered and cursor is advanced but before any job executes: pending job survives and executes later.
- [ ] Test replay of the same page deduplicates deterministic job IDs.
- [ ] Test jobs preserve page order/sequence where order matters for successive revisions.
- [ ] Test one failing/transient job remains pending while completed jobs are not semantically rerun.
- [ ] Test MutationGate still classifies each final-zone change before normal document reconciliation for that job.
- [ ] Test cursor reset baseline is registered into durable jobs before its new cursor is persisted.
- [ ] Test archived projects do not create active intake work.
- [ ] Prove current `cursorStore.put()` architecture cannot satisfy the “cursor advanced but job not executed” test.

```bash
npx vitest run test/document-change-coordinator.spec.ts test/document-change-job-faults.spec.ts
```

### GREEN

- [ ] Store the managed-document cursor and change jobs in ProjectGuard SQLite through one dedicated `ChangeJobStore`.
- [ ] Use a deterministic job ID derived from provider change identity/evidence (including deleted-path identity where metadata is absent).
- [ ] Add one SQLite transaction that inserts all relevant page jobs idempotently and updates cursor only after registration succeeds.
- [ ] Reconcile in this order:
  1. drain existing pending jobs,
  2. fetch page from durable cursor/baseline,
  3. atomically register page + cursor,
  4. drain registered jobs,
  5. leave failed jobs durable for retry.
- [ ] Ensure job processing invokes MutationGate/bootstrap/reconciler for the single stored change with the stored detection source.
- [ ] Keep provider cursor as hot technical synchronization state; Managed Document truth remains portable in Dropbox ledgers.
- [ ] Run targeted tests.

```bash
npx vitest run test/document-change-coordinator.spec.ts test/document-change-job-faults.spec.ts
```

**Commit**
```text
feat: persist document change jobs before cursor advance
```

---

## Task 5 — Add governed cross-project referral delivery and machine-verifiable provenance

**Files**
- Create: `src/domain/referral-write.ts`
- Create: `src/documents/referral-provenance.ts`
- Modify: `src/persistence/layout.ts`
- Modify: `src/inbox/processor.ts`
- Modify: `src/index-neutral.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: `src/documents/input-intake-service.ts`
- Create: `test/referral-write.spec.ts`
- Create: `test/referral-inbox.spec.ts`
- Create: `test/referral-intake-routing.spec.ts`
- Modify: `test/admin-process-inbox.spec.ts`

### RED

- [ ] Define tests for a typed referral request carrying request ID, source project, target project, relative path, exact content/hash, created time and optional referral type/topic.
- [ ] Test invalid/unsafe project IDs, paths, hashes and request IDs are rejected.
- [ ] Test referral inbox source/target projects must both resolve in RegistryGuard before delivery.
- [ ] Test target ProjectGuard writes immutable referral provenance **before** the visible target `INPUTS/` source exists as a governed delivery effect.
- [ ] Test exact request replay is idempotent; request-ID reuse with changed content/source/target conflicts.
- [ ] Test a verified referral is ingested to `REFERENCES/REFERRALS/<source_project_id>/<relative_path>`.
- [ ] Test referral provenance binding content hash/source/target mismatch fails closed.
- [ ] Test a Markdown file that merely claims referral frontmatter but lacks machine provenance routes to `REFERENCES/UNCLASSIFIED/`.
- [ ] Test referral ingestion creates no canonical task/decision/research revision.
- [ ] Test current project/session semantics are not changed by target delivery.
- [ ] Prove tests fail because no governed referral primitive exists today.

```bash
npx vitest run test/referral-write.spec.ts test/referral-inbox.spec.ts test/referral-intake-routing.spec.ts
```

### GREEN

- [ ] Implement parser/schema for the typed referral request.
- [ ] Add V2 machine queue/receipt paths for referrals following existing transaction/artifact inbox conventions.
- [ ] Extend `processInbox` to process transaction → artifact/referral ordering deliberately; preserve existing transaction dependencies.
- [ ] Route referral requests to the target ProjectGuard internal `/referral` endpoint.
- [ ] In ProjectGuard, verify request hash and project binding, create immutable provenance intent/binding, then create/reuse the target INPUTS file idempotently.
- [ ] Add durable provenance lookup consumed by `InputIntakeService`; only a matching machine record authorizes `REFERRALS/<source_project_id>` routing.
- [ ] Keep raw/unverified referral-like files in UNCLASSIFIED.
- [ ] Run referral and inbox suites.

```bash
npx vitest run test/referral-write.spec.ts test/referral-inbox.spec.ts test/referral-intake-routing.spec.ts test/admin-process-inbox.spec.ts
```

**Commit**
```text
feat: govern cross-project referral provenance
```

---

## Task 6 — Add a durable Dropbox webhook handoff and remove cron reconciliation as a correctness fallback

**Files**
- Create: `src/durable/dropbox-change-guard.ts`
- Create or extract: `src/documents/change-fleet.ts`
- Modify: `src/index.ts`
- Modify: `src/index-neutral.ts`
- Modify: `src/index-mutation-gate.ts`
- Modify: `src/env.ts` only if generated binding typing requires a hand-written overlay
- Modify: `wrangler.jsonc`
- Modify: `test/webhook.spec.ts`
- Create: `test/dropbox-change-guard.spec.ts`
- Modify: `vitest.config.ts` only as needed for the new DO binding

### RED

- [ ] Extend webhook tests beyond HMAC: valid webhook must not return success if durable handoff to the change guard fails.
- [ ] Test duplicate webhook notifications coalesce safely and do not lose work.
- [ ] Test durable handoff exists before HTTP 200 is returned.
- [ ] Test `DropboxChangeGuard` retains pending generation/work after a simulated reconcile failure and schedules retry.
- [ ] Test a notification arriving during active processing advances requested generation and causes another run after the current generation completes.
- [ ] Test successful fleet reconciliation marks only the processed generation complete.
- [ ] Test the scheduled cron no longer invokes managed-document reconciliation; transaction/artifact/referral inbox processing and materialization maintenance may remain scheduled.
- [ ] Test `waitUntil()` is optional execution scheduling after durable handoff, never the only correctness boundary.
- [ ] Prove current webhook implementation fails these durability tests.

```bash
npx vitest run test/webhook.spec.ts test/dropbox-change-guard.spec.ts
```

### GREEN

- [ ] Implement a narrow global `DropboxChangeGuard` Durable Object keyed as `global`, with durable requested/completed generation counters and alarms.
- [ ] `/notify` must persist/increment pending generation and ensure an alarm before returning success.
- [ ] Alarm execution runs the existing project fleet reconciliation, retries on failure, and re-arms when a newer generation arrived during processing.
- [ ] Extract `reconcileManagedDocuments` fleet logic to a reusable module if this avoids circular worker dependencies.
- [ ] Change webhook route to synchronously `await` durable `/notify`; return 200 only after that succeeds.
- [ ] Remove managed-document reconciliation from the recurring cron so cron is not a hidden INPUTS correctness mechanism.
- [ ] Add Wrangler binding/export for `DROPBOX_CHANGE_GUARD`. If Wrangler requires a migration for the new SQLite Durable Object, add the minimal exact migration supported by the current config and prove with dry-run.
- [ ] Export the DO from the effective `src/index-mutation-gate.ts` entrypoint.
- [ ] Regenerate Worker types and run targeted tests.

```bash
npm run types
npx vitest run test/webhook.spec.ts test/dropbox-change-guard.spec.ts
npx wrangler deploy --dry-run
```

**Commit**
```text
feat: durably hand off Dropbox change triggers
```

---

## Task 7 — Add explicit legacy INPUTS recovery using the same intake engine

**Files**
- Create: `src/documents/input-recovery.ts`
- Modify: `src/durable/project-guard-neutral.ts`
- Modify: `src/index-neutral.ts`
- Modify: `src/index-mutation-gate.ts` only if authenticated admin routing lives there
- Create: `test/input-recovery.spec.ts`
- Create: `test/admin-recover-inputs.spec.ts`

### RED

- [ ] Test authenticated `POST /v1/admin/recover-inputs` requires an explicit non-empty project ID list; there is no “scan everything forever” mode.
- [ ] Test unknown project IDs are rejected before provider mutation.
- [ ] Test target ProjectGuard recursively enumerates only the selected project's `INPUTS/` root for this explicit request.
- [ ] Test discovered files are fed into the exact same `InputIntakeService`, not a separate migration implementation.
- [ ] Test already-proven reference + stale source converges safe cleanup.
- [ ] Test never-ingested source performs normal intake.
- [ ] Test divergent/ambiguous evidence produces `CONFLICT` and preserves input.
- [ ] Test a historical referral-looking Markdown without governed provenance falls back to UNCLASSIFIED.
- [ ] Test archived-project recovery does not resurrect active workspace state.
- [ ] Test endpoint is never called by scheduled maintenance.
- [ ] Prove tests fail before implementation.

```bash
npx vitest run test/input-recovery.spec.ts test/admin-recover-inputs.spec.ts
```

### GREEN

- [ ] Implement explicit project-scoped recovery enumeration and structured summary (`scanned`, `completed`, `duplicate_cleaned`, `conflicts`, `withdrawn`, `failed`).
- [ ] Add internal ProjectGuard `/recover-inputs` route serialized with other project work.
- [ ] Add authenticated top-level admin route that validates requested projects against RegistryGuard and dispatches only those projects.
- [ ] Do not add any scheduled call or hidden automatic global scan.
- [ ] Run targeted tests.

```bash
npx vitest run test/input-recovery.spec.ts test/admin-recover-inputs.spec.ts
```

**Commit**
```text
feat: add explicit INPUTS recovery operation
```

---

## Task 8 — Documentation, observability, high-risk regression gate and release procedure

**Files**
- Modify: `docs/managed-documents.md`
- Modify: `docs/project-os-sop.md`
- Modify: `README.md` only where architecture/trigger behavior is user-facing
- Modify: `package.json`
- Modify existing tests as needed for final observability assertions

### RED / contract verification

- [ ] Add final tests/assertions proving summary output never hides a known partial intake under generic `ignored`.
- [ ] Add `test/input-intake-faults.spec.ts`, `test/document-change-job-faults.spec.ts`, `test/dropbox-change-guard.spec.ts` and `test/input-recovery.spec.ts` to `test:persistence-high-risk`.
- [ ] Document machine intake ledger, terminal outcomes and that source ingestion does not equal business acceptance.
- [ ] Document typed referral delivery as the supported way to create machine-verifiable cross-project provenance.
- [ ] Document that raw referral-looking files are ordinary unclassified evidence.
- [ ] Document webhook durable handoff + per-project durable change jobs + cursor semantics.
- [ ] Explicitly document that Dropbox empty directories may remain because recursive folder deletion is not safe without an atomic empty-only capability.
- [ ] Document explicit admin recovery and state that it is not scheduled.
- [ ] Update any obsolete statement that says cursor advancement waits for full semantic reconciliation; it now waits for durable per-change registration.

### Full verification

- [ ] Run the complete local verification gate.

```bash
npm run check
npm run test:persistence-high-risk
npx wrangler deploy --dry-run
git diff --check
```

- [ ] Inspect `git diff main...HEAD` and reject unrelated changes.
- [ ] Verify no periodic INPUTS scan was introduced (`scheduled` path, cron, recovery call graph).
- [ ] Verify no raw Markdown/frontmatter parser can establish trusted referral provenance.
- [ ] Verify no Dropbox-specific transport classes leaked above the provider boundary.
- [ ] Open a pull request against `main` with the exact spec/plan, crash matrix and verification evidence.
- [ ] Do not merge until CI is fully green and the founder explicitly authorizes merge.

**Commit**
```text
docs: finalize trigger-first INPUTS lifecycle
```

---

## Required Release / Production Verification After Merge

Do not mark `TASK-IMPINPUTLIFECYCLE001` complete merely because code merged.

- [ ] Deploy the exact merged commit through the normal Project OS deployment path and verify deployment identity/evidence.
- [ ] Verify the production webhook is handing off to `DropboxChangeGuard` and recurring cron is not performing managed-document reconciliation as fallback correctness.
- [ ] Create a controlled new INPUTS file in a disposable/approved project and verify trigger-only ingestion reaches a governed reference and removes the source file.
- [ ] Invoke the explicit recovery route for the observed legacy projects **PRJ-0002 and PRJ-0003** (the code must contain no project-specific hard-coding).
- [ ] For PRJ-0002, verify the resolved historical referral no longer remains as a stale active INPUTS item after safe evidence-based recovery.
- [ ] For PRJ-0003, verify the BCOS corpus is converged safely: already-governed/duplicate evidence is cleaned only when machine-verifiable; unresolved/divergent items remain visible as conflicts rather than being deleted.
- [ ] Verify resulting `REFERENCES/` paths and Managed Document heads/fingerprints; do not infer successful recovery from source absence alone.
- [ ] Record exact GitHub PR/merge/deployment/recovery evidence in PRJ-0002 only after it is operationally real.
- [ ] Refresh canonical PRJ-0002 revision and complete `TASK-IMPINPUTLIFECYCLE001` through a typed transaction only after all required verification passes and its receipt is `committed`.

## Required Evidence Before Claiming Complete

- Founder-approved safety amendment is committed into the spec.
- RED evidence exists for each new semantic boundary.
- Intake replay proves every crash boundary can converge without source loss or duplicate semantic reference creation.
- Existing-version partial state regression is covered.
- Cursor advancement cannot orphan unregistered changes.
- Webhook acknowledgement cannot leave the provider notification with only volatile continuation state.
- Verified referral routing depends on machine provenance; frontmatter alone cannot claim it.
- No scheduled INPUTS scanner exists.
- Dropbox never recursively deletes an INPUTS directory as “empty cleanup.”
- Explicit legacy recovery preserves conflicts and proves before cleanup.
- `npm run check`, `npm run test:persistence-high-risk`, and `npx wrangler deploy --dry-run` are green on the final PR head.
- GitHub PR is merged only after explicit founder authorization.
- Production recovery is verified before canonical task completion.

## Canonical Project OS Update After Implementation

Only after merge, deployment and recovery verification:

1. Refresh PRJ-0002 `HANDOFF.md`, `STATE.md`, `OPERATING.md` and the current canonical revision.
2. Persist only operationally real implementation/deployment/recovery outcomes through supported typed transactions.
3. Include exact authoritative GitHub PR, merge commit and deployment/recovery evidence.
4. Mark `TASK-IMPINPUTLIFECYCLE001` complete only with a committed task-completion receipt.
