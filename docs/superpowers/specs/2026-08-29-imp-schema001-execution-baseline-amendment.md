# IMP-SCHEMA001 — Execution Baseline Amendment — 2026-08-29

## Status

Operational baseline amendment only. This does **not** change the user-approved Architecture A2 schema design or its family-versioning, rollout-stage, rollback, or no-down-migration decisions.

The original A2 design was approved against PRJ-0002 revision 106 and GitHub `main` `a461f4ccc71de8f5fc0310381f3d2829d1466f2b`. While IMP-SCHEMA001 was intentionally paused, the separately approved Operational Activation program was completed and production-validated.

Current execution baseline when SCHEMA resumed:

- GitHub `main`: `beb550154a7c4ea54de39137cc693e238dfa492f` before the controlled SCHEMA integration merge;
- PRJ-0002 canonical revision: 108;
- production layout mode: `v2`;
- current materialization `projection_version`: **2**;
- projection-v2 Operational Activation contract is already production-active (`OPERATING.md`, HANDOFF contract, managed-zone bootstrap);
- schema writer stage remains `v1_only` until SCHEMA rollout gates explicitly advance it;
- no ProjectState/provider durable V2 writer frontier has been crossed merely because projection version is 2.

## Supersession rule for execution

Where the historical A2 design or implementation plan says that current `projection_version` is `1`, read that statement for current execution as:

> Current production projection version is `2` because Operational Activation independently changed projection/rendering semantics. IMP-SCHEMA001 must preserve projection version 2 and must not itself bump to 3 merely because ProjectState/provider durable schema versions advance.

This amendment supersedes only the **numeric projection baseline** in those historical documents. The architectural rule remains unchanged: `schema_version` and `projection_version` are independent dimensions.

## Task 9 execution interpretation

Task 9 is therefore executed as follows:

1. prove ProjectState V1→V2/schema writer-stage changes leave `projection_version` at **2**;
2. prove SCHEMA causes no projection bump to 3;
3. preserve carried-forward `source_revision` behavior when semantic inputs are unchanged;
4. preserve the existing projection-v2 outputs introduced by Operational Activation, including `OPERATING.md` and the HANDOFF operating-contract block;
5. avoid unrelated projection rewrites caused solely by durable schema representation changes;
6. keep materialization record/head schema at 1.0 unless a separately justified change requires otherwise.

## Rollout interpretation

R1/R2/R3/R4 schema writer stages are independent from projection version:

- R1: `v1_only`, projection 2;
- R2: `core_v2`, projection 2;
- R3: `provider_v2`, projection 2;
- R4: steady state, projection 2 unless a future separately approved projection change occurs.

No rollout stage may downshift Operational Activation back to projection 1.

## Evidence

Operational Activation production closure established:

- merge/deployment line on `main` culminating in `beb550154a7c4ea54de39137cc693e238dfa492f`;
- deployment workflow #44 green;
- Cloudflare Worker production health green;
- PRJ-0002 materialization at projection version 2;
- `OPERATING.md` and managed-zone skeleton present;
- canonical activation closure receipt committed at PRJ-0002 revision 108.

This amendment exists to prevent stale historical numeric assumptions from causing an accidental projection rollback while SCHEMA001 is implemented.