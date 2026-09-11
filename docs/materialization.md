# Project OS Materialization / Projection Engine

Status: operational contract for `IMP-MATERIAL001`.

## Purpose

Project OS separates durable business commits from human-facing materialization.

The authoritative order is:

```text
canonical commit record = business truth
completed materialization record = immutable projection checkpoint
materialization head = latest projection proven complete
SQLite materialization ledger = rebuildable hot progress
Markdown workspace = derived human view
```

A business commit can therefore be valid while the human workspace is temporarily one or more revisions behind. Projection lag is expected asynchronous state, not a rollback condition and not loss of committed work.

## Normal flow

For V2 transactions:

```text
validate/apply transaction
  -> publish immutable canonical commit record
  -> persist ProjectGuard hot state + committed receipt result
  -> queue materialization target
  -> return business result
  -> alarm materializes derived files asynchronously
  -> verify generation
  -> publish immutable completed-generation record
  -> advance materialization head
```

If immediate scheduling fails after the commit record exists, the commit remains valid. The MaterializationGuard alarm and the five-minute fleet reconciliation cron can reconstruct the pending target later.

`project.create` keeps its existing RegistryGuard receipt ownership: ProjectGuard does not race the standalone create receipt before registry finalization.

## Durable paths

For project `PRJ-xxxx`, completed generation evidence is stored under:

```text
/PROJECT_OS/.project-os/projects/PRJ-xxxx/materializations/
```

A generation path is deterministic:

```text
REV-000072-PV-0001.json
```

The latest verified generation pointer is:

```text
/PROJECT_OS/.project-os/projects/PRJ-xxxx/materialization-head.json
```

The immutable completed record is always written before the mutable head is advanced. If the head update fails after the record exists, reconciliation validates the record and repairs only the head; it does not replay the business transaction or rewrite already verified workspace files.

## Projection version

Materialization identity contains both:

- canonical business revision;
- projection version.

The active projection version is `3`. Earlier projection versions remain readable as immutable historical evidence; a renderer/projection change can bump the version and rematerialize the current canonical revision without creating a domain event or fake business revision.

## `input_hash` versus `content_hash`

Each derived output uses two hashes for distinct purposes.

### `input_hash`

A deterministic hash of only the semantic inputs used by that renderer, plus projection version.

It decides whether a non-critical output needs to be rendered at all. If the semantic input hash matches the prior completed generation, the previous output evidence is carried forward with zero render and zero Dropbox upload.

This intentionally prevents the project-wide revision number from forcing every note to be rewritten on every transaction.

### `content_hash`

SHA-256 of the exact persisted bytes.

It is used for:

- idempotency;
- post-failure verification;
- stale/unexpected destination detection;
- immutable completed-generation evidence.

## Source revision of carried-forward notes

Non-critical notes may retain a frontmatter `revision` older than the current project revision when their semantic content did not change.

That value is the source/content revision of those persisted bytes. It is not a claim that every Markdown file was physically rewritten for the current project revision.

Current project freshness comes from canonical state and completed materialization evidence, not arbitrary entity-note frontmatter.

`STATE.md` and `HANDOFF.md` are different: both are critical head/recovery views and are physically rendered and verified for every completed target revision and projection version.

## Coherent `STATE.md` / `HANDOFF.md`

A generation is never declared complete unless both critical files:

- were produced from the same canonical `ProjectState`;
- contain the same target revision;
- use the same projection version;
- match their expected content hashes.

Dropbox cannot make two independent files externally visible in one atomic filesystem transaction. Project OS therefore makes a narrower, enforceable guarantee: a partial pair is never represented by `materialization-head.json` as a completed generation.

Machine recovery prefers canonical state or the last completed generation whenever the current target is incomplete.

## Incremental projection

The planner computes semantic fingerprints for global views and re-renders only changed entity notes.

Examples:

- `task.start` affects that task plus task-dependent aggregate views; unrelated decisions, research and deliverables are not uploaded;
- `research.add` writes that research note, while `DISCOVERY.md` changes only when discovery synthesis changes or referenced research titles affect it;
- unchanged `BRIEF.md` can be carried forward across unrelated task revisions with zero Dropbox write.

The writer checks destination state before overwrite, refuses unexplained edits, and uses the existing resilient Dropbox transport for transient retries.

Provider concurrency is bounded by `PROJECT_OS_PROJECTION_CONCURRENCY`; accepted values are `1..4`, default `4`.

## Hot SQLite ledger

MaterializationGuard SQLite tracks operational projection progress such as:

- latest local completed head;
- requested target;
- active target;
- per-output verified progress;
- baseline hashes;
- coalesced revisions;
- last error.

It does not store Markdown content and is not business truth.

If these hot tables are lost, Project OS rebuilds the baseline from canonical commit records and immutable external materialization records.

## Snapshot / delta completed records

Completed-generation records are compact:

- `snapshot` contains the full logical output index;
- `delta` contains only changed evidence plus removed output keys and points to its parent.

