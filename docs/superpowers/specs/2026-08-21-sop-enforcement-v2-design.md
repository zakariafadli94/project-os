# SOP Enforcement V2 — Architecture Design

Status: design approved in principle by the user; implementation not started
Date: 2026-08-21
Canonical decision: `DEC-SOPENF002` (pending receipt at time this spec was first written)
Related SOP decision: `DEC-SOPS001`

## 1. Purpose

Project OS already materializes human-readable `BRIEF.md`, `DISCOVERY.md`, and `ROADMAP.md` views and now renders Roadmap using the adopted `Current / Next / Later` model. The second stress test demonstrated that the remaining Brief, Discovery, and Deliverable mismatches cannot be corrected safely in renderers alone because the current canonical `ProjectState` does not contain the concepts required by the adopted SOPs.

SOP Enforcement V2 extends the canonical model so the SOP can be represented directly and mechanically. The goal is not to make Project OS more complicated for the user. The goal is to make the machine layer precise enough that the simple human Markdown layer is truthful.

The central rule is:

> Renderers may summarize canonical concepts, but they must not invent one canonical concept by deriving it from a different concept.

Examples of derivations that this design removes:

- active phase ≠ project scope;
- deliverables ≠ success criteria;
- blocked tasks ≠ unresolved discovery questions;
- phase next actions ≠ discovery exploration;
- completed deliverable ≠ user-accepted deliverable.

## 2. Stress-test findings that drive this design

The current implementation exposes three confirmed semantic defects.

### 2.1 Brief conflates framing with execution

Current `renderBrief()` sets `Current scope` from `current_phase_id` and sets `Success signals` from tracked deliverables. This violates SOP 01 because the Brief is supposed to contain current accepted framing, not the active execution phase or output inventory.

### 2.2 Discovery is derived from unrelated operational state

Current `renderDiscovery()` uses:

- project objective as `Current understanding`;
- all research records as `Research and learnings`;
- accepted decisions as `Decisions shaping direction`;
- blocked tasks as `Unresolved issues`;
- phase `next_actions` or pending tasks as `Explore next`.

These are useful neighboring signals but they are not a discovery synthesis. The SOP requires a concise layer that distinguishes confirmed findings, provisional findings, unresolved questions, and next exploration while keeping evidence in `RESEARCH/`.

### 2.3 Deliverables cannot represent the adopted lifecycle

The current model supports only `pending` and `completed`. It has no explicit review state, acceptance event, version, supersession, abandonment, or acceptance evidence. Therefore the software cannot enforce the SOP rule that acceptance must never be inferred from silence or file creation.

## 3. Goals

SOP Enforcement V2 MUST:

1. represent stable/current project framing explicitly;
2. represent discovery synthesis explicitly and separately from research evidence;
3. represent the normative deliverable lifecycle explicitly;
4. retain explicit user acceptance as the gate for accepted deliverables;
5. preserve old projects, old decisions, old events, and existing project IDs/revisions;
6. avoid a destructive migration or historical rewrite;
7. keep Project Guard serialization, receipt gating, idempotency, and conflict rules intact;
8. keep the Markdown-first portability model intact;
9. keep current `BRIEF → DISCOVERY → ROADMAP` human navigation simple;
10. remain deterministic when the same canonical state is re-materialized.

## 4. Non-goals

This change does NOT:

- redesign tasks or phases beyond what is necessary to reference them;
- change project lifecycle rules;
- change decision history semantics;
- introduce free-form canonical file editing;
- move canonical authority from Project Guard to Markdown;
- infer user acceptance automatically;
- delete or rewrite old events;
- require old projects to be manually migrated before they remain usable;
- create a new database service;
- change Dropbox layout mode or Durable Object bindings;
- make chat history authoritative.

## 5. Canonical model extensions

### 5.1 Project framing

Add an explicit `framing` object to `ProjectState`:

```ts
interface ProjectFraming {
  scope: string[];
  out_of_scope: string[];
  success_criteria: string[];
  stakeholders: string[];
  open_questions: string[];
}
```

