# Project OS Deployment and V2 Operations

Project OS keeps credentials out of GitHub, generated Markdown, Obsidian and ChatGPT conversation text. Production is a Cloudflare Worker backed by SQLite Durable Objects, with Dropbox as the current durable external persistence provider and Obsidian as an optional human reading/navigation layer.

## 1. Runtime

Repository and Worker:

- Repository: `zakariafadli94/project-os`
- Production branch: `main`
- Worker: `project-os-guard`
- Verification: `npm install && npm run check`
- Deploy: `npm run deploy`
- Dry-run: `npx wrangler deploy --dry-run`

`wrangler.jsonc` declares SQLite-backed:

- `ProjectGuard` → `PROJECT_GUARD`
- `RegistryGuard` → `REGISTRY_GUARD`

Production layout is V2, continuity remains stable, and the initial MutationGate rollout mode is observe:

```text
PROJECT_OS_LAYOUT_MODE=v2
PROJECT_OS_CONTINUITY_MODE=stable
PROJECT_OS_MUTATION_GATE_MODE=observe
```

Do not change continuity mode merely because a feature PR is merged. Transparent candidate rollout/cutover remains owned by the later deployment package.

Do not enable `PROJECT_OS_MUTATION_GATE_MODE=enforce` in the first MutationGate production deployment. `enforce` is a separate rollout gate after observe-mode inventory and production proof.

The scheduled trigger runs every five minutes. It performs independent recovery/reconciliation jobs for:

- transaction/artifact inbox processing;
- fleet materialization reconciliation;
- managed-document/MutationGate provider change reconciliation.

Materialization reconciliation uses bounded project concurrency and isolates one blocked project from the rest.

## 2. Required secrets

Production requires Cloudflare secrets:

```text
DROPBOX_APP_KEY
DROPBOX_APP_SECRET
DROPBOX_REFRESH_TOKEN
INGRESS_TOKEN
```

Never commit or paste their values into Markdown or chat. Documentation may contain secret names and regeneration procedures only.

`INGRESS_TOKEN` protects direct transaction/artifact/document/candidate-resolution ingress and authenticated administrative endpoints.

## 3. Dropbox application

Use a dedicated Dropbox App Folder application with at least:

```text
files.content.read
files.content.write
files.metadata.read
```

Use offline OAuth and store the refresh token only as Cloudflare `DROPBOX_REFRESH_TOKEN`.

The API root used by Project OS is:

```text
/PROJECT_OS
```

A user-visible synced location may appear as:

```text
Dropbox/Applications/project-os/PROJECT_OS
```

or the locale-equivalent Dropbox App Folder.

Dropbox Desktop is optional. Project OS does not depend on a user computer, direct filesystem access, a desktop daemon or a local bridge for correctness.

MutationGate does not yet change Dropbox credential scope or cryptographically prove which actor performed a provider write. Those trust-boundary hardening concerns remain for `IMP-SECURITY001`.

## 4. V2 storage layout

Machine persistence is below `.project-os/`; human Markdown is below `WORKSPACE/`.

```text
PROJECT_OS/
├── WORKSPACE/
│   ├── PORTFOLIO/
│   └── PROJECTS/
│       └── PRJ-xxxx-slug/
│           ├── PROJECT.md
│           ├── BRIEF.md
│           ├── DISCOVERY.md
│           ├── ROADMAP.md
│           ├── STATE.md
│           ├── PLAN.md
│           ├── HANDOFF.md
│           ├── DECISIONS/
│           ├── CONSTRAINTS/
│           ├── TASKS/
│           ├── RESEARCH/
│           ├── INPUTS/
│           ├── REFERENCES/
│           ├── WORKING/
│           ├── REVIEW/
│           └── DELIVERABLES/
└── .project-os/
    ├── registry/
    ├── transactions/
    ├── receipts/
    ├── artifacts/
    └── projects/
        └── PRJ-xxxx/
            ├── state.json
            ├── manifest.json
            ├── events/
            ├── commits/
            ├── materializations/
            ├── materialization-head.json
            ├── documents/
            └── mutation-gate/
                ├── intents/
                ├── candidates/
                ├── payloads/
                └── resolutions/
```

Folders are lazy. Empty project subdirectories are not required.

The Obsidian Vault may point only at:

```text
PROJECT_OS/WORKSPACE
```

Machine files must remain outside the Vault.

## 5. Canonical commit and projection deployment model

After `IMP-MATERIAL001`, a successful transaction does not wait for all human Markdown to be uploaded.

The production flow is:

