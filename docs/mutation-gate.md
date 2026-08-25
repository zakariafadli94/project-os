# Project OS — Mutation Gate

## Purpose

`IMP-MUTATIONGATE001` prevents an agent/operator or external provider write from silently becoming governed Project OS business truth merely because bytes exist in Dropbox.

The package addresses the class of failure where ChatGPT, another operator, or an integration misinterprets the intended write path and creates/updates a final business file directly instead of using a typed Project OS ingress.

MutationGate does **not** claim that an LLM can never misunderstand a business request. Its guarantee is narrower and deterministic: an ungoverned provider mutation cannot implicitly create publication, a committed artifact receipt, a canonical project revision, or human/business acceptance.

Full credential separation, cryptographic provenance and malicious evidence-forgery resistance remain part of the later `IMP-SECURITY001` package.

## Supported governed ingress

Agent/operator durable mutations must use the supported Project OS mechanisms rather than raw Dropbox final-zone writes:

- canonical business state → typed transaction ingress;
- artifacts → artifact ingress/API;
- collaborative documents → managed-document lifecycle API;
- external mutation candidates → typed candidate-resolution API.

Raw Dropbox create/update/move is not a parallel publication mechanism.

A provider file can exist physically without being governed.

## Zone semantics

Human/external collaboration remains legitimate in:

- `INPUTS/`;
- `REFERENCES/`;
- `WORKING/`;
- `REVIEW/`.

Strict final/governed output handling applies to:

- `DELIVERABLES/**`;
- governed artifact destinations resolved by `artifact_routes`;
- legacy `ARTIFACTS/**` business outputs.

A new file in a strict zone is not publication evidence by itself.

## Durable evidence

MutationGate durable evidence is isolated per project below:

```text
.project-os/projects/<PRJ>/mutation-gate/
├── intents/
│   ├── artifacts/
│   │   └── <ART-request>.json
│   └── destinations/
├── candidates/
│   └── <MUTCAND>.json
├── payloads/
│   └── candidates/
│       └── <MUTCAND>/payload
└── resolutions/
    └── <MUTCAND>/
        ├── terminal.json
        └── <MUTRES>.json
```

These record families evolve independently from `ProjectState` and currently use `schema_version: "1.0"`.

### Artifact mutation intent

Before a governed artifact provider effect, Project OS durably records:

- project and request identity;
- normalized request hash/JSON;
- project revision observed at preparation time;
- exact resolved physical destination;
- route snapshot when routed;
- provider precondition (`absent` or exact existing provider identity/revision/hash/size);
- expected content SHA-256;
- create/replace mode.

The resolved destination is frozen by the intent. Recovery does not silently reroute an interrupted request because `artifact_routes` changed later.

### External mutation candidate

An unknown strict-zone file becomes deterministic candidate evidence keyed by project + provider file ID + provider revision.

Before candidate metadata is considered durable, Project OS copies the provider bytes server-side into immutable hidden evidence.

Candidate capture is non-destructive by default. It does not:

- create a managed published head;
- create an artifact committed receipt;
- increment project business revision;
- mark content accepted.

## Final-zone classification

For an observed strict-zone file, MutationGate classifies before legacy/bootstrap adoption:

1. existing managed-document evidence may prove current governed content;
2. durable managed/artifact evidence may prove a recoverable governed in-flight effect;
3. otherwise the file is an external candidate.

Dropbox change-feed metadata does not provide a reliable actor identity for this purpose. Classification therefore uses durable provenance and target-zone semantics rather than guessing whether a change came from a human, ChatGPT or another client.

## Baseline and cursor reset

Hard invariant:

> Unknown `DELIVERABLES/**` files are never auto-adopted as `published` merely because a baseline scan or cursor reset discovers them.

Published bootstrap is allowed only when durable governed provenance proves the final file belongs to a known recovery/legacy governed operation.

Legacy adoption remains allowed for collaborative `WORKING`, `REVIEW` and `REFERENCES` files according to the managed-document contract.

## Artifact crash recovery

Normal governed artifact ordering is:

```text
durable mutation intent
  -> verify frozen destination/provider precondition
  -> provider effect
  -> governed artifact/managed evidence
  -> terminal artifact receipt
```

If provider bytes land after the durable intent but Project OS crashes before the terminal receipt, reconciliation recognizes matching bytes as `governed_inflight`, not as an external candidate. Exact replay uses the frozen intent and is idempotent.

A raw file that existed **before** an artifact intent cannot be retroactively sanitized by creating a new intent for the same path. It remains an unresolved external candidate until explicitly resolved.

## Candidate resolution

Candidate resolution is typed and same-project serialized through `ProjectGuard`.