`objective` remains a first-class project field because it already exists and is widely consumed. The framing transaction may update the objective as well as the `framing` object.

Why arrays rather than one free-form Markdown body:

- renderers can remain deterministic;
- LLMs can distinguish concepts mechanically;
- empty/unknown sections remain explicit;
- later views can reuse individual fields without parsing prose.

Unknown values remain empty arrays. Project OS MUST NOT invent values merely to fill a section.

### 5.2 Discovery synthesis

Add an explicit `discovery` object:

```ts
interface DiscoveryFinding {
  summary: string;
  research_ids: string[];
}

interface DiscoverySynthesis {
  confirmed_findings: DiscoveryFinding[];
  provisional_findings: DiscoveryFinding[];
  unresolved_questions: string[];
  next_exploration: string[];
}
```

`research_ids` are optional at the transaction level and normalize to `[]`. A synthesis finding may exist without a research link when it is derived from accepted internal project facts, but the LLM should attach research IDs whenever evidence exists in `RESEARCH/`.

Discovery is intentionally current synthesis, not historical evidence. Updating the synthesis may replace previous synthesis entries. Historical evidence remains in immutable research records and the Project OS event ledger records the synthesis update transaction itself.

### 5.3 Deliverable lifecycle

The normative new lifecycle is:

```text
planned → in_progress → review → accepted
```

Terminal alternatives:

```text
superseded
abandoned
```

For safe migration, add one internal compatibility status:

```text
legacy_completed
```

`legacy_completed` is NOT a normal new-project state. It exists only to preserve old `completed` records without falsely claiming that the user explicitly accepted them.

New deliverable model:

```ts
type DeliverableStatus =
  | "planned"
  | "in_progress"
  | "review"
  | "accepted"
  | "superseded"
  | "abandoned"
  | "legacy_completed";

interface DeliverableRecord {
  deliverable_id: string;
  title: string;
  description?: string;
  reference?: string;
  outcome?: string;
  owner?: string;
  version?: string;
  phase_id?: string;
  decision_ids: string[];
  status: DeliverableStatus;
  acceptance_note?: string;
  accepted_at?: string;
  supersedes?: string;
  superseded_by?: string;
  superseded_reason?: string;
  abandoned_reason?: string;
  created_at: string;
  updated_at: string;
}
```

For newly created V2 deliverables, `version` is required by the new creation transaction. It remains optional in the TypeScript record only to load historical records safely.

## 6. Typed transaction design

Transaction schema version remains `1.0` in this phase. The operation set is extended with new discriminants. This is a backwards-compatible protocol extension; changing transaction envelope version is a separate migration and is not required to solve the semantic defects.

### 6.1 Project framing

Add:

```text
project.framing.update
```

Payload:

```ts
{
  objective?: string;
  scope?: string[];
  out_of_scope?: string[];
  success_criteria?: string[];
  stakeholders?: string[];
  open_questions?: string[];
}
```

At least one field is required. Array fields use replacement semantics, not append semantics. Replacement is deliberate because this layer represents current framing rather than history. The event ledger preserves historical changes.

This operation requires the exact current project revision because it can change project direction and binding framing.

### 6.2 Discovery synthesis

Add:

```text
discovery.synthesis.update
```

Payload fields are optional full replacements:

```ts
{
  confirmed_findings?: Array<{ summary: string; research_ids?: string[] }>;
  provisional_findings?: Array<{ summary: string; research_ids?: string[] }>;
  unresolved_questions?: string[];
  next_exploration?: string[];
}
```

At least one field is required. Referenced research IDs MUST exist in the current project state. This operation requires the exact current revision because two competing syntheses should not silently overwrite each other.

### 6.3 Deliverable creation and lifecycle

Retain legacy `deliverable.add` and `deliverable.complete` parsing for backwards compatibility, but mark them deprecated in code comments/docs and do not use them in new SOP-driven flows.

Add normative operations:

