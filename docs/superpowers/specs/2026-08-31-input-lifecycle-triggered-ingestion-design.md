# IMP-INPUTLIFECYCLE001 — Trigger-first INPUTS lifecycle

Status: founder-approved design; safety amendment approved
Date: 2026-08-31
Project: PRJ-0002 — Project OS

## 1. Problem

`INPUTS/` is defined as a temporary ingress zone, but production evidence shows that already-consumed material can remain there indefinitely. PRJ-0002 still contains a referral whose improvement has already been implemented and canonically completed. PRJ-0003 still contains the BCOS source corpus under `INPUTS/BCOS/` even though the corpus has already produced accepted canonical research.

The existing Managed Document reconciler already intends to ingest an input by snapshotting it, copying it to `REFERENCES/UNCLASSIFIED/`, creating reference ledger state, and deleting the original input. The defect is therefore not the absence of an intended exit path. The defect is that the lifecycle is not represented as a durable, replayable operation with a verified terminal postcondition.

A file can become partially processed: durable reference evidence may exist while the original remains visible in `INPUTS/`. Current idempotence can then treat an already-known version as `ignored`, leaving the partial provider state permanently visible.

## 2. Design objective

Make `INPUTS/` a trustworthy active inbox:

> If an object is visible in `INPUTS/`, its ingestion has not reached a verified terminal state.

Normal operation is trigger-first. Project OS must not depend on periodic scans of every project's `INPUTS/` to achieve correctness.

The solution must preserve provider neutrality above the Dropbox adapter, remain crash-safe and idempotent, preserve source evidence before cleanup, and never convert source ingestion into business acceptance.

## 3. Non-goals

This improvement does not:

- solve the separate `REVIEW/` active-candidate lifecycle anomaly;
- classify arbitrary sources into business taxonomies using AI or heuristics;
- automatically create tasks, decisions, research records or deliverables from an input;
- introduce periodic full-project scans as normal ingestion machinery;
- bulk-delete historical `INPUTS/` content without evidence verification;
- make Dropbox file IDs into business identities;
- change canonical project revision merely because a source file was ingested;
- introduce a broad event-bus abstraction unless implementation evidence proves it necessary.

## 4. Core principle: active zones represent active state

For this increment:

- `INPUTS/` means awaiting completed source ingestion.
- `REFERENCES/` means durable governed source material.

An active zone must not become an archive by accident. The same principle may later inform `REVIEW/`, but REVIEW lifecycle is explicitly out of scope here.

## 5. Trigger-first architecture

### 5.1 Dropbox webhook remains the external trigger

Dropbox webhooks remain the primary trigger. A webhook means provider changes exist; exact file changes are resolved through the Dropbox change-feed cursor.

Webhook acknowledgement is not semantic completion evidence.

### 5.2 Durable trigger handoff is mandatory

The production webhook path must not rely solely on an in-memory or `waitUntil()` continuation whose loss could leave an acknowledged provider notification without a durable continuation path.

After signature verification, Project OS must durably register pending provider-change consumption before treating the notification as safely handed off. The implementation should reuse the existing Cloudflare Durable Object architecture unless a simpler equally durable primitive is proven sufficient.

Required behavior:

1. verify webhook signature;
2. durably register pending provider-change work;
3. acknowledge the webhook;
4. consume provider changes independently and retry until the durable work reaches a terminal state.

The trigger record is technical synchronization state. It creates no business truth.

### 5.3 Change-feed cursor semantics

The Dropbox cursor is provider synchronization state, not semantic completion evidence.

For each change-feed page:

1. fetch the page from the current cursor;
2. normalize provider entries;
3. identify the owning project from the canonical workspace path;
4. durably register idempotent per-change work for every relevant entry;
5. only then persist advancement to the page cursor.

The cursor may advance before each intake job finishes only because every relevant entry already has a durable continuation path. It must never advance past an unregistered relevant change.

### 5.4 Project isolation

Each project change is routed to that project's `ProjectGuard` or equivalent project-scoped coordination boundary. Processing PRJ-0003 provider changes cannot mutate PRJ-0002 document state.

Cross-project delivery into a target project's `INPUTS/` does not rebind the source chat/project and does not automatically create target business truth.

