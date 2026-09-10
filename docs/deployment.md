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
PROJECT_OS_BINARY_ARTIFACT_INGRESS_MODE=off
PROJECT_OS_BINARY_ARTIFACT_MAX_BYTES=10485760
```

Do not change continuity mode merely because a feature PR is merged. Transparent candidate rollout/cutover remains owned by the later deployment package.

Do not enable `PROJECT_OS_MUTATION_GATE_MODE=enforce` in the first MutationGate production deployment. `enforce` is a separate rollout gate after observe-mode inventory and production proof.

Binary artifact ingress also remains `off` when its implementation is first merged or deployed. Enablement is a separate, explicitly authorized production action after the checklist in `docs/binary-artifact-ingress.md` passes. Do not combine that activation with PRJ-0003 recovery.

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

That state must automatically converge through the per-project MaterializationGuard alarm or scheduled fleet reconciliation.

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

This operation does not create a domain event or increment business revision. In current V2 projects with commit records it runs one bounded projection slice. HTTP 202 with `status: "pending"` means the owner retained continuation and scheduled its alarm; HTTP 200 is reserved for a fully verified target. Historical V2 snapshots without a canonical commit baseline fail closed instead of starting a competing compatibility writer.

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

MaterializationGuard alarms handle prompt retry. A technical failure keeps the canonical business result intact; after repeated alarm failures the object schedules a deferred retry. Permanent destination conflicts fail closed and leave the last materialization head unchanged.

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

## 18. Persistence provider boundary operations

Production persistence construction is centralized in `createProductionPersistence` and remains hard-wired to the Dropbox adapter. There is no provider-selection environment variable. Keep the existing `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, and `DROPBOX_REFRESH_TOKEN` secret contract unchanged.

Core Worker/Durable Object code consumes provider-neutral object operations and explicit capabilities for conditional write, server-side copy, incremental change feed, stable object ID, revision token, and integrity hash. Retry handling consumes neutral provider errors; Dropbox-specific status and request diagnostics are translated inside the Dropbox adapter.

Schema `1.0` durable evidence remains Dropbox V1-shaped. `provider_file_id`, `provider_rev`, `provider_content_hash`, MutationGate provider preconditions/candidates, and related managed-document observations must not be generalized by deployment configuration. Any persisted-format generalization, alternate provider, migration or upcaster belongs to IMP-SCHEMA001 and requires a separate rollout.

Persistence-boundary rollout must not change `PROJECT_OS_CONTINUITY_MODE=stable` or `PROJECT_OS_MUTATION_GATE_MODE=observe`. It does not authorize PRJ-0003 repair, MutationGate enforcement, or SCHEMA runtime.

## 19. Permanent convergence rectification verification (2026-09-09)

Local verification on branch `fix/permanent-convergence-rectification` established the following code evidence before rollout:

- exact clean implementation SHA before this evidence-only commit: `2a3259e0965103f6ba1338bd3161e674ac4c8a3b`;
- `npm ci` completed from the checked-in lockfile;
- `npm run check` reached the complete test gate after all static/type gates; the final standalone full run passed 191 files and 906 tests;
- `npm run test:persistence-high-risk` passed 26 files and 148 tests, in addition to the four-test search-off gate;
- `wrangler deploy --dry-run` completed at the exact SHA above with a 1,596.34 KiB bundle (268.10 KiB gzip) and performed no deployment;
- no canonical Dropbox write, merge, activation or PRJ-0003 repair was performed.

Production rollout remains blocked. PR #147 is still draft and its governed promotion route is therefore non-migrated; PR #139 is still open and must be integrated/revalidated rather than copied implicitly. A real monitoring adapter has not produced an alert delivery ACK, and the isolated ≥24 h canary/capacity/recovery qualification has not occurred. Consequently `notification_ack_proven`, `transport_complete`, `capacity_qualified`, `recovery_qualified`, and `compatible_stable_ready` remain false. Admission stays `observe`, convergence activation stays off for production projects, and PRJ-0003 must remain untouched.

Read-only preflight on 2026-09-09 reconfirmed #147 at `fcedf969e7d7e3e0de18ed258eb151f3f9699e75` and #139 at `900dace142b8d73b08a9192a162befaa5016c7af`. Both heads are based on divergent trees: a direct merge would remove active convergence modules relative to the retained `main` baseline. They require owner-compatible rebases or narrowly reviewed adapter ports before integration, followed by full transport and recovery requalification. No merge or cherry-pick of either prerequisite was attempted.