```text
deliverable.create
deliverable.start
deliverable.revise
deliverable.submit_review
deliverable.accept
deliverable.supersede
deliverable.abandon
```

`deliverable.create` payload:

```ts
{
  deliverable_id: string;
  title: string;
  version: string;
  description?: string;
  reference?: string;
  owner?: string;
  phase_id?: string;
  decision_ids?: string[];
  supersedes?: string;
}
```

Creation produces `planned`. Referenced phase/decisions/replacement IDs must exist.

`deliverable.start` moves `planned → in_progress`.

`deliverable.revise` is allowed from `in_progress` or `review`, requires a new non-empty `version`, may update `description` and `reference`, and ends in `in_progress`. It gives review feedback a deterministic way to return to active production without inventing a new deliverable ID.

`deliverable.submit_review` moves `in_progress → review`.

`deliverable.accept` moves `review → accepted`. It requires a non-empty `acceptance_note`. Project OS cannot cryptographically prove that the user personally approved the deliverable, but requiring a dedicated accept transaction plus acceptance note prevents acceptance from being inferred from file creation or task completion. The assistant SOP remains responsible for emitting this transaction only after explicit user acceptance.

`deliverable.supersede` requires both original and replacement deliverables to exist and be `accepted`. It moves the original `accepted → superseded`, sets reciprocal linkage, preserves both records, and stores a non-empty reason.

`deliverable.abandon` is allowed from `planned`, `in_progress`, `review`, or `legacy_completed`; it requires a non-empty reason. Accepted deliverables cannot be abandoned; they must be superseded to preserve the accepted historical record.

All deliverable lifecycle transitions require the exact current project revision. `deliverable.create` may remain compatible with current additive stale-write rules if its ID is unique and all referenced entities still exist; however the implementation plan should prefer exact-revision handling if that simplifies deterministic cross-reference validation.

### 6.4 Legacy deliverable operations

Compatibility behavior:

- historical record status `pending` normalizes to `planned`;
- historical record status `completed` normalizes to `legacy_completed`;
- deprecated `deliverable.add` creates a `planned` record with no invented version;
- deprecated `deliverable.complete` moves a non-terminal legacy/new record to `legacy_completed`, never to `accepted`.

This preserves old API/event behavior without violating the new rule that acceptance is explicit.

## 7. State normalization and migration safety

Current `ProjectGuard.loadState()` performs a raw `JSON.parse(... as ProjectState)`. Existing Durable Object rows therefore lack the new fields and may contain old deliverable statuses.

Introduce a pure deterministic function:

```ts
normalizeProjectState(input: unknown): ProjectState
```

and call it from `ProjectGuard.loadState()` after parsing stored JSON.

Normalization rules:

1. missing `framing` becomes all-empty arrays;
2. missing `discovery` becomes all-empty arrays;
3. missing `decision_ids` on deliverables becomes `[]`;
4. old `pending` deliverables become `planned` in memory;
5. old `completed` deliverables become `legacy_completed` in memory;
6. optional new deliverable metadata remains undefined when absent;
7. no project revision is changed by normalization;
8. no domain event is emitted by normalization;
9. no accepted state is inferred;
10. normalization is idempotent.

The normalizer should accept only the known legacy/current shape needed for Project OS. It must not become a permissive arbitrary-object cast.

The current state `schema_version` remains `1.0` for this implementation to avoid coupling semantic enforcement to a separate state-envelope migration. A future explicit schema-version migration may bump it after the new model is proven in production.

### Persistence behavior

Normalization is in-memory on read. A subsequent legitimate committed transaction persists the normalized state through the existing `persistCommit()` path. Pure materialization may render normalized views without incrementing business revision.

This is acceptable because normalization changes representation, not project business facts. The compatibility status `legacy_completed` explicitly prevents representation normalization from inventing acceptance.

## 8. Transition and concurrency rules

Add to exact-revision operations:

```text
project.framing.update
discovery.synthesis.update
deliverable.start
deliverable.revise
deliverable.submit_review
deliverable.accept
deliverable.supersede
deliverable.abandon
```