```text
immutable canonical commit
  -> committed business result
  -> async projection target
  -> human/machine derivatives
  -> immutable completed-generation evidence
  -> materialization head
```

The canonical commit record remains the business truth.

It is valid for a short interval to observe:

```text
canonical_revision > materialized_head.revision
```

That state must automatically converge through ProjectGuard alarms or scheduled fleet reconciliation.

Do not classify projection lag as a business rollback. Do not create a new transaction merely to repair projection work.

Full materialization semantics are in `docs/materialization.md`.

## 6. Transaction ingress and receipt gate

Durable canonical changes use typed Project OS transactions.

Public ingress remains:

```text
POST /v1/transactions
Authorization: Bearer <INGRESS_TOKEN>
```

External project creation uses `PRJ-AUTO`; RegistryGuard allocates `PRJ-xxxx`.

The committed receipt remains the business persistence proof. For `project.create`, RegistryGuard owns publication of the final standalone committed receipt after registry finalization.

Normal users never need a materialization/sync command.

## 6A. Governed artifact/document/candidate ingress

Final business outputs must use governed ingress rather than raw Dropbox writes.

Public authenticated mutation routes include:

```text
POST /v1/artifacts
POST /v1/documents
POST /v1/mutation-candidates/resolve
Authorization: Bearer <INGRESS_TOKEN>
```

MutationGate distinguishes:

```text
SUBMITTED -> COMMITTED -> CANONICAL VERIFIED -> ACCEPTED
```

For an artifact, durable intent alone is `SUBMITTED`. A committed artifact receipt is `COMMITTED`; final provider bytes must also match the durable intent before the artifact is reported `CANONICAL VERIFIED`. Acceptance remains object-specific and is never inferred from provider file presence.

Unknown strict final-zone files are preserved as external candidates. Candidate list/status responses are compact and do not expose payload content; resolution reuses normal governed artifact/document flows.

Full contract: `docs/mutation-gate.md`.

## 7. Administrative existing-project materialization

The existing authenticated route remains for migration/recovery compatibility:

```text
POST /v1/admin/workspace-v2/materialize
Authorization: Bearer <INGRESS_TOKEN>
Content-Type: application/json
```

Example:

```json
{
  "project_ids": ["PRJ-0001", "PRJ-0002"]
}
```

This operation does not create a domain event or increment business revision. In current V2 projects with commit records it runs the projection coordinator synchronously until the current target is complete. Older historical snapshots without commit records retain the compatibility materialization path.

This endpoint is an administrative recovery/migration mechanism, not a normal user workflow command.

## 8. Materialization evidence

For a project:

```text
/PROJECT_OS/.project-os/projects/<PRJ>/materializations/REV-000072-PV-0001.json
/PROJECT_OS/.project-os/projects/<PRJ>/materialization-head.json
```

Completed generation records are immutable. The head is a small repairable pointer and must reference an existing validated record/root hash.

A generation can be `snapshot` or `delta`. Reconstruction is bounded to at most 128 generation records before a fresh snapshot is required.

`STATE.md` and `HANDOFF.md` are critical and must both be verified before the completed-generation record is published.

## 9. Projection concurrency and retries

Optional environment setting:

```text
PROJECT_OS_PROJECTION_CONCURRENCY=<1..4>
```

Default: `4`.

Do not configure above `4` in this package.

Dropbox operations use the existing resilient transport. Do not add an independent second retry layer in deployment scripts.

ProjectGuard alarms handle prompt retry. A technical failure keeps the canonical business result intact; after repeated alarm failures the object schedules a deferred retry. Permanent destination conflicts fail closed and leave the last materialization head unchanged.

## 10. Archive behavior

Archive business state can commit before human workspace movement.

The projection engine then:

- renders required archived-state views;
- moves active workspace to `ARCHIVE` when required;
- verifies critical files at archive destination;
- writes completed generation with `workspace_location=archive`;
- advances head.

If both active and archive roots are conflicting realities, do not delete or merge them automatically. Projection remains blocked for diagnosis while the canonical archived business state stays valid.

## 11. Obsidian and graph isolation

A single human Vault can be retained at `PROJECT_OS/WORKSPACE`.

For Project OS itself, a project-scoped graph filter is:

```text
path:"PROJECTS/PRJ-0002-project-os"
```

Entity links remain folder-qualified where needed. Matching titles/names across projects do not create implicit cross-project relationships.

Under incremental projection, a non-critical note can legitimately retain an older `revision` frontmatter when its semantic content was carried forward unchanged. Do not use arbitrary note frontmatter as the authoritative current project revision. Use canonical state and materialization head.