## 6. Durable input-intake lifecycle

Each input file ingestion has a durable technical intake record. This belongs to provider/Managed Document operational state, not canonical business state.

Lifecycle states are:

```text
DETECTED
  -> SNAPSHOTTED
  -> REFERENCE_COMMITTED
  -> SOURCE_REMOVED
  -> COMPLETE
```

Terminal alternatives are:

```text
DUPLICATE_CLEANED
WITHDRAWN
CONFLICT
```

### 6.1 DETECTED

Project OS durably knows the provider object identity, revision, path and evidence needed to process the input.

The intake identity must be deterministic or otherwise idempotently recoverable so duplicate trigger/change delivery cannot create competing intake operations.

### 6.2 SNAPSHOTTED

The exact source bytes are preserved in immutable hidden evidence before destructive cleanup.

No deletion from `INPUTS/` may occur before evidence has been safely preserved.

### 6.3 REFERENCE_COMMITTED

A governed reference version/head exists and a visible reference provider object exists under `REFERENCES/` with evidence matching the snapshotted source.

Ordinary sources default to:

```text
REFERENCES/UNCLASSIFIED/<relative-input-path>
```

### 6.4 SOURCE_REMOVED

The original provider object has been removed from `INPUTS/` only after the durable reference representation is verified.

This removes an inbox copy, not evidence: immutable evidence and the governed reference remain.

### 6.5 COMPLETE

All mandatory file-level postconditions are true:

- immutable source evidence exists;
- governed reference version/head exists;
- visible reference provider object exists with matching evidence;
- original `INPUTS/` object no longer exists.

Empty-directory cleanup is **not** part of the mandatory terminal postcondition. It may be performed only when the active provider exposes a race-safe capability equivalent to “delete this directory only if it is still empty.”

With the current Dropbox contract, Project OS must leave harmless empty `INPUTS/` directories in place rather than use recursive folder deletion that could remove a concurrently added human file.

`COMPLETE` means technical ingestion completed. It never implies research acceptance, decision acceptance or any other canonical business acceptance.

## 7. Idempotence is based on the terminal postcondition

The current shortcut `existing version -> ignored` is invalid for a multi-effect intake operation.

The replacement rule is:

> Every replay checks the complete intended file-level postcondition and converges missing safe effects. An intermediate ledger record never proves intake completion by itself.

### Crash after snapshot

Reuse the immutable snapshot, finish reference creation/verification, then clean the source.

### Crash after visible/reference creation but before source deletion

Verify the existing governed reference and remove the stale `INPUTS/` copy. Finish `COMPLETE`.

### Exact duplicate already governed

If machine evidence proves byte-identical content is already represented by a current governed reference, remove the duplicate input and finish `DUPLICATE_CLEANED`.

### Divergent destination

If the intended reference destination contains different content that cannot be proven compatible, preserve both realities, leave the input visible, and enter `CONFLICT`.

### Human withdrawal

If the source disappears before governed capture succeeds and no committed reference exists, finish `WITHDRAWN`. Project OS must not resurrect it.

If a governed reference had already safely committed before source disappearance, replay may converge to `COMPLETE` after verifying the durable destination/evidence.

## 8. Referral routing

Cross-project referrals may use a dedicated structural reference collection only when referral provenance is machine-verifiable.

Verified referrals route to:

```text
REFERENCES/REFERRALS/<source_project_id>/<referral-filename>
```

Machine-verifiable provenance may come from governed Project OS referral delivery evidence or another implementation mechanism that proves the registered source and target projects. Arbitrary user-authored frontmatter is not sufficient by itself to claim trusted cross-project provenance.

If referral provenance cannot be verified, ingest the file as an ordinary source under `REFERENCES/UNCLASSIFIED/` rather than inventing trusted provenance.

For verified referrals preserve, when available:

- source project ID;
- target project ID;
- referral type/topic;
- creation timestamp;
- original delivery/provider evidence;
- content hash.

Structural routing does not accept the referral's claims. A referral can remain unacted on indefinitely without remaining in `INPUTS/`.

## 9. Ordinary source routing

Unknown or ordinary source documents use:

```text
REFERENCES/UNCLASSIFIED/<relative-input-path>
```

Low-level intake must not infer business taxonomy from filenames or content.