Reason: these operations alter a current synthesis or transition a singleton entity lifecycle. Stale competing writes should conflict rather than silently win.

Existing Project Guard serialization, idempotency by transaction ID, receipt publication order, and conflict semantics remain unchanged.

No new semantic auto-merge is introduced.

## 9. Renderer contract

### 9.1 BRIEF.md

`BRIEF.md` MUST render project framing, never execution state as a substitute.

Target sections:

```text
# Brief — <project>

## Purpose
<objective>

## Scope
<framing.scope>

## Out of scope
<framing.out_of_scope>

## Boundaries
<constraints>

## Stakeholders
<framing.stakeholders>

## Success criteria
<framing.success_criteria>

## Open questions
<framing.open_questions>
```

The active phase and deliverables do not belong in these sections.

Sparse project behavior remains explicit: `Not yet defined` / equivalent messages, never invented content.

### 9.2 DISCOVERY.md

Target sections:

```text
# Discovery — <project>

## Confirmed findings
<confirmed_findings + research links>

## Provisional findings
<provisional_findings + research links>

## Unresolved questions
<discovery.unresolved_questions>

## Explore next
<discovery.next_exploration>

## Decisions shaping direction
<accepted decision links>
```

Research records are linked from synthesized findings. The renderer should not dump every research record merely because it exists.

Blocked tasks belong to State/Roadmap, not Discovery unless a real unresolved discovery question is explicitly recorded.

### 9.3 ROADMAP.md

Keep the already validated structure:

```text
Current
  Active work
  Blocked
Next
Later
Completed
Deliverables
```

No semantic change is required in this phase except adapting deliverable status labels to the richer lifecycle.

### 9.4 Deliverable notes

Each deliverable note MUST expose at minimum:

```text
Deliverable ID
Status
Version
Owner (when present)
Phase (when present)
Related decisions
Created
Updated
Acceptance note / accepted_at when accepted
Supersession linkage/reason when superseded
Abandonment reason when abandoned
Reference
Description
Outcome
```

For `legacy_completed`, render a clear compatibility warning such as:

```text
Status: legacy_completed
Acceptance: not inferred; explicit acceptance was not recorded in the legacy model.
```

## 10. Human/LLM behavior

The SOP suite remains the method source of truth. The code supplies deterministic guardrails, not replacement judgment.

The assistant MUST continue to distinguish:

```text
fact → research finding → recommendation → explicit acceptance → decision
```

Similarly, a deliverable reaches `accepted` only after explicit user acceptance and an explicit `deliverable.accept` transaction.

Project framing updates are directional. The assistant should not persist a speculative recommendation into framing before acceptance.

Discovery synthesis may be updated autonomously when it is a faithful synthesis of already accepted/recorded facts and research, but material interpretation changes that alter direction still follow the knowledge/decision SOP.

## 11. Backward compatibility

Existing projects MUST continue to load with no manual migration.

Compatibility acceptance criteria:

- PRJ-0001 through PRJ-0004 load successfully;
- their current revisions do not change merely because new code is deployed;
- old decisions/tasks/research/events remain readable;
- old `pending` deliverables render as planned-compatible state;
- old `completed` deliverables do not silently render as accepted;
- a pure `/materialize` call does not create a business event;
- old transaction IDs remain idempotent;
- legacy transaction operation parsing remains available where required for replay/in-flight compatibility.

## 12. Test strategy

Implementation MUST use TDD.

### 12.1 Normalization tests

Start with failing tests for:

- missing framing/discovery defaults;
- pending → planned;
- completed → legacy_completed;
- idempotent normalization;
- preservation of revision/event IDs;
- rejection of malformed state where current code previously relied on unsafe casting.

### 12.2 Transaction schema tests

Failing tests for each new operation and strict payload shape, including research/phase/decision references and required acceptance/reason fields.

### 12.3 Transition tests

Cover:

