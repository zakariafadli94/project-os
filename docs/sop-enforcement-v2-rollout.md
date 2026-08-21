# SOP Enforcement V2 — Runtime and Rollout Guide

Status: implementation companion to canonical decision `DEC-SOPENF002`.

This guide documents the mechanical runtime changes introduced to enforce the adopted Project OS SOP suite. The SOP Markdown remains the portable method source of truth; this implementation adds canonical fields and deterministic guards so generated views do not infer one project concept from another.

## Canonical concepts added

`ProjectState` now represents project framing explicitly:

- `framing.scope`
- `framing.out_of_scope`
- `framing.success_criteria`
- `framing.stakeholders`
- `framing.open_questions`

Discovery synthesis is also explicit:

- `discovery.confirmed_findings`
- `discovery.provisional_findings`
- `discovery.unresolved_questions`
- `discovery.next_exploration`

Detailed evidence remains in `RESEARCH/`; Discovery references research records rather than dumping every research record automatically.

## Typed transactions

New exact-revision operations:

```text
project.framing.update
discovery.synthesis.update
deliverable.create
deliverable.start
deliverable.revise
deliverable.submit_review
deliverable.accept
deliverable.supersede
deliverable.abandon
```

The transaction envelope remains `schema_version: "1.0"` during this rollout.

`project.framing.update` and `discovery.synthesis.update` use replacement semantics for supplied fields. Omitted fields are preserved. A supplied empty array explicitly clears that field.

Discovery findings may reference research IDs; every referenced research record must already exist in the same project.

## Deliverable lifecycle

Normative lifecycle:

```text
planned → in_progress → review → accepted
```

Alternative terminal states:

```text
superseded
abandoned
```

`deliverable.accept` requires a dedicated transaction and non-empty acceptance note. Acceptance must be emitted only after explicit user acceptance; it is never inferred from file creation, task completion, or silence.

`deliverable.supersede` requires both the original and replacement deliverables to be accepted. The original becomes `superseded` and records `superseded_by` plus a reason. The replacement remains accepted. History is preserved.

## Legacy compatibility

Deprecated operations remain parseable for compatibility:

```text
deliverable.add
deliverable.complete
```

Compatibility mapping:

```text
legacy pending   → planned
legacy completed → legacy_completed
```

`legacy_completed` means an output was historically marked complete before explicit acceptance existed in the model. It MUST NOT be presented as accepted.

A `legacy_completed` deliverable may later become `accepted` only through an explicit `deliverable.accept` transaction with an acceptance note.

## State normalization

Persisted project state is normalized when `ProjectGuard` reads it.

Normalization:

- fills missing framing/discovery structures with empty arrays;
- validates known project records rather than casting arbitrary nested JSON;
- maps old deliverable statuses to the V2 compatibility states;
- fills missing deliverable decision links with an empty array;
- does not create acceptance data;
- does not change project revision;
- does not emit a domain event;
- is idempotent.

Pure `/materialize` calls operate on normalized in-memory state but remain non-mutating business infrastructure operations.

The project-state envelope remains `schema_version: "1.0"` for this rollout. A separate schema-envelope migration is not required to enforce these semantics.

## Human Markdown contract

`BRIEF.md` renders accepted project framing only. It no longer substitutes the active execution phase for scope or tracked deliverables for success criteria.

`DISCOVERY.md` renders explicit confirmed/provisional findings, unresolved discovery questions, next exploration and accepted decision links. Blocked tasks and phase actions remain operational state unless explicitly promoted into Discovery.

`ROADMAP.md` keeps the validated primary horizons:

```text
Current
Next
Later
```

Blocked work, completed work and deliverables remain secondary operational context. Deliverable lifecycle statuses are shown without collapsing them into pending/completed.

Deliverable notes expose version, owner/phase/decision relationships when present, explicit acceptance metadata, supersession history, abandonment reason and the `legacy_completed` warning.

## Safety invariants unchanged

SOP Enforcement V2 does not change:

- ProjectGuard serialization;
- transaction ID idempotency;
- receipt-last persistence gate;
- global project allocation;
- project lifecycle rules;
- decision supersession history;
- Dropbox V2 layout;
- Durable Object bindings or declarative exports;
- secret storage rules;
- canonical authority rules.

## Verification before merge

Required branch verification:

```bash
npm install
npm run check
npx wrangler deploy --dry-run
```

Required compatibility proofs include:

- legacy state materializes without manual migration;
- pure normalization/materialization keeps the prior business revision;
- old `completed` deliverables render as `legacy_completed`, not accepted;
- framing/discovery updates reject stale revisions;
- deliverable acceptance is explicit;
- accepted deliverables preserve history when superseded;
- `BRIEF.md` and `DISCOVERY.md` no longer derive semantic sections from unrelated operational data;
- `ROADMAP.md` retains `Current / Next / Later`.

## Production rollout

Production deployment continues through the existing Cloudflare Workers Git integration for `project-os-guard` from reviewed/merged GitHub source. No Cloudflare secret values belong in this repository or Markdown.

After production deployment:

1. confirm the Cloudflare Workers build reports success;
2. confirm the Worker health endpoint remains healthy;
3. use only the dedicated fictitious project `PRJ-0004` for SOP V2 stress-test mutations;
4. verify regenerated `BRIEF.md`, `DISCOVERY.md`, `ROADMAP.md`, decision history and deliverable notes;
5. verify one explicit deliverable review/acceptance path and one supersession path;
6. perform a clean-room Markdown-only reconstruction from a fresh session/platform;
7. do not add fictitious stress-test facts to real projects.

Production rollout is not considered validated solely because the branch tests and dry-run pass; the dedicated post-deploy stress test remains required.