Follow-up local verification on implementation SHA `9968f150f6a8cf7b49987edec13ce274c9d5c336` passed all static/type gates, 193 test files / 930 tests, the 26-file / 148-test persistence high-risk gate, and the 12-file / 56-test integration selection. On 2026-09-09, an initially incorrect `npm exec` invocation consumed the `--dry-run` argument and published Worker version `5a04d64a-4b58-4ea8-bf5b-9ddfe9867536`. It was immediately rolled back to the previously active, GitHub Actions version `ee70bfa3-8571-4d69-b7be-c999d47e0e67` (SHA `a7b927499265c625ab3f5827f34d94235ea19d0b`), which Cloudflare then reported at 100% of traffic. The exact invocation `npm exec -- wrangler deploy --dry-run` subsequently completed on SHA `a46fd1be6fcd1d02d16cbff8db7c7d84f8c97960` with `--dry-run: exiting now`; deployment history showed no further deployment. A rollback does not reverse bound-resource effects, so the brief accidental deployment must be included in the next authorised production audit before any activation or PRJ-0003 action. This incident does not relax any rollout gate.

The code now supports an optional HTTPS monitoring receiver through `PROJECT_OS_MONITORING_WEBHOOK_URL` and `PROJECT_OS_MONITORING_WEBHOOK_TOKEN`, but this does not change the blocker: no endpoint has been configured, deployed, or acknowledged an incident in production.

Convergence slices also emit a fixed structured metric envelope (attempts, verified obligations, retry/exhaustion state, lag, queue age, and bounded I/O consumption) to Worker runtime logs. This supports export and future SLO measurement without exposing payloads or turning a successful log write into a health signal. It is not a substitute for the required durable incident ACK, external watchdog, or isolated 24-hour canary.

Final local qualification after the uncertain-attempt recovery fix was performed on implementation SHA `4a2a1f41bd5d666ee7cd404aa5b9925c1716ef33`. The engine now reconstructs a durable retry wait when a crash loses the checkpoint that followed an immutable failed-attempt reservation. The Cloudflare test harness also serializes files because its Durable Object bindings and process-wide Dropbox interceptor are shared test resources; the default parallel execution reproduced a harness race, while the serialized suite is deterministic. The exact SHA passed type checking, all six static safety contracts, the four-test search-off gate, the 193-file / 931-test full suite, the 26-file / 148-test persistence high-risk gate, and the 12-file / 56-test final integration selection. `wrangler deploy --dry-run` on that SHA bundled 1,670.91 KiB (281.56 KiB gzip) and exited before deployment.

The 2026-09-09 read-only remote preflight was repeated after this qualification: `main` remains `a7b927499265c625ab3f5827f34d94235ea19d0b`; #147 remains draft at `fcedf969e7d7e3e0de18ed258eb151f3f9699e75` on base `696714deea50e83d6c459bc8901e0d6408841eb3`; #139 remains open at `900dace142b8d73b08a9192a162befaa5016c7af` on base `03d6b7f4e765016bcd7335101a82eb394b0a32b0`. Their divergent trees still delete active convergence surfaces relative to retained `main`; owner-compatible integration remains a prerequisite. No merge, production activation, canonical Dropbox mutation, monitoring ACK exercise, canary, or PRJ-0003 repair occurred in this qualification.

The latest clean implementation SHA is `00250b623ee88bdcbed71252223b4adaee179c17`. It adds fail-closed preservation of a strict admission floor, read-only health in `observe`, and fresh signed context through candidate resolution. On this SHA, TypeScript, all static contracts, the synthetic revision-258/capacity selection (57 tests), the persistence high-risk gate (26 files / 148 tests), and the complete suite (193 files / 935 tests) passed. Direct `wrangler deploy --dry-run` produced a 1,673.38 KiB bundle (282.11 KiB gzip) and exited before upload.

Regression SHA `3bbf7d2102dffeca834368cc8c5336840a2f8fda` adds the missing exhaustive synthetic outage proof: after a verified revision-257 pair, six durable HANDOFF failures for fictitious `PRJ-9258` / revision 258 leave the old head authoritative, preserve the original receipt bytes, record an immutable incident, and create no revision 259. A scheduled slice at 20 minutes later alone restores the pair and head at 258, then resolves that same incident. The 13-file synthetic/capacity selection passed 58 tests and the full suite passed 193 files / 936 tests. This is a test-only commit; it did not touch Cloudflare configuration, Dropbox canonical state, or PRJ-0003.

This remains implementation evidence only. Production is still blocked by owner-compatible integration of #147 and #139, a configured monitoring receiver with a real ACK and recovery exercise, and an isolated 24-hour canary. Production admission remains `observe`, convergence remains off for real projects, and PRJ-0003 remains untouched.