- framing replacement semantics;
- discovery replacement semantics;
- exact-revision conflicts;
- full deliverable happy path;
- revise from review;
- invalid lifecycle transitions;
- acceptance only from review;
- supersession preserving both deliverables;
- abandonment terminal behavior;
- legacy operation compatibility.

### 12.4 Renderer tests

Explicitly prove that:

- Brief scope does not equal current phase;
- Brief success criteria do not equal deliverables;
- Discovery questions do not equal blockers;
- Discovery exploration does not equal phase actions unless explicitly recorded in discovery;
- Roadmap retains Current / Next / Later;
- accepted/legacy/superseded deliverable metadata is unambiguous.

### 12.5 Integration tests

Verify Project Guard:

- normalizes stored legacy state on load;
- persists normalized state only through legitimate commit flow;
- preserves idempotency;
- preserves receipt-last behavior;
- materializes deterministic Markdown;
- does not increment revision for pure materialization.

## 13. Rollout

Rollout sequence:

1. implement on isolated feature branch using TDD;
2. run full `npm run check`;
3. run `npx wrangler deploy --dry-run`;
4. review PR diff against this spec and `DEC-SOPENF002`;
5. merge only when CI is green;
6. rely on the existing Cloudflare Workers Builds Git integration as the production deployment path;
7. confirm Cloudflare deployment success from the GitHub bot/status;
8. verify `/health` when accessible;
9. pure-materialize existing test projects where appropriate;
10. replay dedicated PRJ-0004 stress-test scenarios with explicit framing/discovery/deliverable data;
11. run Markdown-only clean-room resume;
12. only then consider the SOP enforcement layer validated for final adoption.

The redundant GitHub Actions `deploy.yml` introduced during troubleshooting is not part of the production deployment architecture because it lacks Cloudflare credentials and the existing Workers Builds integration already owns deployment. Removing or disabling that redundant workflow should be handled as a small cleanup change alongside implementation or immediately before merge, provided Cloudflare Workers Builds remains verified.

## 14. Failure and rollback behavior

If new code fails before commit, existing Project Guard state remains untouched.

If production rendering is wrong but canonical transitions are correct, rollback the Worker to the previous known-good code while preserving state.

If normalization reveals an unexpected legacy shape, reject/diagnose it rather than silently fabricating defaults beyond the explicitly supported compatibility rules.

Never delete legacy Dropbox history as part of this rollout.

## 15. Acceptance criteria

SOP Enforcement V2 is complete only when all of the following are demonstrated:

1. Brief renders true framing and never substitutes phase/deliverables for scope/success criteria.
2. Discovery renders explicit synthesis and never substitutes objective/blockers/tasks for discovery concepts.
3. New deliverables follow planned → in_progress → review → accepted.
4. Acceptance is represented only by explicit `deliverable.accept`.
5. Superseded and abandoned deliverables preserve history.
6. Legacy completed deliverables do not become accepted implicitly.
7. Existing projects load without manual migration or revision increments.
8. New transactions remain receipt-gated and idempotent.
9. Roadmap remains Current / Next / Later.
10. PRJ-0004 passes the second stress test.
11. A fresh LLM can reconstruct objective, framing, current learning, current direction, accepted decisions, deliverables, blockers, and next meaningful action from Markdown/SOP artifacts without prior chat.
12. Project OS remains reconstructable without hidden scripts or proprietary-only knowledge.

## 16. Design decision summary

The implementation should extend canonical concepts first and renderers second.

Do not solve these defects by writing smarter prose in `brief.ts` or `discovery.ts`. Without explicit canonical fields, such prose would still be inference presented as fact.

The intended architecture is therefore:

```text
Accepted project framing ─┐
Research + synthesis ─────┼─> ProjectState ─> deterministic Markdown views
Accepted decisions ───────┤
Roadmap/tasks ─────────────┤
Deliverable lifecycle ─────┘

All durable changes
      ↓
typed transactions
      ↓
Project Guard validation + serialization
      ↓
immutable event + state + receipt
```

That preserves the core Project OS invariant: **simple human views are generated from explicit guarded state, not from hidden model inference.**