## 12. Pre-merge verification

Before a production merge:

```bash
npm install
npm run check
npx wrangler deploy --dry-run
```

Requirements:

- complete suite green on exact final PR head;
- dry-run green on exact final PR head;
- no production secret/config drift;
- continuity still `stable`;
- MutationGate default/config remains `observe` until its separate enforcement gate;
- no user-facing command/version-selection change;
- no direct PC/filesystem dependency introduced.

For MutationGate, pre-merge CI must include PRJ-0003-shaped bypasses, baseline/reset, governed crash recovery, candidate resolution crash recovery, multi-project isolation, service recreation and status-vocabulary tests.

For MODEL001, pre-merge CI must additionally prove:

- stale task/lifecycle and legacy completion operations conflict without a business revision;
- only `research.add`, `constraint.add`, `task.create`, and deprecated `deliverable.add` may stale-rebase;
- a committed stale additive rebase preserves submitted `transaction.base_revision` while recording the effective commit `previous_revision`;
- task lifecycle compatibility remains intact;
- pending/non-current or multiple-active phase completion fails closed;
- completed phases reject new task/normative deliverable attachment;
- phase completion does not fabricate child completion;
- superseded decisions cannot newly govern deliverables;
- historical schema-1.0 lifecycle combinations remain readable;
- ProjectGuard receipts expose the same conflict/commit semantics.

## 13. Exact-commit production deployment validation

After merge, record the exact merge commit SHA.

The deployment workflow on `main` must succeed for that exact SHA with all of these steps green:

- checkout;
- required credentials check;
- Node setup;
- dependency install;
- `npm run check`;
- Worker deploy;
- production health check;
- deployment-status publication.

Do not declare the package production-complete from PR CI alone.

## 14. `IMP-MATERIAL001` production-safe proof

Production validation for the projection engine must prove all of the following without direct edits to machine-managed state:

### A. Canonical revision can lead materialization head

Submit a normal controlled typed transaction and verify its committed business revision exists before/independently of completed human projection.

Observe briefly that canonical revision may be newer than materialization head, then verify the alarm/reconciliation path converges automatically to the same target revision.

### B. Carry-forward avoids an upload

Use a transaction whose semantic scope does not affect at least one non-critical global view (for example a task-only change that leaves `BRIEF.md` input unchanged).

Inspect the resulting completed delta record. The unchanged view must remain part of the logical output set while being absent from the changed delta evidence, proving it was carried forward rather than uploaded by the changed-output writer.

Deterministic CI additionally asserts exact Dropbox upload paths.

### C. `STATE.md` and `HANDOFF.md` are one completed generation

Verify both generated files show the target canonical revision and the materialization head references a completed record for that same revision/projection version.

### D. Exact replay is idempotent

Replay the same controlled transaction ID. The business revision must not increment and the original committed receipt must be returned.

### E. Continuity remains stable

Verify production continuity status/config still resolves to `stable`.

## 14A. `IMP-MUTATIONGATE001` observe-first production proof

First production rollout must keep:

```text
PROJECT_OS_CONTINUITY_MODE=stable
PROJECT_OS_MUTATION_GATE_MODE=observe
```

Do **not** repair historical PRJ-0003 deviations as part of initial deployment. Do **not** enable `enforce` in the same change.

Observe-mode validation must prove:

1. existing governed published/artifact outputs are classified as governed rather than candidates;
2. an isolated controlled unknown strict-zone file is preserved byte-for-byte and recorded as one candidate with no project revision/publication/acceptance effect;
3. baseline and cursor-reset paths do not bootstrap unknown `DELIVERABLES` as published;
4. a governed artifact intent survives provider-write/crash recovery without becoming a candidate or being rerouted after route drift;
5. candidate resolution exact replay is idempotent and a changed payload cannot reuse terminal resolution identity;
6. `SUBMITTED`, `COMMITTED`, `CANONICAL VERIFIED` and `ACCEPTED` are reported/used distinctly;
7. candidate evidence remains reconstructible from Dropbox after hot service/SQLite loss;
8. project isolation holds for candidate/intents/resolutions;
9. no candidate payload or secret value appears in logs/status responses.

Only after observe inventory is reviewed and production proof is accepted may `PROJECT_OS_MUTATION_GATE_MODE=enforce` be separately enabled.

Rollback from enforcement is configuration-only back to `observe`. Do not delete append-only intent/candidate/resolution evidence during rollback.