A fresh snapshot is emitted when:

- no previous completed generation exists;
- projection version changes;
- the prior chain depth is `127`.

Therefore reconstruction follows at most 128 records. Every reconstruction recomputes the logical output count and root hash and fails closed on a missing parent, cycle, or mismatch.

## Revision coalescing

Human projections are current-state views; canonical commit records are the immutable history.

If materialization head is revision 71 and revisions 72–75 commit before projection begins, Project OS may project directly to revision 75 and record 72–74 as coalesced.

All canonical commit records remain present and queryable. Coalescing removes redundant Dropbox work only; it never removes business history or effects.

An already active target is not preempted mid-write. Newer work is queued for the next safe target.

## Alarm retry and reconciliation

A committed target requests a MaterializationGuard alarm.

Transient technical materialization failures:

- preserve the canonical business result;
- keep per-output progress;
- schedule another alarm before surfacing the technical failure;
- after built-in retry count reaches 5, defer another attempt for approximately five minutes.

A permanent `MaterializationOutputConflictError` is blocked/fail-closed rather than silently overwritten.

The five-minute scheduled Worker maintenance performs both:

- transaction/artifact inbox processing;
- materialization reconciliation across registry projects.

Fleet reconciliation uses at most four projects concurrently and isolates one project's failure from the rest.

### Repair-writer admission backpressure

`PROJECT_OS_CONVERGENCE_PROJECT_MODES` defaults every project to `off`. Only an explicitly configured `repair` project makes ProjectGuard query its named MaterializationGuard before appending a new canonical commit. The internal, read-only probe fails closed with HTTP 503 `convergence_capacity_exceeded` if durable continuation is absent while work is pending, if the queue exceeds the qualified 200-output envelope, or if the oldest pending work exceeds 600 seconds. Existing durable repairs do not pass through this admission path and remain eligible to drain the queue.

This is a code-level guard, not a production activation: the notification-ACK, compatible-stable, recovery, and isolated-canary evidence remains required before any project mode changes.

## Archive flow

For a project becoming archived:

1. the business `project.archive` commit is durable first;
2. the materializer renders required archived-state outputs;
3. if the active workspace exists and archive does not, it stages under the active root and moves the workspace exactly once;
4. it verifies `STATE.md` and `HANDOFF.md` at the archive destination;
5. only then does it publish a completed generation with `workspace_location: "archive"`.

Logical output paths remain relative (`STATE.md`, `TASKS/...`) so moving the workspace does not manufacture a full-output delta.

If active and archive roots both represent conflicting realities, materialization fails closed and the head does not advance.

## Recovery cases

### Canonical revision ahead of materialization head

Normal asynchronous lag. Schedule/reconcile the newest safe target.

### Workspace upload result uncertain

Verify only the affected output against its desired hash; do not rewrite the project.

### Immutable generation exists, head missing/stale

Validate the completed record/chain and repair only the head.

### SQLite materialization state lost

Rebuild from the external completed-generation chain, then compare with the latest canonical revision and resume only missing work.

### Destination unexpectedly edited

Do not silently overwrite. Leave canonical commit valid, keep materialization head at the last proven generation, and surface the blocked output for diagnosis.

## Structured signals

Each normal materialization attempt emits one structured summary containing IDs/counters only, including:

```text
project_id
target_revision
projection_version
generation_id
source_transaction_id
source_event_id
outputs_planned
outputs_carried_forward
outputs_rendered
outputs_skipped_content_hash
outputs_uploaded
outputs_verified
retry_count
coalesced_revisions
duration_ms
final_state
```

No Markdown body, secret, Dropbox token or artifact content is logged.

These signals are the foundation for later `IMP-OBSERVE001` and `IMP-PERF001`; `IMP-MATERIAL001` does not add a metrics backend or final performance SLOs.

### Convergence incidents and monitoring acknowledgement

An exhausted, blocked, or over-600-second convergence obligation creates an immutable incident under its project convergence root before any monitoring request. Notification delivery is separately reserved with a deterministic id; a lost response is retried with that same id and cannot erase the incident.

The optional runtime adapter uses `PROJECT_OS_MONITORING_WEBHOOK_URL` and the secret `PROJECT_OS_MONITORING_WEBHOOK_TOKEN`. The endpoint must be HTTPS and return the explicit JSON acknowledgement for the submitted id. Missing configuration, a non-2xx response, malformed JSON, or a mismatched acknowledgement leaves delivery pending and schedules the durable retry. Console output alone is never an acknowledgement or a rollout proof.

Enabling these variables in a deployed environment remains a separate production action. A real endpoint ACK and its monitored recovery exercise are required before `notification_ack_proven` can be marked true.

### Deferred human-alert policy (2026-09-10)

Human-facing delivery is deliberately inactive. Missing monitoring configuration therefore leaves the immutable incident, notification reservation, retry state, and payload-free runtime metrics intact; it neither creates an acknowledgement nor changes repair behavior. A rollout review may explicitly use the `deferred` human-alert policy, under which the still-false `notification_ack_proven` field alone is non-blocking. The original `required` policy remains the default, and this exception does not waive reader, writer, fencing, transport, capacity, recovery, compatibility, or canary evidence.

