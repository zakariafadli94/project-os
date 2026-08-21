# SOP Enforcement V2 — Architecture Design

Status: design approved in principle; implementation not started
Date: 2026-08-21
Canonical decision: `DEC-SOPENF002` — committed in PRJ-0002 revision 31 / event `EVT-000031`
Related SOP decision: `DEC-SOPS001`

## 1. Purpose

Project OS already materializes human-readable `BRIEF.md`, `DISCOVERY.md`, and `ROADMAP.md` views. The second stress test proved that Roadmap can now be enforced mechanically with `Current / Next / Later`, but the remaining Brief, Discovery, and Deliverable mismatches cannot be solved safely inside renderers because the canonical `ProjectState` does not contain the concepts required by the adopted SOPs.

SOP Enforcement V2 extends the canonical model so the SOP can be represented directly and mechanically. The goal is not a more complicated user experience. The goal is a precise machine layer that can generate simple, truthful Markdown.

Core rule:

> Renderers may summarize canonical concepts, but they must not invent one canonical concept by deriving it from a different concept.

Invalid substitutions this design removes:

- active phase ≠ project scope;
- deliverables ≠ success criteria;
- blocked tasks ≠ unresolved discovery questions;
- phase next actions ≠ discovery exploration;
- completed deliverable ≠ explicitly accepted deliverable.

## 2. Confirmed stress-test defects

### 2.1 Brief conflates framing with execution

Current `renderBrief()` derives `Current scope` from `current_phase_id` and `Success signals` from deliverables. The Brief is supposed to contain current accepted framing, not active execution state or output inventory.

### 2.2 Discovery is derived from unrelated operational state

Current `renderDiscovery()` derives:

- current understanding from project objective;
- research and learnings from the complete research list;
- unresolved issues from blocked tasks;
- next exploration from phase actions or pending tasks.

These are neighboring signals, not discovery synthesis. The SOP requires explicit confirmed findings, provisional findings, unresolved knowledge questions, and next exploration while keeping detailed evidence in `RESEARCH/`.

### 2.3 Deliverables cannot represent the SOP lifecycle

The current model supports only `pending` and `completed`. It cannot represent production, review, explicit acceptance, versioning, supersession, abandonment, or acceptance evidence.

## 3. Goals

SOP Enforcement V2 MUST:

1. represent stable/current project framing explicitly;
2. represent discovery synthesis explicitly and separately from research evidence;
3. represent the normative deliverable lifecycle explicitly;
4. retain explicit user acceptance as the gate for accepted deliverables;
5. preserve existing project IDs, revisions, decisions, research, tasks, events, and receipts;
6. avoid destructive migration and historical rewriting;
7. preserve Project Guard serialization, idempotency, conflict behavior, and receipt gating;
8. keep the Markdown-first portability model;
9. keep `BRIEF → DISCOVERY → ROADMAP` as the primary human reading path;
10. remain deterministic under re-materialization.

## 4. Non-goals

This change does NOT:

- redesign project lifecycle;
- redesign decisions or tasks beyond necessary references;
- introduce direct canonical Markdown editing;
- infer acceptance automatically;
- delete legacy data;
- change Dropbox layout mode or Durable Object bindings;
- require manual migration before existing projects can load;
- change chat/history authority rules;
- introduce a new database.

## 5. Canonical model extensions

### 5.1 Project framing

Add:

```ts
interface ProjectFraming {
  scope: string[];
  out_of_scope: string[];
  success_criteria: string[];
  stakeholders: string[];
  open_questions: string[];
}
```

`objective` remains a first-class field and may be updated by the framing transaction.

Semantics:

- `scope`: what is included in the accepted project framing;
- `out_of_scope`: explicit exclusions;
- `success_criteria`: conditions that define success, not outputs merely produced;
- `stakeholders`: parties materially relevant to project framing;
- `open_questions`: framing/business unknowns that affect scope, objectives, constraints, or success.

`open_questions` is intentionally distinct from Discovery `unresolved_questions`: Brief questions concern project framing; Discovery questions concern knowledge still being investigated.

