# IMP-MUTATIONGATE001 — Mutation Gate B2 Design

## Status

Approved in chat on 2026-08-25 and canonically checkpointed by `DEC-MUTATIONGATEDESIGN001` at PRJ-0002 revision 83. This document formalizes that accepted architecture. It does **not** authorize runtime implementation, deployment, connector-permission changes, destructive migration, PRJ-0003 repair, or IMP-SCHEMA001 implementation.

## Goal

Prevent a ChatGPT/Project OS operator mistake, stale interpretation, or raw Dropbox bypass from silently becoming a governed business mutation merely because files exist in the project workspace.

The gate must preserve the current natural-language workflow and legitimate human Dropbox/Obsidian collaboration while ensuring that canonical facts, governed artifacts, managed-document publication, and acceptance are recognized only through typed Project OS mechanisms with durable evidence.

## Problem statement

Project OS already has strong canonical transaction guards and managed-document concurrency protections, but the PRJ-0003 incident exposed a different failure class: an operator with raw Dropbox write capability can create business files directly in a final workspace path instead of using the transaction/artifact/document ingress.

Current IMP-ARTIFACT001 behavior creates two concrete risks for a newly created unmanaged file in `DELIVERABLES/**`:

1. during normal incremental reconciliation, an unknown file with no managed-document head can be ignored;
2. during the first managed-document baseline or after a Dropbox cursor reset, an unknown `DELIVERABLES/**` file can be bootstrapped as an initial `published` version.

That means raw provider presence can survive ungoverned or, after a reset, be retroactively interpreted as publication. B2 removes that equivalence.

## Threat model and explicit boundary

B2 protects against:

- ChatGPT choosing a raw Dropbox write instead of a supported Project OS ingress;
- old-chat or stale-context behavior that writes to a final path directly;
- accidental operator/provider writes into governed final zones;
- unknown files appearing during incremental reconciliation, initial baseline, or cursor reset;
- crash windows where a legitimate ProjectGuard provider effect exists before all managed/artifact terminal evidence is finished;
- ambiguity between `SUBMITTED`, `COMMITTED`, `CANONICAL VERIFIED`, and `ACCEPTED`.

B2 does **not** claim to defeat a malicious actor who has the same Dropbox credentials and deliberately forges hidden Project OS evidence. Strong anti-forgery, least-privilege credentials, runtime/provider identity separation, secret rotation, and cryptographic provenance are primarily owned by `IMP-SECURITY001` unless implementation evidence proves a smaller mechanism is required for correctness.

## Core architecture: semantic gate plus runtime provenance backstop

B2 has two layers.

### Layer 1 — operator routing invariant

For Project OS agent/operator work, a durable mutation must use one of the supported typed paths:

- canonical project transaction ingress;
- artifact ingress;
- managed-document ingress;
- an explicit mutation-candidate resolution operation.

Raw provider writes are never a supported business path when a governed route exists.

This is an operator invariant, not a claim that Dropbox physically prevents every raw write.

### Layer 2 — runtime recognition invariant

ProjectGuard and reconciliation logic must independently enforce:

> Provider presence is not proof of governance.

A visible file becomes governed only when Project OS can bind it to the correct durable evidence for its semantic family.

Examples:

- canonical facts require committed canonical transaction/commit evidence;
- generated views require materialization evidence;
- managed-document versions require managed version/request evidence;
- artifact publication requires artifact/mutation intent plus terminal artifact/document evidence;
- an unknown final-zone creation without such evidence becomes an external candidate, never an implicit publication.

## Surface classification

### Canonical machine state and generated projections

Existing behavior remains authoritative. Canonical state changes only through typed transactions. Generated projection edits remain external/untrusted bytes and never become canonical facts.

### Collaborative external-edit zones

These remain legitimate human/provider surfaces:

- `INPUTS/`
- `REFERENCES/`
- `WORKING/`
- `REVIEW/`

Existing managed-document reconciliation remains the primary handler. A human edit can become a new managed-document version without becoming a canonical project decision.

### Final/governed publication zones

The strict rule applies to:

- `DELIVERABLES/**`;
- governed artifact destinations resolved by `artifact_routes`;
- legacy `ARTIFACTS/**` outputs when Project OS is treating them as business artifacts rather than intake/reference content.

A new file in these zones is not publication evidence by itself.

## Durable record families

B2 must not require a `ProjectState` schema bump. New records evolve independently, initially at `schema_version: "1.0"`.

### `MutationIntentRecord`

Purpose: bind an authorized ProjectGuard mutation to its normalized semantic request and resolved provider destination **before** the provider effect.

Minimum fields:

