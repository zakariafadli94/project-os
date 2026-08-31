# IMP-INPUTLIFECYCLE001 — Trigger-first INPUTS lifecycle

Status: founder-approved design
Date: 2026-08-31
Project: PRJ-0002 — Project OS

## 1. Problem

`INPUTS/` is defined as a temporary ingress zone, but production evidence shows that already-consumed material can remain there indefinitely. PRJ-0002 still contains a referral whose improvement has already been implemented and canonically completed. PRJ-0003 still contains the BCOS source corpus under `INPUTS/BCOS/` even though the corpus has already produced accepted canonical research.

The existing Managed Document reconciler already intends to ingest an input by snapshotting it, copying it to `REFERENCES/UNCLASSIFIED/`, creating reference ledger state, and deleting the original input. The defect is therefore not the absence of an intended exit path. The defect is that the lifecycle is not represented as a durable, replayable operation with a verified terminal postcondition.

A file can become partially processed: durable reference evidence may exist while the original remains visible in `INPUTS/`. Current idempotence can then treat an already-known version as `ignored`, leaving the partial provider state permanently visible.

## 2. Design objective

Make `INPUTS/` a trustworthy active inbox:

> If an object is visible in `INPUTS/`, its ingestion has not reached a verified terminal state.

Normal operation must be trigger-first. Project OS must not depend on periodic scans of every project's `INPUTS/` to achieve correctness.

The solution must preserve provider neutrality above the Dropbox adapter, remain crash-safe and idempotent, preserve source evidence before cleanup, and never convert source ingestion into business acceptance.

## 3. Non-goals

This improvement does not:

- solve the separate `REVIEW/` active-candidate lifecycle anomaly;
- classify arbitrary sources into business taxonomies using AI or heuristics;
- automatically create tasks, decisions, research records or deliverables from an input;
- introduce periodic full-project scans as the normal ingestion mechanism;
- bulk-delete historical `INPUTS/` content without evidence verification;
- make Dropbox file IDs into business identities;
- change canonical project revision merely because a source file was ingested.

## 4. Core principle: active zones represent active state

Project OS human zones must express operational state rather than become accidental archives.

For this increment:

- `INPUTS/` means awaiting completed source ingestion.
- `REFERENCES/` means durable governed source material.

The broader principle is intentionally not implemented for `REVIEW/` in this change.

## 5. Trigger-first architecture

### 5.1 Existing trigger remains the entry point

Dropbox webhooks remain the primary external trigger. A webhook is a notification that provider changes exist; exact file changes are still resolved through the Dropbox change-feed cursor.

Project OS must not interpret receipt of the webhook as proof that all semantic processing succeeded.

### 5.2 Durable trigger handoff

The webhook path must durably record or signal pending change-feed work before acknowledging the webhook whenever the runtime requires such durability for reliable retry.

The durable handoff may be implemented with the existing Cloudflare Durable Object architecture rather than a new general-purpose event platform. The design requirement is behavioral:

1. webhook signature verified;
2. pending provider-change work is durably represented;
3. webhook may return success;
4. provider-change work is retried independently until it reaches its own terminal state.

No business truth is created by this trigger record.

### 5.3 Change-feed cursor semantics

The Dropbox cursor is provider synchronization state, not semantic completion evidence.

For each change-feed page:

1. fetch the page from the current cursor;
2. normalize provider entries;
3. route relevant entries to the owning project;
4. durably register idempotent per-change work before advancing the cursor;
5. advance the cursor only after all relevant page entries have a durable continuation path.

The cursor does not need to wait for every input ingestion to finish if each ingestion job is durably recoverable. It must never advance in a way that can permanently orphan an unrecorded change.

### 5.4 Project isolation

Provider changes must be routed by canonical project workspace path to the matching `ProjectGuard`. A trigger concerning PRJ-0003 must not rebind or mutate PRJ-0002.

Cross-project referrals remain ordinary source material in the target project after delivery.

## 6. Durable input-intake lifecycle

Each input file ingestion is represented by a technical intake record. This record is Managed Document / provider operational state, not canonical business state.

Recommended states:

```text
DETECTED
  -> SNAPSHOTTED
  -> REFERENCE_COMMITTED
  -> SOURCE_REMOVED
  -> COMPLETE
```

Terminal alternatives:

```text
DUPLICATE_CLEANED
WITHDRAWN
CONFLICT
```

### 6.1 DETECTED

Project OS has durable knowledge of the provider object identity/revision/path that entered `INPUTS/`.

The intake identity must be deterministic or otherwise idempotently recoverable from provider evidence so the same change cannot create competing intake operations.

### 6.2 SNAPSHOTTED

The exact provider bytes have been copied into immutable hidden evidence before destructive cleanup.

No deletion from `INPUTS/` may occur before this point.

### 6.3 REFERENCE_COMMITTED

A governed reference version/head exists and points to visible material under `REFERENCES/`.

For ordinary sources the default destination is:

```text
REFERENCES/UNCLASSIFIED/<relative-input-path>
```