Unknown values remain empty arrays. The system MUST NOT invent values to make a document look complete.

### 5.2 Discovery synthesis

Add:

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

`research_ids` normalize to `[]` when omitted. When a finding is supported by a canonical research record, the synthesis should link it. Discovery remains current synthesis; detailed evidence stays in `RESEARCH/`.

Replacing a synthesis entry does not erase evidence history because research records remain durable and the event ledger preserves each synthesis-update transaction.

### 5.3 Deliverable lifecycle

Normative lifecycle:

```text
planned → in_progress → review → accepted
```

Terminal alternatives:

```text
superseded
abandoned
```

Migration-only compatibility status:

```text
legacy_completed
```

`legacy_completed` exists only so old `completed` records do not silently become `accepted`.

New record shape:

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
  superseded_by?: string;
  superseded_reason?: string;
  abandoned_reason?: string;
  created_at: string;
  updated_at: string;
}
```

`version` is required for new V2 deliverables but optional in the record type so legacy records can load without invented values.

## 6. Typed transaction design

The transaction envelope remains schema version `1.0`. This phase extends the operation discriminants without coupling the work to a separate protocol-version migration.

### 6.1 `project.framing.update`

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

At least one field is required. Arrays use replacement semantics because framing represents current accepted truth. The event ledger preserves prior framing changes.

This is an exact-revision operation.

### 6.2 `discovery.synthesis.update`

Payload:

```ts
{
  confirmed_findings?: Array<{ summary: string; research_ids?: string[] }>;
  provisional_findings?: Array<{ summary: string; research_ids?: string[] }>;
  unresolved_questions?: string[];
  next_exploration?: string[];
}
```

At least one field is required. Referenced research IDs MUST exist. This is an exact-revision operation so competing syntheses cannot silently overwrite each other.

### 6.3 Normative deliverable operations

Retain legacy `deliverable.add` and `deliverable.complete` parsing for compatibility, but mark them deprecated and exclude them from new SOP-driven flows.

Add:

```text
deliverable.create
deliverable.start
deliverable.revise
deliverable.submit_review
deliverable.accept
deliverable.supersede
deliverable.abandon
```

#### `deliverable.create`

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
}
```

Creates `planned`. Referenced phase and decisions must exist.

A new deliverable does NOT declare that it supersedes another deliverable at creation time. Supersession is established only through the dedicated `deliverable.supersede` transaction after both records are accepted. This prevents premature historical relationships.

#### `deliverable.start`

`planned → in_progress`.

#### `deliverable.revise`

Allowed from `in_progress` or `review`. Requires a new version value different from the current one, may update `description` and `reference`, and ends in `in_progress`. No semantic-version ordering is inferred; the guard only requires a non-empty changed version string.

#### `deliverable.submit_review`

`in_progress → review`.

#### `deliverable.accept`

Allowed from:

```text
review → accepted
legacy_completed → accepted
```

Both paths require a non-empty `acceptance_note` and exact current revision.

The `legacy_completed → accepted` path is the only safe way to retroactively accept a historical completed deliverable. It requires an explicit new acceptance transaction; deployment or normalization alone can never perform this conversion.

#### `deliverable.supersede`

Requires original and replacement records to both exist and both be `accepted`. It moves the original `accepted → superseded`, writes `superseded_by` and `superseded_reason` on the original, and preserves the replacement as accepted current output. No accepted record is deleted.

#### `deliverable.abandon`

Allowed from `planned`, `in_progress`, `review`, or `legacy_completed`. Requires a reason. Accepted deliverables cannot be abandoned; they must be superseded to preserve accepted history.

All lifecycle transitions are exact-revision operations. `deliverable.create` may be additive, but the implementation should prefer exact revision if that materially simplifies deterministic cross-reference validation.

### 6.4 Legacy operation behavior

Compatibility rules:

- historical `pending` normalizes to `planned`;
- historical `completed` normalizes to `legacy_completed`;
- deprecated `deliverable.add` creates `planned` with no invented version;
- deprecated `deliverable.complete` moves a non-terminal record to `legacy_completed`, never to `accepted`.