## 20. Final rectification gate (2026-09-09)

Implementation SHA `b7bca495c4805256db49b8db937d4b4ffc133176` passed TypeScript generation/checking, the seven static safety contracts, the four-test search-off gate, the 26-file / 148-test persistence high-risk gate, and the complete 201-file / 971-test suite. Its direct `wrangler deploy --dry-run` bundle was 1,736.38 KiB (294.40 KiB gzip) and ended with `--dry-run: exiting now`; no upload or deployment occurred.

The local branch is based on verified `origin/main` `a7b927499265c625ab3f5827f34d94235ea19d0b`. `origin/pr-139` remains a separate local reference and was not merged; no local reference for #147 was integrated. The Cloudflare dashboard could not be read because its browser security policy was unavailable, so this qualification makes no claim about the deployed dashboard state. No Cloudflare setting, Dropbox canonical file, canary, merge, or PRJ-0003 repair was changed.

This is still a code gate only. Compatible owner integration for #147/#139, an external monitoring ACK/recovery exercise, an explicitly authorized isolated 24-hour canary, and the resulting recovery/capacity evidence are all required before any activation, deployment, or official PRJ-0003 remediation.

Implementation SHA `d63578252e7d64329540ce001ad0dc908d906454` closes the final local monitoring boundary found in review: the five-second deadline now covers both the HTTPS request and parsing of its acknowledgement body. A regression with a successful response whose JSON body never resolves was red before the correction and is green after it. The exact SHA passed TypeScript generation/checking, all seven static safety contracts, search-off (4 tests), the 26-file / 148-test persistence gate, and the complete 201-file / 972-test suite. Its direct `wrangler deploy --dry-run` bundle was 1,736.42 KiB (294.42 KiB gzip) and ended with `--dry-run: exiting now`; no upload or deployment occurred. This does not create a monitoring ACK or relax any production gate.

## 21. Deferred human-alert rollout policy (2026-09-10)

The operator has deliberately deferred every human-facing notification channel. Implementation commit `de7cd36` adds an explicit `HumanAlertPolicy`: rollout evidence remains fail-closed by default, while an explicitly recorded `deferred` policy excludes only `notification_ack_proven` from `rolloutBlockers`. The acknowledgement field remains false; durable incidents, delivery retries, and structured metrics remain unchanged. No Cloudflare variable, notification provider, deployment, canary, canonical Dropbox mutation, merge, or PRJ-0003 repair was performed.

This operational-policy exception supersedes only the previous requirement for a human-delivery ACK. Owner-compatible integration, complete transport, reader/writer compatibility, fencing, RegistryGuard continuation, qualified capacity and recovery, and isolated canary qualification remain production gates.

## 22. Isolated canary evidence and remaining time gate (2026-09-10)

The current production canary runs Worker version `7e624e43-d288-4cf5-97bd-cbc43c11aa33`, deployed at 100% at `2026-09-10T17:26:03.400882Z` with the deployment annotation `Preserve verified canary and legacy admission`. Its source archive was assembled from retained `main` `c9c9fde26daf7ea82db2503acfc7b52c573e3c47`; `/health` reports that exact Worker version but intentionally does not claim an embedded Git SHA.

The sole active convergence writer configuration is `PRJ-0008: repair`. A real authenticated materialization request for this synthetic canary returned `materialized` at canonical revision 2. Its durable materialization head is revision 2 / projection version 3, and the corresponding human handoff is durably verified. The read-only diagnostic endpoint may still display bounded layer observations as `unknown`; it does not reconcile or repair, and it is not used as a false negative after the durable verified-target evidence has established currentness.

The same deployment returned a fresh authenticated mutation context for PRJ-0003 at canonical revision 267. This proves the historical-snapshot admission reader is live; it does not enable a PRJ-0003 writer, start a repair, or alter Dropbox.

GitHub Actions run `34507075052` passed its complete CI job on the merged source, and the exact source also passed the local full suite (203 files / 1,015 tests), static checks, and a Cloudflare dry run. Human-facing alert delivery remains deliberately deferred under the policy recorded above; immutable incidents, retry state, and payload-free metrics remain enabled.

The isolated canary's required 24-hour qualification clock starts from this current deployment. No extension, PRJ-0003 activation, or canonical repair is permitted before `2026-09-11T17:26:03Z`, and it additionally requires the planned observation, recovery, capacity, and rollback evidence to remain satisfactory. No deliberate fault is injected into PRJ-0003.
