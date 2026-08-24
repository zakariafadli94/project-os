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

If immediate scheduling fails after the commit record exists, the commit remains valid. The ProjectGuard alarm and the five-minute fleet reconciliation cron can reconstruct the pending target later.

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

The current projection version begins at `1`.

A renderer/projection change can bump the projection version and rematerialize the current canonical revision without creating a domain event or fake business revision.

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

ProjectGuard SQLite tracks operational projection progress such as:

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

A committed target requests a ProjectGuard alarm.

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

## User experience

No normal user command is introduced.

Do not require `SYNC`, `MATERIALIZE`, `REFRESH`, retries, generation selection or projection-version selection. The normal interaction remains natural language plus the existing receipt gate for durable business writes.

## Workstation boundary

Project OS does not require direct access to the user's computer, a local bridge, global filesystem permissions or a desktop daemon.

Dropbox is the current external persistence provider. Dropbox Desktop may optionally synchronize `PROJECT_OS/WORKSPACE` to a computer for Obsidian, but that computer is not part of the correctness path.