On 2026-09-11 the operator authorized the single convergence writer for all projects whose canonical registry lifecycle is `active`, rather than retaining a single-project canary. The deployed allowlist is derived from the freshly read registry set PRJ-0002, PRJ-0003, PRJ-0007 and PRJ-0008. Archived projects are deliberately absent. A verified immutable current head now closes superseded human retry markers, and a requested target is cleared when its canonical revision is reached, preventing a healthy project from being kept artificially pending.

### Convergence metric envelope

Each repair slice additionally emits a fixed, payload-free metric envelope to the Worker’s structured runtime logs. Counters are `commit_observed`, `obligations_verified`, `retries`, `exhaustions`, `layer_conflicts`, `handoff_failures`, `freshness_rejections`, and `conditional_write_conflicts`; histograms are `commit_to_layer_verified` when a trustworthy publication clock exists and `tranche_duration`; gauges cover revision lag, oldest pending age, queue depth, missing alarms, fleet success age, and audit-cursor age when those owners have supplied a timestamp.

The sole fields are the authenticated project/revision/layer/projection identifiers, attempt and next-wake metadata, deployment SHA, consumed provider calls, and correlation ID. The emitter accepts neither errors, requests, provider responses, Markdown, nor business payloads, so those values cannot be included accidentally. Worker logs can be exported to a monitoring system, but remain distinct from the HTTPS acknowledgement channel above.

## 2026-09-09 local qualification boundary

The permanent-convergence implementation at `00250b623ee88bdcbed71252223b4adaee179c17` passed the local 193-file / 935-test suite, including the 26-file / 148-test persistence high-risk gate. The same SHA passed the synthetic revision-258/capacity selection and a 1,673.38 KiB (282.11 KiB gzip) direct Wrangler dry-run that exited before upload. This proves bounded continuation, replay, critical-pair fencing, durable incident delivery state, read-only observation, and synthetic capacity behavior in the test runtime. It does not make a production projection current by itself: the isolated 24-hour canary, real provider latency measurements, monitoring ACK exercise, and authorised activation remain separate gates. No canonical Dropbox materialization or PRJ-0003 repair was performed during this qualification.

The follow-up regression on `3bbf7d2102dffeca834368cc8c5336840a2f8fda` exhausts all six durable retries of the revision-258 synthetic critical pair. It proves that the revision-257 head and receipt survive the outage, the durable incident is opened, and a later scheduled recovery alone advances the verified pair and head to 258 without creating revision 259. The local full suite passed 193 files / 936 tests; this remains a fictitious `PRJ-9258` proof, never a mutation of PRJ-0003.

The final local code gate at `b7bca495c4805256db49b8db937d4b4ffc133176` adds the explicit repair-writer capacity refusal and the synthetic 263→264 intermediate-derivative regression. It passed 201 files / 971 tests and a direct bundle-only Wrangler dry-run. The capacity probe is internal and read-only; no project mode or external state changed. The result is not a canary, monitoring-ACK, or production-repair proof.

The follow-up implementation SHA `d63578252e7d64329540ce001ad0dc908d906454` keeps the monitoring receiver within its five-second bound even when its HTTP response arrives but its acknowledgement body stalls. The test was red before the fix and the full local suite then passed 201 files / 972 tests, with the same 26-file / 148-test persistence gate and a bundle-only Wrangler dry-run. No monitoring endpoint was configured or acknowledged in production.

## 2026-09-10 production canary observation

Worker version `7e624e43-d288-4cf5-97bd-cbc43c11aa33` is an isolated writer canary for synthetic PRJ-0008 only. A real authenticated materialization request returned revision 2 as materialized, with its durable head at projection version 3 and a verified human handoff. The response is based on durable target evidence rather than requiring a second unbounded provider scan: the separate diagnostic reader intentionally remains bounded and reports `unknown` when it cannot finish a fresh observation inside its read-only slice.

This version also restored the read-only historical-snapshot admission path: PRJ-0003's authenticated mutation context reads canonical revision 267. It makes no mutation and does not authorize ProjectGuard to repair that project. The canary must run for the separately recorded 24-hour qualification period before any project extension. Human alert delivery is deferred only as documented above; it does not disable incident records, retry reservations, or structured metrics.

## User experience

No normal user command is introduced.

Do not require `SYNC`, `MATERIALIZE`, `REFRESH`, retries, generation selection or projection-version selection. The normal interaction remains natural language plus the existing receipt gate for durable business writes.

## Workstation boundary

Project OS does not require direct access to the user's computer, a local bridge, global filesystem permissions or a desktop daemon.

Dropbox is the current external persistence provider. Dropbox Desktop may optionally synchronize `PROJECT_OS/WORKSPACE` to a computer for Obsidian, but that computer is not part of the correctness path.
