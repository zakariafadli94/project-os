# SOP Enforcement V2 — Execution Notes

These notes record implementation clarifications discovered while executing `2026-08-21-sop-enforcement-v2.md`. The approved design spec remains authoritative when the original implementation plan wording differs.

## 1. Deliverable supersession linkage

The implementation follows the approved design spec, not the earlier plan phrase that mentioned reciprocal `supersedes` linkage.

Canonical behavior:

- original accepted deliverable becomes `superseded`;
- original records `superseded_by` and `superseded_reason`;
- replacement remains `accepted`;
- no reciprocal `supersedes` field is added to `DeliverableRecord`.

## 2. Legacy compatibility boundary

Legacy `pending` and `completed` exist only as raw persisted compatibility inputs. They are not members of the normalized `DeliverableStatus` type.

Normalization maps them to:

```text
pending   → planned
completed → legacy_completed
```

## 3. Normalizer strictness strengthened during review

The initial implementation deeply validated the new framing/discovery/deliverable concepts but cloned several legacy nested maps after top-level checks. Review identified that this still relied on type casts.

A new RED test was added for malformed nested tasks/research records. The normalizer was then strengthened to validate constraints, tasks, phases, decisions, research and deliverables field-by-field, including record-key/ID consistency and enum statuses.

## 4. Documentation placement

Rather than rewriting the large pre-existing reconstruction/deployment guides during feature implementation, the runtime semantics and rollout checklist are consolidated in:

`docs/sop-enforcement-v2-rollout.md`

The existing recovery/deployment guides remain valid for infrastructure, Dropbox layout, secrets, Worker bindings and disaster recovery. The V2 rollout companion documents only the new canonical semantics and post-deploy stress-test requirements.