Later explicit reclassification must preserve governed reference identity according to the reference identity contract.

## 10. Directory behavior

Input directories are organizational containers, not durable evidence objects.

File-level intake correctness never depends on deleting empty directories. Directory cleanup is a provider capability, not a core lifecycle requirement.

A provider may clean empty ancestors below `INPUTS/` only if it supports a race-safe, non-recursive or conditional empty-only deletion primitive whose semantics prevent deletion of content added concurrently after an emptiness check.

The current Dropbox API path used by Project OS does not provide that safety contract. Dropbox `delete_v2` recursively deletes folders; therefore Project OS must **not** automatically delete `INPUTS/` directories after ingestion. Empty directories may remain harmlessly.

A future provider capability may enable safe cleanup without changing the file-level intake state machine.

## 11. Provider-neutral boundary

The core intake lifecycle operates on provider capabilities/evidence such as:

- stable object identity where available;
- revision token;
- integrity hash;
- immutable snapshot/copy;
- metadata lookup;
- delete of the exact source object;
- provider change notification/change feed;
- optional race-safe empty-directory deletion capability.

Dropbox-specific webhook and cursor mechanics remain inside the Dropbox/provider integration layer.

Core logical reference identity must never be a Dropbox file ID.

## 12. Concurrency

Project-scoped intake is serialized through the existing ProjectGuard coordination boundary or an equivalently deterministic project-scoped coordinator.

The implementation must tolerate:

- duplicate webhook notifications;
- duplicate provider change entries;
- replay of a change-feed page;
- successive revisions of the same provider object;
- human modification/removal during intake;
- provider path/CAS conflicts.

Project OS never silently overwrites a newer provider reality merely to force intake completion.

## 13. Cursor and intake crash matrix

The implementation must verify at least these boundaries:

1. crash before durable per-change registration: cursor cannot irreversibly advance past the change;
2. crash after job registration but before cursor advancement: page replay deduplicates jobs;
3. crash after cursor advancement but before job execution: durable job still executes;
4. crash after immutable snapshot: replay resumes from evidence;
5. crash after provider reference copy: replay verifies/reuses it;
6. crash after reference ledger write but before source deletion: replay performs cleanup;
7. crash after source deletion but before terminal intake record: replay verifies postconditions and closes the intake;
8. optional directory-cleanup failure or absence of a safe capability never blocks `COMPLETE` and never permits recursive deletion of a concurrently populated `INPUTS/` directory.

## 14. Historical recovery / one-time remediation

Existing stale inputs are repaired through an explicit administrative recovery operation, not through permanent polling.

The recovery operation enumerates only explicitly selected projects or `INPUTS/` roots and feeds discovered files into the same intake engine used by normal triggered processing.

Recovery outcomes:

- exact governed reference proven -> complete safe source cleanup;
- no governed reference -> run normal intake;
- divergent provider/reference bytes -> `CONFLICT`, preserve source;
- ambiguous evidence -> `CONFLICT`, preserve source.

The initial remediation must cover the observed stale PRJ-0002 referral and PRJ-0003 BCOS corpus, while the recovery mechanism remains general and contains no project-specific hard-coding.

Recovery is explicit/admin-triggered and exceptional. It is never scheduled recurring correctness machinery.

## 15. Canonical business-state semantics

Source ingestion alone does not increment project business revision.

Canonical transactions remain required for accepted research, decisions, constraints, task lifecycle, project lifecycle and other business facts.

A source/referral may therefore be technically `COMPLETE` while producing no canonical mutation.

## 16. Observability

Reconciliation/intake observability must distinguish at least:

- detected/queued;
- completed;
- duplicate-cleaned;
- withdrawn;
- conflicts;
- resumed partial intakes;
- explicit recovery repairs.

A generic `ignored` outcome must not conceal a partially satisfied intake postcondition.

## 17. Fail-closed cleanup rules

Project OS never deletes an `INPUTS/` object merely because:

- its filename resembles a reference;
- a research/decision record mentions it;
- an LLM says it has been processed;
- an intermediate ledger/version record exists.

Deletion requires machine-verifiable evidence that the intended governed source representation exists with compatible content, or that the input is an exact duplicate of a proven current reference.