Supported operations:

### `candidate.reject`

Records that the external mutation is not adopted. Evidence remains preserved.

### `candidate.adopt_artifact`

Requires:

- exact candidate/project binding;
- immutable candidate payload to match the nested artifact request byte-for-byte and by SHA-256;
- nested artifact destination to match the candidate provider path;
- normal governed artifact execution;
- downstream committed receipt before terminal candidate resolution.

The unresolved-path bypass is an internal capability bound to the exact candidate and destination. It is never exposed as a public `skipGuard` flag.

### `candidate.adopt_working`

Uses a normal managed-document `working.write` request. It can create/advance a working pointer but never publishes the candidate directly.

### Resolution crash recovery

A terminal resolution marker contains the immutable resolution plus the hash of the normalized resolution request.

If Project OS crashes after writing `terminal.json` but before the detailed resolution JSON, replay:

- treats the terminal marker as authoritative;
- repairs missing detail without rerunning downstream effects;
- rejects a changed payload reusing the same resolution ID;
- rejects a competing terminal resolution.

## Status vocabulary

MutationGate preserves four distinct concepts.

### SUBMITTED

A request has reached governed ingress or a durable pre-effect intent exists. No successful final effect is claimed.

For artifacts, an intent without a terminal receipt reports `verification_state = submitted`.

### COMMITTED

The semantic operation has its required committed receipt/evidence.

For artifacts, a committed receipt whose final provider effect cannot currently be verified reports `verification_state = committed`.

### CANONICAL VERIFIED

Family-specific authoritative evidence has been verified.

For artifacts, MutationGate requires a matching durable intent, committed receipt and final provider bytes whose Project OS SHA-256 matches the intent. Only then does artifact status report `verification_state = canonical_verified`.

For resolved candidates, terminal immutable candidate-resolution evidence yields `canonical_verified` for the candidate workflow. This does not mean the candidate content was human/business accepted.

### ACCEPTED

Acceptance exists only when an explicit object-specific human/business lifecycle rule says so. Provider file presence, upload success, candidate capture and committed technical resolution are insufficient.

## Observe and enforce modes

Runtime setting:

```text
PROJECT_OS_MUTATION_GATE_MODE=observe|enforce
```

### `observe`

- detect, preserve and record unknown strict-zone candidates;
- never implicitly govern them;
- leave unknown visible bytes in place by default;
- report candidate signals without creating business revision/publication/acceptance.

### `enforce`

- uses the same provenance recognition;
- keeps candidates non-governed;
- requires explicit resolution before adoption/publication;
- reports policy violations as enforcement findings.

Initial production rollout must use `observe`.

Returning from `enforce` to `observe` is the supported configuration rollback. Append-only intent/candidate/resolution evidence is retained.

## Internal/public API surface

ProjectGuard exposes compact internal MutationGate routes:

```text
GET  /mutation-candidates
GET  /mutation-candidate-status?candidate_id=<MUTCAND-...>
POST /mutation-candidate-resolution
```

The authenticated public candidate-resolution route is:

```text
POST /v1/mutation-candidates/resolve
Authorization: Bearer <INGRESS_TOKEN>
```

Status/list responses intentionally omit candidate payload contents.

## Operator rules

ChatGPT/operators must:

- use typed Project OS ingress whenever one exists;
- never treat raw Dropbox final-zone writes as a shortcut;
- call unknown provider output external/unverified until governed evidence proves otherwise;
- never claim `saved`, `published`, `accepted` or equivalent solely from file presence;
- never fabricate receipts, mutation-gate records or managed-document heads to repair a bypass;
- preserve external bytes and use typed resolution/recovery.

A cognitive mistake can still produce a wrong proposal in chat. MutationGate prevents that mistake from silently becoming governed persistent reality through a raw provider write.

## Production validation gate

Before normal enforcement or PRJ-0003 repair:

1. exact implementation PR head must pass full `npm run check`;
2. exact head must pass `npx wrangler deploy --dry-run`;
3. merge/deploy is a separate explicit gate;
4. production starts with `PROJECT_OS_MUTATION_GATE_MODE=observe`;
5. observe inventory must prove known governed outputs are not misclassified and unknown strict-zone files are preserved as candidates;
6. crash/replay and status semantics must be validated against production evidence;
7. only then may `enforce` be separately enabled;
8. only after MutationGate production validation may historical PRJ-0003 bypass files be audited/adopted/rejected through governed flows;
9. SCHEMA rollout is revalidated against that new baseline before resuming.

No step in this document authorizes production deployment, `enforce`, PRJ-0003 repair or SCHEMA implementation by itself.