## 7. State normalization and migration safety

Current `ProjectGuard.loadState()` performs a raw JSON parse/cast. Introduce a pure deterministic normalizer:

```ts
normalizeProjectState(input: unknown): ProjectState
```

and call it from `ProjectGuard.loadState()`.

Normalization rules:

1. missing `framing` → empty framing arrays;
2. missing `discovery` → empty discovery arrays;
3. missing deliverable `decision_ids` → `[]`;
4. old `pending` → `planned` in memory;
5. old `completed` → `legacy_completed` in memory;
6. new optional metadata remains undefined if absent;
7. project revision is unchanged;
8. no domain event is created;
9. acceptance is never inferred;
10. normalization is idempotent;
11. malformed state outside explicitly supported legacy/current shapes is rejected rather than silently coerced.

The state envelope stays `schema_version: "1.0"` during this rollout to avoid coupling semantic enforcement to a separate envelope migration. A future explicit state-schema migration may bump it after this model is proven.

Normalization is in-memory on load. A later legitimate committed transaction persists the normalized state via the existing commit path. Pure materialization may render normalized views without changing business revision.

## 8. Transition and concurrency rules

Add exact-revision requirements for:

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

Reason: each operation changes current synthesis, framing, or a singleton lifecycle state. Stale competing writes should conflict.

Existing Project Guard serialization, transaction-ID idempotency, terminal receipts, and receipt-last persistence remain unchanged.

## 9. Renderer contract

### 9.1 `BRIEF.md`

Target structure:

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

Active phase and deliverables MUST NOT be substituted into these sections.

Sparse project output remains explicit: undefined sections say they are not yet defined rather than inventing facts.

### 9.2 `DISCOVERY.md`

Target structure:

```text
# Discovery — <project>

## Confirmed findings
<confirmed findings + research links>

## Provisional findings
<provisional findings + research links>

## Unresolved questions
<discovery.unresolved_questions>

## Explore next
<discovery.next_exploration>

## Decisions shaping direction
<accepted decision links>
```

The renderer does not dump all research records merely because they exist. Blocked tasks belong to State/Roadmap unless an explicit discovery question records the underlying knowledge uncertainty.

### 9.3 `ROADMAP.md`

Keep the validated model:

```text
Current
  Active work
  Blocked
Next
Later
Completed
Deliverables
```

Only deliverable status labels need adaptation to the richer lifecycle.

### 9.4 Deliverable notes

Expose at minimum:

```text
Deliverable ID
Status
Version
Owner (when present)
Phase (when present)
Related decisions
Created
Updated
Acceptance note and accepted_at when accepted
Supersession linkage/reason when superseded
Abandonment reason when abandoned
Reference
Description
Outcome
```

For historical completed records:

```text
Status: legacy_completed
Acceptance: not inferred; explicit acceptance was not recorded in the legacy model.
```

## 10. Human/LLM behavior

The SOP remains the method source of truth. Code supplies deterministic guardrails, not replacement judgment.

Project framing updates are directional. A speculative recommendation must not be written into framing before user acceptance when it materially changes direction.

Discovery synthesis can be refreshed autonomously when it faithfully summarizes already canonical facts/research and does not create a new business-direction decision.

Deliverable acceptance remains explicit: the assistant emits `deliverable.accept` only after user acceptance. A file, completed task, or legacy `completed` status is not acceptance evidence.

## 11. Backward compatibility

Existing projects MUST load without manual migration.

Acceptance criteria:

- PRJ-0001 through PRJ-0004 load successfully;
- deployment/normalization alone does not increment revisions;
- old events, decisions, tasks, and research remain intact;
- pending deliverables become planned-compatible in memory;
- completed deliverables become `legacy_completed`, not accepted;
- `legacy_completed` may become accepted only through explicit `deliverable.accept`;
- pure `/materialize` creates no business event;
- old transaction IDs remain idempotent;
- legacy operations remain parseable for replay/in-flight compatibility.

## 12. TDD strategy