Project OS also never recursively deletes an `INPUTS/` directory merely because a preceding list operation observed it as empty.

## 18. Acceptance criteria

### AC-01 — Triggered ingestion

Adding a file under a project's `INPUTS/` and delivering the provider trigger ingests it without a periodic input scan.

### AC-02 — Active inbox invariant

After successful ingestion, the source file is absent from `INPUTS/` and present as a governed reference.

### AC-03 — Durable webhook handoff

A successfully acknowledged webhook cannot be the sole volatile record of pending input work; pending change-feed consumption has a durable continuation path.

### AC-04 — Crash after reference creation

If execution stops after reference creation but before source deletion, replay removes the stale input and reaches `COMPLETE` without duplicating the reference.

### AC-05 — Existing-version partial state

An existing version/head does not cause `ignored` while source cleanup remains incomplete. Replay checks and converges the terminal postcondition.

### AC-06 — Duplicate source

Byte-identical content already represented by a proven current governed reference is safely removed from `INPUTS/` and terminates as `DUPLICATE_CLEANED`.

### AC-07 — Divergent destination

A divergent destination preserves the input and reports `CONFLICT`.

### AC-08 — Verified referral routing

A machine-verifiable PRJ-0003 -> PRJ-0002 referral is ingested under `REFERENCES/REFERRALS/PRJ-0003/` with provenance preserved and creates no automatic business acceptance.

### AC-09 — Unverified referral-like file

A referral-looking file without machine-verifiable provenance is ingested as `UNCLASSIFIED`, not treated as trusted cross-project provenance.

### AC-10 — Ordinary routing

An ordinary source is ingested under `REFERENCES/UNCLASSIFIED/` without taxonomy guessing.

### AC-11 — Withdrawal

Deleting an input before successful governed capture does not cause automatic resurrection.

### AC-12 — Cursor crash safety

The provider cursor cannot permanently lose a relevant input change because every advanced-past relevant change has a durable continuation path.

### AC-13 — Historical remediation

The explicit recovery operation converges stale legacy inputs safely without a permanent periodic scanner.

### AC-14 — Project isolation

Input changes affect only their owning project.

### AC-15 — Fail-safe directory semantics

Successful file-level intake reaches `COMPLETE` even when empty ancestor directories remain. With the current Dropbox capability set, Project OS does not recursively delete `INPUTS/` directories as cleanup and therefore cannot delete a concurrently added file through a list-then-folder-delete race.

## 19. Required tests

Implementation planning must include TDD coverage for:

- normal INPUTS -> REFERENCES ingestion;
- nested input directories;
- verified referral structural routing;
- unverified referral-like fallback to UNCLASSIFIED;
- identical duplicate cleanup;
- divergent target conflict;
- every crash boundary in Section 13;
- existing-version-but-source-still-present regression;
- source withdrawal;
- successive source revisions;
- duplicate webhook/change delivery;
- cursor replay and durable-job deduplication;
- project isolation;
- one-time legacy remediation;
- Dropbox leaves empty INPUTS directories rather than risking recursive deletion;
- absence/failure of optional safe directory cleanup does not block `COMPLETE`;
- archived-project behavior;
- provider-neutral core tests and Dropbox adapter/integration tests.

## 20. Implementation constraints

- Preserve existing Managed Document reference identity and fingerprint semantics unless a proven incompatibility is found during implementation planning.
- Reuse existing ProjectGuard serialization and provider capability boundaries where possible.
- Do not add periodic full scans as a hidden fallback inside normal scheduled maintenance.
- Any durable intake ledger/job representation must have an explicit idempotency and recovery contract.
- Existing production source evidence must never be destructively migrated without machine-verifiable content/evidence checks.
- The production webhook may use `waitUntil()` for execution scheduling only after a durable continuation path exists; `waitUntil()` alone is not the correctness boundary.
- Directory cleanup must remain capability-gated; Dropbox production must not recursively delete INPUTS directories as empty-folder cleanup under the current provider contract.

## 21. Out-of-scope follow-up

The separate `REVIEW candidate lifecycle and accumulation` referral remains a later improvement. It may reuse the general active-zone principle but has different business lifecycle semantics and must not be coupled into IMP-INPUTLIFECYCLE001.