After MutationGate itself is production-validated, historical PRJ-0003 direct-write files are audited separately and adopted/rejected through governed flows. Do not resubmit an already accepted canonical decision such as `DEC-EXECUTABILITY001` merely because related files need governance repair.

After that repair, revalidate the accepted SCHEMA rollout design against MutationGate record families before resuming SCHEMA runtime implementation.

## 14B. `IMP-MODEL001` isolated production proof

MODEL001 production validation is a separate gate from MutationGate enforcement and from SCHEMA runtime. It must keep:

```text
PROJECT_OS_CONTINUITY_MODE=stable
PROJECT_OS_MUTATION_GATE_MODE=observe
```

Use an isolated synthetic project allocated through `PRJ-AUTO`; do not use PRJ-0003 or another business project as the mutation target.

The proof must record the exact MODEL001 merge SHA and demonstrate all of the following through normal typed transaction/receipt paths:

1. create the isolated project and a pending lifecycle target task;
2. add intervening research so canonical revision advances;
3. submit a stale lifecycle mutation against the target task and require `status=conflict`, `code=STALE_REVISION`, no event, and no revision increment;
4. submit the same lifecycle operation at the exact current revision and require a committed revision;
5. submit a unique stale additive `task.create` from an older base and require a committed revision after current-state validation;
6. verify the immutable commit record for the stale additive preserves the submitted `transaction.base_revision` and separately records the effective `previous_revision`;
7. close the probe work and archive the synthetic project through normal typed lifecycle operations;
8. read PRJ-0002 and at least one historical schema-1.0 project through normal paths without migration/rewrite;
9. verify production health, continuity `stable`, MutationGate `observe`, and confirm no PRJ-0003 repair or SCHEMA runtime action occurred.

MODEL001 rollback is code rollback only. Never rewrite canonical commit history to emulate rollback.

## 15. Recovery validation

Recovery scenarios to keep tested/documented:

- local ProjectGuard SQLite lost → recover from canonical snapshots/commit records;
- materialization SQLite lost → rebuild projection baseline from external completed-generation evidence;
- output upload interrupted → resume missing/uncertain output only;
- completed-generation record exists but head update failed → repair head with zero workspace rewrite;
- four fast canonical revisions → coalesce human projection safely while preserving every commit record;
- stale additive canonical commit → preserve original submitted base revision plus effective previous revision during read/recovery;
- archived projection retry → never resurrect active workspace;
- MutationGate artifact intent written + provider bytes landed + receipt missing → governed in-flight replay, no candidate;
- MutationGate candidate terminal marker written + resolution detail missing → repair detail without rerunning downstream;
- MutationGate service/hot cache lost → rebuild candidate identity/payload/resolution from Dropbox durable evidence.

## 16. Legacy/shadow notes

Historical `legacy` and `shadow` modes remain documented compatibility concepts. Production currently runs V2.

Do not perform legacy directory cleanup as part of `IMP-MATERIAL001` or `IMP-MUTATIONGATE001`. Deleting or archiving legacy Dropbox history is a separate destructive operation requiring explicit approval.

Legacy managed-document compatibility does not mean unknown final files may be auto-published. `WORKING`, `REVIEW` and `REFERENCES` keep bounded lazy adoption; unknown `DELIVERABLES` require governed provenance or become MutationGate candidates.

Likewise, alternate persistence providers are not introduced here. Dropbox remains the production provider until the later persistence-provider package is separately designed and approved.

## 17. Production completion gates

`IMP-MATERIAL001` is complete only after:

- exact final PR head CI succeeds;
- exact final PR head Wrangler dry-run succeeds;
- exact merge commit deploy succeeds;
- production health succeeds;
- continuity remains `stable`;
- canonical/head convergence is proven;
- carry-forward is proven;
- critical STATE/HANDOFF coherence is proven;
- replay idempotency is proven;
- canonical PRJ-0002 research evidence and task closure are recorded through normal receipt-gated transactions.

`IMP-MUTATIONGATE001` is production-complete only after its own exact final PR head/merge deployment proof, observe-mode production validation, accepted decision on enforcement rollout, any separately approved enforcement activation, and canonical PRJ-0002 evidence. PR CI alone does not authorize merge, deployment, `enforce`, PRJ-0003 repair or SCHEMA resumption.

`IMP-MODEL001` is production-complete only after exact final PR head verification, a separately authorized runtime merge/deployment, exact-merge deployment/health proof, isolated lifecycle/concurrency production proof, historical readability verification, and canonical PRJ-0002 research/task closure. MODEL001 completion does not authorize MutationGate `enforce`, PRJ-0003 repair or SCHEMA runtime.