```ts
interface MutationIntentRecord {
  schema_version: "1.0";
  intent_id: string;
  project_id: string;
  kind: "artifact";
  request_id: string;
  request_sha256: string;
  request_json: string;
  base_project_revision: number;
  destination_path: string;
  archive_path?: string;
  route_id?: string;
  expected_content_sha256: string;
  mode: "create" | "replace";
  recorded_at: string;
}
```

Managed-document operations already have durable request intent/receipt evidence under the document ledger. B2 reuses that family rather than duplicating it.

Canonical transactions already have their own transaction/commit/receipt family and do not need a duplicate mutation intent.

### `ExternalMutationCandidateRecord`

Purpose: preserve and classify an unknown final-zone creation without inferring publication or actor identity.

Minimum fields:

```ts
interface ExternalMutationCandidateRecord {
  schema_version: "1.0";
  candidate_id: string;
  project_id: string;
  source: "external_unverified";
  detection_source: "incremental" | "baseline" | "cursor_reset";
  provider_path: string;
  provider_file_id: string;
  provider_rev: string;
  provider_content_hash: string;
  size: number;
  immutable_payload_path: string;
  detected_at: string;
}
```

`candidate_id` is deterministic from project + provider identity/revision so replay does not create duplicates.

The candidate record is immutable. It does not carry mutable lifecycle status.

### `ExternalMutationResolutionRecord`

Purpose: record the explicit resolution of a candidate.

Minimum fields:

```ts
type CandidateResolutionAction =
  | "adopt_as_artifact"
  | "adopt_as_working"
  | "reject";

interface ExternalMutationResolutionRecord {
  schema_version: "1.0";
  resolution_id: string;
  project_id: string;
  candidate_id: string;
  action: CandidateResolutionAction;
  downstream_request_id?: string;
  downstream_receipt_status?: "committed" | "conflict" | "rejected";
  resolved_at: string;
}
```

A resolution is append-only. It must never rewrite the candidate record.

## Hidden layout

Recommended V1 layout:

```text
.project-os/projects/<PRJ>/mutation-gate/
├── intents/
│   └── artifacts/
│       └── <ART-REQUEST-ID>.json
├── intent-bindings/
│   └── destination/
│       └── <path-hash>/
│           └── <ART-REQUEST-ID>.json
├── candidates/
│   └── <CANDIDATE-ID>.json
├── payloads/
│   └── candidates/
│       └── <CANDIDATE-ID>/payload
└── resolutions/
    └── <CANDIDATE-ID>/
        └── <RESOLUTION-ID>.json
```

All machine records remain outside the Obsidian workspace.

## Artifact intent and deterministic crash recovery

The current managed-document path already writes durable request intent before provider effect. B2 extends that pattern to artifact writes.

Before `ProjectRepository.writeArtifact(...)` performs any provider mutation:

1. validate the artifact request;
2. load current canonical project state;
3. resolve the artifact route/destination;
4. create/reuse `MutationIntentRecord` with exact request JSON, request hash, project revision, resolved destination, route identity, mode, and expected SHA-256;
5. only then perform the provider write;
6. persist managed-document/artifact version evidence as applicable;
7. write terminal artifact receipt.

The resolved destination is part of the durable intent. Recovery must not silently reroute an interrupted artifact request merely because `artifact_routes` changed after the original provider effect.

A route change after an unresolved artifact intent is therefore handled against the stored intent, not recomputed as a new business choice.

## Final-zone reconciliation algorithm

For every changed file in a strict final/governed zone:

1. classify the path and current provider metadata;
2. check whether existing managed-document/provider observation already proves the file is current governed content;
3. check whether existing managed-document state proves this is a recoverable in-flight publication (for example a current REVIEW candidate whose bytes match an interrupted publish);
4. check durable artifact mutation intents/bindings for a matching governed in-flight or historical artifact request;
5. if provenance is sufficient, route to the existing recovery/replay path;
6. otherwise create/reuse an `ExternalMutationCandidateRecord`, snapshot the provider bytes server-side, and **do not** advance any governed pointer or receipt.

The candidate path must be evaluated before legacy/bootstrap adoption.

## Baseline and cursor-reset rule

This is a hard invariant:

> Unknown `DELIVERABLES/**` files are never auto-adopted as `published` merely because a baseline or cursor reset sees them.

Existing bootstrap remains allowed for:

- already governed managed documents whose durable evidence can be reconstructed;
- collaborative `WORKING`, `REVIEW`, and `REFERENCES` legacy files where the package's existing adoption contract intentionally permits it;
- final files proven by accepted legacy artifact/document evidence.

Unknown final files become candidates.

## Candidate preservation and quarantine semantics

Candidate capture is non-destructive by default.

