# SOP 03 — Deliverables

Status: adopted by `DEC-SOPS001`

## 1. Purpose

Make outputs identifiable, versioned, reviewable, portable, and historically safe.

A deliverable is a concrete output intended for use, review, handoff, publication, implementation, or acceptance. Research notes are not automatically deliverables.

Examples include reports, strategy documents, campaign plans, landing pages, websites, software releases, specifications, presentations, operating models, and final SOPs.

## 2. Required metadata

Each material deliverable SHOULD expose:
- deliverable ID;
- name;
- purpose;
- owner when relevant;
- status;
- version;
- created / updated dates;
- acceptance state;
- related decision(s);
- related phase;
- supersedes / superseded by when applicable;
- location/path.

## 3. Lifecycle

Normative lifecycle:

`planned → in_progress → review → accepted`

Alternative terminal states:
- `superseded`
- `abandoned`

If runtime storage supports fewer states, it MUST map clearly to these human meanings rather than silently changing the method.

## 4. Planned

Track a planned deliverable only when it belongs to accepted work and its lifecycle matters to continuity. Do not create speculative deliverables for every possible future output.

## 5. In progress

A deliverable becomes in progress when substantive production begins. Draft content may change freely. The LLM MUST NOT call it final or accepted.

## 6. Review

Move to review only when the output is coherent enough to evaluate against explicit criteria.

Typical criteria:
- answers the intended question;
- contains required sections;
- meets accepted technical/business constraints;
- reflects current accepted decisions;
- exposes critical limitations;
- is located where another operator can find it.

## 7. Acceptance

Acceptance requires explicit user/client acceptance or an explicitly delegated acceptance rule.

The LLM MUST NOT infer acceptance from:
- silence;
- absence of objections;
- file creation;
- passing formatting/tests alone;
- a recommendation to ship.

When acceptance is material, record the accepted version unambiguously.

## 8. Versioning

Create a meaningful new version when:
- content materially changes after review;
- a decision changes the output;
- an accepted output is reissued;
- a successor replaces the prior output.

Minor mechanical corrections MAY remain in the same logical version if history is not materially affected.

Versioning MUST preserve the ability to understand what was previously reviewed or accepted.

## 9. Supersession

When replaced:
- old deliverable becomes `superseded`;
- new deliverable references the old where supported;
- current project views point to the new output;
- the old accepted output remains accessible when historical context matters.

Never delete accepted history simply to reduce clutter.

## 10. Abandonment

Use `abandoned` when work stops and the output is not intended to continue. Record the reason when useful: scope change, failed experiment, cancellation, or superior approach.

## 11. Deliverable vs working file

Not every working file deserves durable deliverable state. Track only outputs whose status matters to review, acceptance, external delivery, continuity, or future reference.

## 12. Relationship to Roadmap and decisions

A deliverable SHOULD identify the decision/phase it implements. The Roadmap MAY link major deliverables but MUST NOT duplicate their full contents or become a deliverables database.

## 13. Quality gates

Before `review`:
- purpose clear;
- version identifiable;
- current decisions reflected;
- critical limitations visible;
- context not trapped in chat.

Before `accepted`:
- explicit acceptance exists;
- accepted version is unambiguous;
- earlier versions are retained or correctly superseded.

## 14. Portability

A deliverable needed to continue the project MUST be exportable or reconstructable from documented artifacts. If it depends on proprietary tooling, preserve enough specification/reference material for another platform to understand what it is, which version is current, how it was produced, and what remains editable.
