# SOP 02 — Knowledge & Decisions

Status: adopted by `DEC-SOPS001`

## 1. Purpose

Prevent confusion between ideas, evidence, recommendations, accepted decisions, and historical truth.

Every material statement SHOULD be classifiable as one of:
- observation;
- hypothesis;
- research finding;
- recommendation;
- accepted decision;
- constraint;
- current fact;
- historical fact;
- simulation/test datum.

The LLM MUST NOT blur these states.

## 2. Promotion chain

Normal promotion path:

`Observation → Hypothesis → Research → Finding → Recommendation → explicit user acceptance → Decision → Roadmap/Execution`

Not every observation needs research. Not every finding requires a decision. Not every recommendation becomes canonical.

## 3. Research

Detailed analysis belongs in `RESEARCH/`. A material research record SHOULD capture:
- question;
- date;
- source or method;
- evidence;
- analysis;
- finding;
- confidence / limitations;
- implications;
- unresolved questions.

Source evidence and LLM inference MUST remain distinguishable. When external sources materially support a conclusion, retain enough source information for later verification.

## 4. Discovery promotion

Promote only findings that materially affect project understanding or direction into `DISCOVERY.md`.

Good promotion candidates:
- resolves a major uncertainty;
- invalidates an assumption;
- changes prioritization;
- affects scope or roadmap;
- meaningfully reduces decision uncertainty.

Discovery is a synthesis, never the archive of all research.

## 5. Recommendations

A recommendation SHOULD state:
- proposed action;
- why;
- key supporting evidence;
- main downside/tradeoff;
- whether user approval is required.

Before user acceptance, the LLM MUST NOT write “we decided”, “accepted direction”, or equivalent language.

## 6. Decisions

A durable decision requires explicit user acceptance.

A decision record SHOULD include:
- decision ID;
- title;
- status;
- date;
- context;
- options considered when useful;
- accepted decision;
- rationale;
- consequences;
- related research;
- related roadmap/deliverables;
- supersedes / superseded by.

Recommended statuses are `accepted` and `superseded` for the current V1 model.

## 7. Supersession

When direction changes:
1. create a new accepted decision;
2. preserve the old decision;
3. mark old decision `superseded`;
4. link old and new where supported;
5. update current Brief/Roadmap;
6. retain original rationale.

A future LLM MUST be able to answer what was decided, why, what changed, and what replaced it.

## 8. Rejected ideas

Rejected hypotheses SHOULD usually remain only in research when their rejection is useful learning. Do not create decision records for every discarded idea. Historical noise is a defect too.

## 9. Conflicting evidence

When evidence conflicts:
- preserve both realities;
- identify the conflict;
- evaluate reliability;
- avoid silent resolution if the conflict changes business direction;
- escalate only when user judgment is genuinely required.

Never fabricate certainty for documentation neatness.

## 10. Uncertainty

Use explicit uncertainty labels where helpful: confirmed, likely, provisional, unknown, contradicted. Avoid false precision.

## 11. Human edits

Manual edits inside machine-managed/generated sections are not automatically authoritative. If a manual change reflects real project direction, convert it into the proper accepted canonical mutation.

## 12. Portability

Knowledge required for future decisions MUST exist in declared portable artifacts. Old chat, hidden prompts, undocumented scripts, private scratchpads, and temporary tool outputs are invalid as sole sources of truth.

## 13. Anti-drift examples

Incorrect: “Research favors enterprise, so we chose enterprise.”

Correct: “Research favors enterprise. Recommendation: prioritize enterprise. Decision pending.”

Incorrect: deleting an old pricing decision after a new price is accepted.

Correct: preserve the old pricing decision as superseded, create the new decision, and update current project framing.
