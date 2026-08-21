# SOP 04 — Handoff & Portability

Status: adopted by `DEC-SOPS001`

## 1. Principle

A project is portable when its current meaning, history, decisions, direction, and important outputs can be reconstructed from declared project artifacts without relying on prior chat history or hidden software state.

Automation MAY accelerate the process. Automation MUST NOT be the only place where project-management logic exists.

## 2. Minimum portable package

At minimum preserve:
- `BRIEF.md`;
- `DISCOVERY.md`;
- `ROADMAP.md`;
- relevant `DECISIONS/`;
- relevant `DELIVERABLES/`;
- research needed to justify important current conclusions;
- specs needed to continue implementation;
- this SOP suite or equivalent operating instructions.

Project OS internal files MAY accompany the package but MUST NOT be the only intelligible representation.

## 3. Resume reading sequence

A fresh LLM SHOULD read:
1. `BRIEF.md`;
2. `DISCOVERY.md`;
3. `ROADMAP.md`;
4. active/current decision records;
5. current deliverables;
6. deeper research/specs only when referenced or needed.

If current `STATE.md` / `HANDOFF.md` exist, use them to verify canonical operational state.

Do not load every historical file by default.

## 4. Six-question resume test

After reading, a fresh operator MUST be able to answer:
1. Why does this project exist?
2. What is true about it now?
3. Which important decisions are currently active?
4. What remains uncertain or blocked?
5. Which deliverables are current?
6. What is the next meaningful action?

If any critical answer requires old chat, portability has failed.

## 5. Planned handoff

Before pause or transfer, ensure artifacts expose:
- current objective;
- current phase/direction;
- latest meaningful progress;
- blockers;
- active decisions;
- superseded directions when relevant;
- current deliverables;
- next meaningful action;
- unresolved choices requiring the user.

A dedicated `HANDOFF.md` MAY summarize these, but portability MUST NOT depend exclusively on it.

## 6. Clean-room test

For major projects or before declaring portability:
1. assume no chat history;
2. provide only project files and SOPs;
3. ask a fresh LLM to reconstruct state;
4. compare reconstruction with canonical/current state;
5. record discrepancies as process defects;
6. fix documentation/SOP/runtime projection;
7. repeat until critical discrepancies are eliminated.

## 7. Platform migration test

To test method portability:
1. export Markdown and necessary artifacts;
2. remove Project OS scripts/runtime dependency;
3. provide SOP suite;
4. reconstruct project on a new LLM/platform;
5. verify the six resume questions;
6. verify active vs superseded decisions;
7. verify current deliverable identity;
8. verify Roadmap direction without hidden task state.

Any critical failure means the method is not yet platform-independent.

## 8. Severe hidden-dependency defects

Treat as severe when continuity requires:
- undocumented code;
- proprietary memory;
- private chat state;
- hidden prompt conventions;
- unavailable databases;
- undocumented naming assumptions;
- machine-generated material whose meaning cannot be reproduced from documented rules.

For each severe defect, either document the rule in Markdown/SOP or provide a portable equivalent.

## 9. Human readability

A human should navigate primarily through:

`Brief → Discovery → Roadmap → Decisions / Research / Specs / Deliverables`

Machine/audit traces remain secondary.

## 10. Transfer integrity

Preserve identifiers where useful, decision relationships, version relationships, current/superseded states, dates, source references, simulation labels, and acceptance states.

Do not flatten history into one latest summary if that destroys reasoning necessary for future work.

## 11. Resume behavior

On resume, an LLM MUST:
- prefer project files/canonical state over conversational memory;
- detect stale references;
- avoid reopening settled decisions without new evidence;
- avoid continuing superseded deliverables;
- state missing context instead of inventing it;
- continue autonomously inside accepted direction.

## 12. Acceptance criteria

A project passes portability when a fresh LLM can correctly understand purpose/current state, distinguish active and superseded decisions, identify current deliverables, identify next work, see important uncertainty, and continue without original chat.

The Project OS method passes portability only when the same remains true after removing Project OS software and using the SOP + Markdown artifacts alone.