The reference's provider bytes and immutable payload must correspond to the snapshotted source bytes.

### 6.4 SOURCE_REMOVED

The original provider object has been removed from `INPUTS/` after reference integrity was verified.

Deletion is a cleanup consequence of successful ingestion, not deletion of evidence: immutable evidence and the governed reference remain.

### 6.5 COMPLETE

All required postconditions are true:

- immutable source evidence exists;
- governed reference ledger state exists;
- visible reference provider object exists with matching bytes/evidence;
- original `INPUTS/` provider object no longer exists;
- any now-empty input directories eligible for cleanup are removed.

`COMPLETE` is technical ingestion completion. It does not imply business acceptance.

## 7. Idempotence and postcondition-based recovery

The current shortcut `existing version -> ignored` is insufficient for an operation with multiple provider effects.

The new rule is:

> Replaying an intake checks and converges the complete postcondition; it does not stop merely because one intermediate ledger record already exists.

Examples:

### Case A — crash after snapshot

On replay, reuse the existing immutable snapshot, finish the reference write, verify it, then clean `INPUTS/`.

### Case B — crash after reference creation but before input deletion

On replay, verify the existing reference bytes/head and remove the stale input. Finish as `COMPLETE`.

### Case C — identical reference already exists

If current governed reference evidence proves the same content is already represented, remove the duplicate input and finish as `DUPLICATE_CLEANED`.

### Case D — target path contains divergent content

Do not overwrite or delete the input. Preserve both realities and finish/hold as `CONFLICT` with enough evidence for explicit resolution.

### Case E — input was manually removed before capture completed

Treat this as `WITHDRAWN` when no governed reference was committed. Do not restore the input automatically.

If a governed reference was already safely committed before the source disappeared, recovery may converge to `COMPLETE` because the durable destination and evidence already exist.

## 8. Referral routing

Cross-project referrals are structurally known source types and should not be dumped into generic `UNCLASSIFIED` when Project OS has trustworthy provenance.

Recommended visible destination:

```text
REFERENCES/REFERRALS/<source_project_id>/<referral-filename>
```

Required preserved provenance includes, when available:

- source project ID;
- target project ID;
- referral type/topic;
- creation timestamp;
- original source/provider evidence;
- referral body/content hash.

This structural routing does not constitute acceptance of the referral's claims.

An ingested referral may remain unacted on indefinitely without staying in `INPUTS/`.

## 9. Ordinary source routing

Unknown or ordinary source documents continue to use:

```text
REFERENCES/UNCLASSIFIED/<relative-input-path>
```

Low-level intake must not infer business taxonomy from filenames or content.

Any later reclassification is an explicit governed reference operation and must preserve the same logical reference identity according to the reference identity contract.

## 10. Directory behavior

Input directories are organizational containers, not durable evidence objects by themselves.

After successful removal of an input file, Project OS may remove ancestor directories under `INPUTS/` that are proven empty, stopping at the `INPUTS/` root.

Directory cleanup must be idempotent and must never delete a non-empty folder.

An empty directory left by a concurrent human operation is harmless; absence of empty-folder cleanup must not compromise source correctness. File-level terminal correctness is mandatory.

## 11. Provider-neutral boundary

The core lifecycle operates on provider capabilities/evidence:

- stable object identity where available;
- revision token;
- integrity hash;
- immutable snapshot/copy;
- metadata lookup;
- delete;
- change feed.

Dropbox-specific cursor and webhook behavior remains inside the Dropbox/provider integration layer.

Core input-intake logic must not depend on Dropbox-specific file IDs as logical reference IDs.

## 12. Concurrency

Input intake for one project is serialized through the project's existing coordination boundary or an equivalently deterministic per-project intake coordinator.

The design must tolerate:

- duplicate webhook notifications;
- duplicate provider change entries;
- replay of a change-feed page;
- two events for successive revisions of the same provider object;
- human modification/removal while intake is in progress;
- provider CAS/path conflicts.

The system must never silently overwrite a newer provider reality to force an intake to succeed.

## 13. Cursor and job crash matrix

The implementation must test at least these boundaries:

1. crash before durable job registration: cursor must not irreversibly advance past the change;
2. crash after durable job registration but before cursor advancement: page replay deduplicates jobs;
3. crash after cursor advancement but before job execution: durable job still executes;
4. crash after immutable snapshot: replay resumes without second semantic source;
5. crash after reference provider copy: replay verifies/reuses it;
6. crash after ledger reference write but before source deletion: replay performs cleanup;
7. crash after source deletion but before terminal intake marker: replay verifies postconditions and finishes;
8. crash during empty-directory cleanup: file intake remains complete and directory cleanup can replay.

## 14. Historical recovery / one-time remediation

Production already contains legacy inputs that predate or escaped the intended intake lifecycle. They must be repaired without introducing a permanent polling scanner.

Provide an explicit administrative recovery operation that enumerates selected projects or selected `INPUTS/` roots and feeds discovered files into the same intake engine.

