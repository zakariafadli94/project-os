# Project OS — LLM Operating SOP Suite

Status: adopted by `DEC-SOPS001`
Audience: LLM operators, human owners, and future platforms
Purpose: make project management portable, deterministic, auditable, and resistant to LLM drift.

## Mandatory reading order

Before material project work, an LLM MUST read this index and `01-PROJECT-MANAGEMENT-SOP.md`.

Then read:
- `02-KNOWLEDGE-DECISIONS-SOP.md` whenever research, recommendations, decisions, or direction changes are involved.
- `03-DELIVERABLES-SOP.md` whenever an output is created, reviewed, versioned, accepted, replaced, or abandoned.
- `04-HANDOFF-PORTABILITY-SOP.md` before pause, resume, handoff, clean-room testing, archive, or platform migration.

## Human project model

The primary reading path is:

`BRIEF.md → DISCOVERY.md → ROADMAP.md → relevant DECISIONS → relevant DELIVERABLES → deeper RESEARCH/SPECS only when needed`

`PROJECT.md`, `STATE.md`, `PLAN.md`, and `HANDOFF.md` may exist as Project OS canonical/recovery views, but the project-management method MUST remain understandable without proprietary runtime behavior.

## Non-negotiable invariants

An LLM MUST NOT:
- invent a real project fact to make documentation look complete;
- convert its own recommendation into an accepted decision;
- erase prior accepted decisions because direction changed;
- treat `DISCOVERY.md` as a raw research dump;
- treat `ROADMAP.md` as a micro-task backlog;
- infer deliverable acceptance from silence or file creation;
- rely on old chat, hidden memory, undocumented scripts, or a private scratchpad as the only source required for project continuity;
- mix fictitious stress-test data into a real project.

An LLM MUST distinguish:
- current fact;
- historical fact;
- observation;
- hypothesis;
- research finding;
- recommendation;
- accepted decision;
- constraint;
- simulation/test data.

## Standard autonomy rule

The LLM SHOULD continue autonomously for reversible operational work inside an accepted direction.

Escalate only when at least one of these applies:
1. a real business decision is required;
2. two incompatible but valid directions exist;
3. scope or a binding constraint changes materially;
4. a final deliverable needs explicit acceptance;
5. a new Project OS/SOP rule is proposed;
6. evidence is insufficient to proceed without inventing a fact.

## Anti-drift preflight

Before any material mutation, the LLM should internally verify:
- What is fact versus inference?
- Has the user accepted the direction?
- Is the information going to the correct layer?
- Am I preserving history?
- Could a fresh LLM understand this without the current chat?

If any answer is unclear, correct the structure before proceeding.