Implementation MUST use failing tests first.

### 12.1 Normalization

Test:

- missing framing/discovery defaults;
- pending → planned;
- completed → legacy_completed;
- idempotent normalization;
- preservation of revision/event ID;
- malformed-state rejection.

### 12.2 Transaction schema

Test strict payloads for every new operation, including required acceptance/reason fields and reference validation expectations.

### 12.3 Transitions

Test:

- framing replacement semantics;
- discovery replacement semantics;
- exact-revision conflicts;
- full planned → in_progress → review → accepted path;
- legacy_completed → accepted with explicit acceptance note;
- revise from review;
- invalid transitions;
- supersession preserving both records;
- abandonment terminal behavior;
- legacy operation compatibility.

### 12.4 Renderers

Prove explicitly:

- Brief scope does not equal current phase;
- Brief success criteria do not equal deliverables;
- Brief framing questions and discovery questions are distinct;
- Discovery unresolved questions do not equal blockers;
- Discovery exploration does not equal phase actions unless explicitly recorded;
- Roadmap remains Current / Next / Later;
- legacy/accepted/superseded deliverable states render unambiguously.

### 12.5 Project Guard integration

Verify:

- legacy state normalization on load;
- normalized state persists only through legitimate commit flow;
- idempotency remains intact;
- receipt-last behavior remains intact;
- pure materialization does not increment revision;
- generated Markdown is deterministic.

## 13. Rollout

1. implement on an isolated feature branch with TDD;
2. run full `npm run check`;
3. run `npx wrangler deploy --dry-run`;
4. review diff against this spec and `DEC-SOPENF002`;
5. merge only when CI is green;
6. use the existing Cloudflare Workers Builds Git integration as production deployment path;
7. confirm Cloudflare deployment success via its GitHub status/comment;
8. verify Worker health when accessible;
9. materialize existing test projects where appropriate;
10. replay PRJ-0004 with explicit framing, discovery, and deliverable lifecycle data;
11. run Markdown-only clean-room resume;
12. only then consider SOP Enforcement V2 validated.

The troubleshooting-only `.github/workflows/deploy.yml` is not part of the production deployment architecture because it lacks Cloudflare credentials and Workers Builds already owns deployment. Remove or disable it as a bounded cleanup during implementation so routine pushes do not create misleading deployment failures.

## 14. Failure and rollback

If new code fails before commit, canonical Project Guard state is untouched.

If production rendering is wrong while canonical state remains valid, rollback Worker code to the prior known-good revision; do not rewrite state to match a renderer bug.

If normalization encounters an unsupported legacy shape, diagnose/reject it rather than inventing values.

Never delete legacy Dropbox history during this rollout.

## 15. Completion criteria

SOP Enforcement V2 is complete only when:

1. Brief renders true framing and never substitutes phase/deliverables for scope/success;
2. Discovery renders explicit synthesis and never substitutes objective/blockers/tasks;
3. new deliverables follow planned → in_progress → review → accepted;
4. acceptance exists only through explicit `deliverable.accept`;
5. historical completed deliverables remain non-accepted until explicitly accepted;
6. superseded/abandoned deliverables preserve history;
7. existing projects load without manual migration or revision increment;
8. new transactions remain receipt-gated and idempotent;
9. Roadmap remains Current / Next / Later;
10. PRJ-0004 passes the second stress test;
11. a fresh LLM can reconstruct objective, framing, current learning, current direction, decisions, deliverables, blockers, and next meaningful action from Markdown/SOP artifacts without prior chat;
12. Project OS remains reconstructable without hidden scripts or proprietary-only knowledge.

## 16. Architecture summary

The correct ordering is canonical concepts first, renderers second.

Do not solve these defects by making `brief.ts` or `discovery.ts` write smarter inferred prose. Without explicit guarded fields, inferred prose would still present inference as fact.

Target flow:

```text
Accepted project framing ─┐
Research + synthesis ─────┼─> ProjectState ─> deterministic Markdown
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

The resulting invariant is:

> Simple human views are generated from explicit guarded state, not hidden model inference.