Recovery classification:

- exact governed reference already proven -> finish cleanup;
- no governed reference -> execute normal intake;
- conflicting visible/reference bytes -> `CONFLICT`, preserve source;
- ambiguous evidence -> preserve source and report conflict.

The initial remediation should include at least the observed PRJ-0002 stale referral and PRJ-0003 BCOS corpus, but the repair mechanism must be general rather than hard-coded to those projects.

This recovery operation is exceptional/manual/admin-triggered. It is not scheduled recurring correctness machinery.

## 15. Canonical-state semantics

Source ingestion does not increment project business revision solely because a reference file moved from `INPUTS` to `REFERENCES`.

Canonical transactions remain required for accepted research, decisions, constraints, task lifecycle, project lifecycle and other business facts.

A referral or source can therefore be technically `COMPLETE` while producing no canonical mutation at all.

## 16. Observability

Managed-document reconciliation summaries should distinguish intake outcomes clearly enough to diagnose production behavior. At minimum expose counts or structured events for:

- detected/queued;
- completed ingestion;
- duplicate cleanup;
- withdrawn;
- conflicts;
- resumed partial operations;
- recovery-admin repairs.

A generic `ignored` outcome must not hide a partially satisfied intake postcondition.

## 17. Security and fail-closed behavior

Project OS must fail closed when provider evidence cannot prove safe cleanup.

Never delete an `INPUTS/` object merely because:

- a filename matches a reference filename;
- a research/decision record mentions it;
- an LLM says the source was already processed;
- a ledger record exists without verifying the current governed reference/provider representation.

Deletion requires sufficient machine-verifiable evidence that the intended durable source representation exists or that the input is an exact duplicate of it.

## 18. Acceptance criteria

### AC-01 — Triggered ingestion

Adding a new file under a project's `INPUTS/` and delivering the Dropbox trigger causes it to be ingested without a periodic input scan.

### AC-02 — Active inbox invariant

After successful ingestion, the source is absent from `INPUTS/` and present as a governed reference.

### AC-03 — Crash after reference creation

If execution stops after reference creation but before source deletion, replay removes the stale input and reaches terminal completion without duplicating the reference.

### AC-04 — Existing-version partial state

An existing version/head does not cause `ignored` when the source still requires cleanup. The engine checks the terminal postcondition and converges it.

### AC-05 — Duplicate source

Dropping byte-identical content already represented by a current governed reference removes the duplicate input safely and records a duplicate-cleaned outcome.

### AC-06 — Divergent destination

If the intended visible reference path contains different content that cannot be proven compatible, Project OS preserves the input and reports conflict.

### AC-07 — Referral routing

A PRJ-0003 -> PRJ-0002 referral is ingested under `REFERENCES/REFERRALS/PRJ-0003/` with provenance preserved, while creating no automatic task/decision/research acceptance.

### AC-08 — Ordinary routing

An ordinary unclassified source is ingested under `REFERENCES/UNCLASSIFIED/` without semantic taxonomy guessing.

### AC-09 — Withdrawal

Deleting an input before successful governed capture does not cause Project OS to resurrect it automatically.

### AC-10 — Cursor crash safety

Advancing the provider cursor cannot permanently lose an input change because every relevant change has a durable continuation path first.

### AC-11 — Historical remediation

The explicit recovery operation safely converges stale legacy inputs and preserves conflicts without requiring a permanent periodic scanner.

### AC-12 — Project isolation

Input changes for one project are routed to that project only and cannot mutate another project's document ledger or canonical state.

## 19. Required tests

The implementation plan must include TDD coverage for:

- normal INPUTS -> REFERENCES ingestion;
- nested input directories;
- referral structural routing;
- identical duplicate cleanup;
- target-path divergent conflict;
- replay after each crash boundary in Section 13;
- existing-version-but-source-still-present regression;
- source withdrawn before completion;
- successive revisions of the same provider object;
- duplicate webhook/change delivery;
- cursor replay and durable-job deduplication;
- project isolation;
- one-time legacy remediation;
- empty directory cleanup;
- archived project behavior;
- provider-neutral unit tests plus Dropbox adapter/integration tests.

## 20. Implementation constraints

- Preserve existing Managed Document reference identity and fingerprint semantics unless the implementation plan identifies a proven incompatibility.
- Reuse existing ProjectGuard serialization and provider capability boundaries where possible.
- Do not introduce a broad event-bus abstraction unless required by verified implementation constraints.
- Do not add periodic full scans as a fallback hidden inside normal scheduled maintenance.
- Any durable technical intake ledger must have an explicit idempotency and recovery contract.
- Existing production source evidence must never be destructively migrated without content/evidence verification.

## 21. Out-of-scope follow-up

The separate referral `REVIEW candidate lifecycle and accumulation` should be handled as a later improvement. It may reuse the general principle that active zones should expose only active state, but it has different lifecycle semantics and must not be coupled into IMP-INPUTLIFECYCLE001.
