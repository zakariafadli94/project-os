# SOP 01 — Project Management

Status: adopted by `DEC-SOPS001`
Normative language: MUST / MUST NOT / SHOULD / MAY

## 1. Purpose

Keep every project understandable, executable, resumable, and resistant to LLM drift across consulting, marketing, research, software, websites, campaigns, R&D, recurring work, and one-shots.

Lifecycle:

`Resolve → Create → Brief → Discovery → Decisions → Roadmap → Execution → Review → Pause/Resume → Complete → Archive`

## 2. Project resolution

Before material work, resolve the project by exact ID, exact canonical name, exact alias, then unambiguous context. If multiple real projects remain plausible, ask one concise clarification. Never silently switch the bound project.

A `PROJECT_SESSION` MUST NOT change its primary project unless the user explicitly asks to switch. Mentioning another project is context, not authorization to rebind. Elliptical acknowledgements such as `vas-y`, `ok`, `fais-le`, `continue`, `go ahead`, or `do it` MUST inherit the current project binding and MUST NOT authorize a project switch.

### Cross-project referral without rebinding

When the user asks to deposit, send, route, pass, or report information to another project, the conversation MUST remain bound to its current primary project unless the user separately and explicitly asks to switch.

Project OS SHOULD route a compact referral to the target project's `INPUTS/` using only the target identity/path information required for delivery. It MUST NOT load the target project's `HANDOFF.md`, `STATE.md`, plan, decisions, research, or other business context merely to deliver the referral.

A referral SHOULD preserve enough provenance to understand the transfer, including when relevant:
- source project ID;
- target project ID;
- referral type such as anomaly, dependency, research, information, decision request, or deliverable reference;
- concise title and body;
- detection/creation timestamp;
- source references or evidence.

A routed input is evidence or a request to be instructed by the target project. It MUST NOT automatically become a target-project task, decision, accepted research record, constraint, deliverable, or other canonical truth. Those durable facts require the normal target-project workflow later.

Delivery to another project's `INPUTS/` is therefore communication, not rebinding and not acceptance.

## 3. Context loading

When state matters, refresh current project state before reasoning from it. Human reading order:

`BRIEF.md → DISCOVERY.md → ROADMAP.md → relevant DECISIONS → relevant DELIVERABLES → deeper RESEARCH/SPECS only as needed`

If canonical `STATE.md` / `HANDOFF.md` exist, use them to verify operational reality. Old chat is never authoritative project state.

## 4. New projects

Create persistence only when an initiative is operationally real enough to deserve durable state. Do not persist passing brainstorming, rejected ideas, hypotheticals, calculations, or unaccepted recommendations.

A project MAY start incomplete with only a name and broad objective. Unknowns MUST stay unknown. Never invent target customer, deadline, budget, team, strategy, success criteria, or constraints unless explicitly labeled simulation data.

## 5. BRIEF.md

`BRIEF.md` is current accepted project framing. It SHOULD answer:
- what the project is;
- why it exists;
- desired outcomes;
- scope / out of scope;
- binding constraints;
- stakeholders;
- success criteria;
- open questions.

It MUST NOT become a chronological log, task tracker, research dump, or decision history. When framing changes, update the Brief to current truth and preserve the change history in `DECISIONS/`.

## 6. DISCOVERY.md

`DISCOVERY.md` is a concise synthesis of current learning. It SHOULD distinguish confirmed finding, provisional finding, unresolved question, and rejected hypothesis.

Detailed evidence, calculations, interview notes, sources, and methodology belong in `RESEARCH/`. Discovery MUST NOT silently promote a finding into a decision.

## 7. ROADMAP.md

Roadmap communicates direction, not micro-tasks. It MUST use three primary horizons:

### Current
The active phase or outcome being pursued now.

### Next
The next meaningful phase/outcome once Current is sufficiently complete.

### Later
Future phases real enough to retain but not yet detailed for execution.

Blockers, completed work, and deliverables MAY appear as secondary context, but MUST NOT replace the three horizons.

Micro-tasks belong in operational task state. An idea does not automatically change the Roadmap.

## 8. Execution

Tasks convert accepted direction into action. A task SHOULD be concrete, have a clear completion condition, and belong to an active phase or deliverable.

The LLM MAY autonomously perform reversible work inside accepted direction. Escalate only when the task creates a material commitment, changes scope/direction, or supersedes an accepted decision.

## 9. Direction changes

When evidence conflicts with current direction:
1. record evidence as research/finding;
2. state the conflict;
3. produce options where needed;
4. recommend one if evidence supports it;
5. ask the user only when the change is materially directional;
6. after acceptance, create a new decision;
7. mark the prior decision superseded, never delete it;
8. update Brief/Roadmap to current truth.

Never rewrite history to make the old direction appear never to have existed.

## 10. Review

At meaningful checkpoints, verify:
- objective still valid;
- Discovery reflects material learning;
- Roadmap still aligned;
- tasks support Roadmap;
- deliverables have correct state/version;
- superseded decisions are marked;
- no critical context exists only in chat.

Only material changes deserve durable records.

## 11. Pause / resume

Before pause, project files MUST expose objective, current state, active direction, blockers, key decisions, current deliverables, and next meaningful action.

On resume, reconstruct from files first. If old chat is required, record that as a process defect.

## 12. Completion / archive

Completion requires a clear terminal outcome, identified final deliverables, acknowledged unresolved items, and clear final state. Archive preserves history and is terminal in the V1 lifecycle.

## 13. Stress tests

Synthetic projects MUST be clearly marked fictitious in portable Markdown and MUST NOT contaminate real projects. They SHOULD use the same SOPs as real work so the method itself is exercised.

## 14. Anti-drift checklist

Before material mutation, check:
- Am I inventing a fact?
- Am I converting recommendation into decision?
- Am I putting raw research in Discovery?
- Am I putting micro-tasks in Roadmap?
- Am I erasing history?
- Am I treating a draft deliverable as accepted?
- Am I changing the bound project without an explicit user request?
- Am I loading another project's business context when a referral to its INPUTS/ would suffice?
- Could a fresh LLM understand this without the chat?

If any answer signals drift, correct structure first.