Before any visible cleanup or restoration, Project OS must create immutable provider-side payload evidence. B2 does not claim Dropbox supports a fully conditional delete/move primitive; therefore the gate must not automatically destroy an unknown final file merely to make the visible tree look clean.

In both observe and enforce modes, the correctness guarantee is that an unknown final file cannot become governed truth implicitly.

Optional visible cleanup happens only through an explicit resolution/recovery operation that revalidates current provider metadata and preserves bytes first.

## Observe and enforce modes

Add a bounded runtime mode:

```text
observe
  -> detect + preserve + record candidate
  -> do not implicitly govern
  -> do not automatically relocate unknown final file

enforce
  -> same recognition rules
  -> candidate remains non-governed
  -> explicit resolution is required before adoption/publication
```

Initial production rollout must start in `observe` mode.

Observe mode is not a compatibility loophole: even while the visible file remains where it is, it must not create a published head, artifact committed receipt, canonical revision, or acceptance.

After inventory and production proof, enforcement can become the configured normal mode.

Rollback from enforcement is a configuration rollback to observe mode. Append-only intent/candidate/resolution evidence is preserved.

## Candidate resolution interface

Introduce one typed resolution family. ChatGPT translates natural language into it; users never type IDs manually.

Conceptual request:

```ts
type MutationCandidateResolutionRequest =
  | {
      operation: "candidate.adopt_artifact";
      resolution_id: string;
      project_id: string;
      candidate_id: string;
      artifact_request: ArtifactWriteRequest;
    }
  | {
      operation: "candidate.adopt_working";
      resolution_id: string;
      project_id: string;
      candidate_id: string;
      document_request: ManagedDocumentRequest; // must be working.write
    }
  | {
      operation: "candidate.reject";
      resolution_id: string;
      project_id: string;
      candidate_id: string;
    };
```

Rules:

- the candidate and nested request must belong to the same project;
- adoption must use the normal downstream artifact/document service, not direct final writes;
- the candidate's immutable evidence must match the content being adopted;
- a committed downstream receipt is required before writing a successful adoption resolution;
- `adopt_as_working` never publishes;
- `reject` records non-adoption but does not erase evidence;
- unsupported binary-to-text adoption fails closed rather than decoding opaque bytes incorrectly;
- exact resolution replay is idempotent;
- a candidate cannot receive two conflicting terminal resolutions.

## Status vocabulary

B2 enforces four distinct lifecycle terms:

### SUBMITTED

The request is present in an ingress or durable intent exists. No successful business effect is claimed yet.

### COMMITTED

The semantic operation has its required terminal committed receipt/evidence.

### CANONICAL VERIFIED

The relevant durable truth has been verified against its family-specific authoritative representation:

- canonical revision/commit for canonical transactions;
- managed version/head + receipt for document operations;
- artifact/managed evidence + terminal receipt for artifacts;
- candidate/resolution evidence for mutation-candidate workflows.

### ACCEPTED

Only an explicit business/human lifecycle rule can make an object accepted. File presence and successful provider upload are insufficient.

## ChatGPT/operator behavior

The Project OS operating contract must explicitly say:

- do not use raw Dropbox create/update/move into final governed business destinations when a typed Project OS ingress exists;
- use transaction/artifact/managed-document/candidate-resolution routes;
- when a provider write happens outside governance, describe it as external/unverified until ProjectGuard evidence proves otherwise;
- never call a request `saved`, `persisted`, `published`, or `accepted` merely because a file exists;
- never repair a bypass by fabricating a canonical receipt or direct hidden ledger record.

This operator policy is defense-in-depth; runtime recognition remains authoritative.

## Interaction with IMP-ARTIFACT001

MUTATIONGATE extends rather than replaces IMP-ARTIFACT001.

Keep:

- managed-document versions and heads;
- expected-version checks;
- Dropbox rev CAS;
- external edit preservation;
- direct managed DELIVERABLE edit recovery;
- managed request intent/receipt;
- change cursor and reset handling;
- legacy artifact compatibility.

Change:

- final-zone unknown-file classification occurs before published bootstrap;
- `DELIVERABLES` baseline/reset adoption requires durable provenance;
- artifact requests gain durable pre-effect intent/resolved-destination evidence;
- unknown final creations gain candidate evidence/resolution workflow.

## Interaction with IMP-SCHEMA001

The accepted SCHEMA architecture remains frozen.

MUTATIONGATE does not require ProjectState 2.0.

The new mutation-gate families start independently at schema 1.0 and must later be included in SCHEMA's final per-family compatibility/recovery revalidation before SCHEMA runtime implementation resumes.

If implementation unexpectedly requires changing an existing durable family such as `DocumentVersionRecord`, that is a design change requiring explicit review before coding the incompatible schema change.

## Interaction with IMP-SECURITY001

B2 intentionally does not absorb the full security package.

Deferred primarily to SECURITY:

- separate provider credentials for agent versus runtime;
- provider path-level least privilege where feasible;
- cryptographically signed/HMAC runtime provenance;
- secret rotation and installation trust-boundary hardening;
- malicious evidence forgery resistance.

MUTATIONGATE's production guarantee is narrower and deterministic: raw bypass cannot silently become governed truth.

## Observability requirements

Emit structured, content-free signals including:

- project_id;
- path hash or safe path metadata;
- intent_id/request_id;
- candidate_id/resolution_id;
- classification outcome (`governed_current`, `governed_inflight`, `candidate`, `ignored_collaborative`);
- detection source (`incremental`, `baseline`, `cursor_reset`);
- gate mode (`observe`, `enforce`);
- downstream receipt status;
- recovery/replay outcome.

Never log file contents or secret values.

## Acceptance matrix

Implementation must prove at least the following deterministic cases.

1. A direct new `DELIVERABLES/foo.md` during incremental reconciliation creates a candidate and no published head.
2. A direct new governed/legacy `ARTIFACTS/foo.md` creates a candidate and no artifact committed receipt.
3. The same unknown deliverable seen during first baseline does not bootstrap as published.
4. The same unknown deliverable seen after cursor reset does not bootstrap as published.
5. Candidate replay does not create duplicate records/payloads.
6. Candidate capture preserves opaque provider bytes server-side without UTF-8 decoding.
7. Observe mode leaves visible bytes untouched while keeping them non-governed.
8. Existing managed `WORKING` and `REVIEW` external edits retain current IMP-ARTIFACT001 behavior.
9. Existing managed published DELIVERABLE edit retains current preserve/restore behavior and cannot advance the published pointer.
10. An interrupted managed publish with durable request/review evidence is recognized as governed-inflight, not candidate.
11. An artifact create that crashes after provider write but before terminal evidence can be recovered from durable artifact intent without becoming an external candidate.
12. Artifact recovery uses the destination captured in its intent even if the project route changes later.
13. Exact artifact request replay returns the same terminal result and creates no duplicate version.
14. `candidate.adopt_artifact` must pass through normal artifact governance and records resolution only after committed downstream evidence.
15. `candidate.adopt_working` creates working state only and never publication.
16. `candidate.reject` preserves candidate payload/evidence and prevents later implicit adoption.
17. Conflicting second candidate resolution fails closed.
18. Candidate IDs/evidence are project-isolated under concurrent multi-project changes.
19. Loss of Durable Object hot cache does not lose intent/candidate/resolution identity.
20. Canonical project revision does not advance merely because a candidate is detected or rejected.
21. `SUBMITTED`, `COMMITTED`, `CANONICAL VERIFIED`, and `ACCEPTED` remain semantically distinct in responses/docs.
22. Production continuity mode remains `stable` throughout the package.

## Production rollout sequence

1. Implement and prove locally/TDD on an isolated feature branch.
2. Run complete `npm run check` and Wrangler dry-run.
3. Review for direct final-write bypasses, accidental secrets, destructive candidate cleanup, route replay drift, and cross-project paths.
4. Deploy candidate build with `PROJECT_OS_MUTATION_GATE_MODE=observe` while continuity remains `stable`.
5. Verify health and read-only production status.
6. Run non-destructive candidate inventory across active projects.
7. Confirm no legitimate governed writes are misclassified.
8. Activate enforcement configuration only after evidence is accepted.
9. Production-validate direct bypass detection with isolated non-business test evidence.
10. Record PRJ-0002 production proof and package completion through typed transactions.
11. Audit/repair the known PRJ-0003 direct-write deviations via candidate/adoption flows; do not resubmit `DEC-EXECUTABILITY001`.
12. Revalidate IMP-SCHEMA001 final rollout against the new mutation-gate durable families and baseline.
13. Resume SCHEMA implementation only after a new explicit rollout approval.

## Rollback

Runtime rollback is configuration-first:

```text
enforce -> observe
```

Rollback never deletes mutation intents, candidates, payloads, or resolutions and never rewinds canonical business history.

If a runtime defect requires code rollback, production continuity remains `stable` and existing Project OS canonical/document evidence remains authoritative.

## Non-goals

- eliminating all possible LLM misunderstanding;
- physically preventing every Dropbox write with the current shared credential model;
- replacing managed-document versioning;
- replacing artifact routes;
- ProjectState schema redesign;
- cryptographic anti-forgery;
- full provider abstraction;
- full observability platform;
- general binary artifact upload API;
- automatic destructive cleanup of unknown final files.
