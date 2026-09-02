# ProjectGuard / MaterializationGuard Isolation Design

## Status

Architecture approved in chat on 2026-09-02. This written specification is the review gate before implementation planning. It does not itself authorize runtime changes, production deployment, or canonical Project OS state mutation.

## Incident context

PRJ-0003 repeatedly hit Cloudflare's external subrequest ceiling while ProjectGuard attempted to process otherwise ordinary typed transactions. Successive production-safe diagnostics proved that the failure occurs on the **first Dropbox `files/download` request inside ProjectGuard**, before the transaction performs any meaningful canonical work.

The critical observed signal is:

```text
Dropbox HTTP files/download request #1 for .../PRJ-0003/state.json failed:
Too many subrequests by single Worker invocation.
```

This rules out a transaction-local 50-call loop. It also rules out canonical commit replay as the primary cause: PRJ-0003's machine snapshot and immutable commit ledger were current and contiguous. A prior correction serialized ProjectGuard's materialization alarm with transaction fast-forward work, but production still reproduced the same request-#1 exhaustion.

The remaining root cause is architectural coupling: canonical mutation and potentially heavy projection/materialization work share one ProjectGuard Durable Object instance and therefore one Cloudflare I/O context across concurrent requests. Promise queues prevent application-level overlap, but they do not create an independent runtime I/O context.

## Relationship to the accepted roadmap

This is an incident-driven corrective architecture change to the already-accepted `IMP-MATERIAL001` Projection Engine, not a new competing roadmap package. `IMP-INDEX001` remains the active sequenced product improvement.

The design preserves the accepted Projection Engine contract:

```text
canonical commit = business truth
projection = derived, asynchronous, resumable, reconstructible
```

The only material change is the Cloudflare execution boundary used for projection work.

## Goal

Separate canonical Project OS mutation work from projection/materialization work so that heavy Dropbox projection I/O cannot exhaust the external-subrequest budget available to ProjectGuard transaction processing.

After the change:

```text
ChatGPT / inbox / API
        |
        v
ProjectGuard  -----------------------> canonical Dropbox records
  |                                        (commit/state/receipts)
  |
  +-- lightweight internal target handoff
        |
        v
MaterializationGuard ---------------> projection Dropbox I/O
        |
        +--> STATE.md / HANDOFF.md / entity views
        +--> materialization generation evidence/head
```

ProjectGuard and MaterializationGuard are separate Durable Object classes and separate bindings. Each project uses one named instance of each class.

## Hard invariants

1. **Canonical commit truth remains unchanged.** Immutable commit records remain the authoritative business commit boundary.
2. **Projection failure never invalidates a committed business revision.**
3. **ProjectGuard must not perform human-view materialization or projection Dropbox I/O.**
4. **MaterializationGuard must never create or mutate business revisions.** It reads canonical truth and writes derived projection outputs/evidence only.
5. **No user-visible sync command is introduced.** Projection remains automatic.
6. **Projection hot state remains reconstructible.** Loss of MaterializationGuard SQLite must be recoverable from canonical commits plus durable materialization generation/head evidence.
7. **Existing external APIs remain compatible.** Administrative materialization/status routes may be internally rerouted but retain their observable response contract where practical.
8. **Project isolation is preserved.** A `PRJ-xxxx` ProjectGuard hands off only to the same-named `PRJ-xxxx` MaterializationGuard.
9. **Fail closed on binding mismatch.** A MaterializationGuard request naming a different project than its Durable Object name is rejected.
10. **The current `IMP-INDEX001` work is not implicitly modified or completed by this corrective change.**

## Chosen architecture

### 1. New `MaterializationGuard` Durable Object

Add a dedicated Durable Object class responsible for projection state and execution.

It owns:

- `MaterializationLedger` SQLite state;
- `MaterializationCoordinator`;
- `WorkspaceProjectionWriter`;
- projection alarms;
- projection status/reconcile/materialize routes;
- reconstruction of projection hot state from durable canonical/materialization evidence.

It does **not** own:

- transaction receipts;
- canonical ProjectState mutation;
- immutable canonical commit creation;
- task/decision/research lifecycle transitions;
- managed-document business mutation semantics;
- RegistryGuard status mutation.

### 2. New Cloudflare binding

Add:

```text
MATERIALIZATION_GUARD -> MaterializationGuard
```

with SQLite Durable Object storage.

`Env` gains the generated binding through Cloudflare types; handwritten environment augmentation should remain limited to optional scalar configuration.

### 3. ProjectGuard becomes canonical-only with respect to materialization

After a successful canonical V2 commit, ProjectGuard performs only a lightweight internal Durable Object call:

```text
POST MaterializationGuard /request-target
{
  project_id,
  revision,
  projection_version
}
```

The handoff is scheduling, not business truth.

If the handoff fails **after** the immutable canonical commit is durable:

- the canonical receipt remains committed;
- ProjectGuard logs structured scheduling failure;
- periodic reconciliation later discovers the lag and re-requests the target;
- no rollback or additional business revision occurs.

ProjectGuard no longer creates/runs a local materialization coordinator and no longer owns a projection alarm.

### 4. MaterializationGuard target handling

`POST /request-target` must be idempotent and monotonic for a projection version:

- older target than current requested/active/completed head -> no regression;
- same target -> no-op/idempotent acknowledgement;
- newer target -> coalesce to newest desired revision;
- projection-version change -> treated as a distinct projection target according to existing Projection Engine rules.

The route stores target intent in its local ledger and arms the MaterializationGuard alarm. It must not synchronously render the whole generation.

### 5. Alarm ownership

Only MaterializationGuard runs projection alarms.

Its `alarm()` executes bounded materialization work through the existing coordinator, preserving:

- per-output resumability;
- bounded provider concurrency;
- hash verification;
- immutable completed-generation evidence;
- materialization-head publication order;
- retry/defer behavior;
- coalescing of newer revisions.

No ProjectGuard alarm should perform projection Dropbox I/O after cutover.

### 6. Status and reconciliation routing

Existing administrative behavior is preserved by rerouting projection-specific operations to MaterializationGuard.

MaterializationGuard exposes at minimum:

```text
GET  /status
POST /reconcile
POST /materialize
POST /request-target
```

`/status` returns the existing materialization status shape:

- project_id;
- canonical_revision;
- projection_version;
- materialized_head;
- requested;
- active;
- blocked_error;
- output counts.

To report `canonical_revision`, MaterializationGuard reads canonical machine state using its **own** persistence/I/O context. That read is deliberately outside ProjectGuard.

`/reconcile` compares canonical state and durable projection evidence, repairs/coalesces target intent, and arms work if projection is behind.

`/materialize` remains the explicit administrative full-convergence route used by existing migration/operator tooling. It executes in MaterializationGuard, never ProjectGuard.

### 7. Worker-level routing

Update worker/admin paths so projection-specific calls address `MATERIALIZATION_GUARD.getByName(projectId)` directly.

Examples:

- periodic `reconcileMaterializations()` -> MaterializationGuard `/reconcile`;
- explicit workspace V2 materialize -> MaterializationGuard `/materialize`;
- status reads -> MaterializationGuard `/status`.

Transaction/artifact/document/referral routing remains ProjectGuard/RegistryGuard as today.

### 8. Hot-state migration strategy

No direct migration of the old ProjectGuard materialization SQLite tables is required.

Reason: their contents are operational acceleration, not canonical truth. The accepted Projection Engine already requires reconstructibility from:

- immutable canonical commit records / machine ProjectState;
- immutable completed-materialization generation records;
- materialization head.

On first use, MaterializationGuard reconstructs/coalesces from those durable records. Old local ProjectGuard materialization tables may remain physically present in existing ProjectGuard SQLite but become dead/unused state; they are not read after cutover.

This avoids an in-place DO storage migration and reduces deployment risk.

### 9. Compatibility cutover

For one release, ProjectGuard may retain compatibility handlers for legacy projection endpoints, but those handlers must **forward internally to MaterializationGuard** rather than execute projection logic locally.

This protects callers/tests that still address:

```text
ProjectGuard /materialization-status
ProjectGuard /reconcile-materialization
ProjectGuard /materialize
```

The forwarding layer must not fetch Dropbox itself.

Once repository callers are migrated and production evidence is stable, those compatibility paths may be removed in a later explicit cleanup, not as part of this incident fix unless trivial and fully proven.

## Failure semantics

### Canonical commit succeeds, handoff fails

Result: transaction stays committed. Projection lag is observable and reconciled later.

### MaterializationGuard crashes mid-generation

Result: no business revision impact. Existing coordinator recovery resumes from ledger/durable generation evidence.

### Materialization output conflicts

Result: same fail-closed projection behavior as today; conflict blocks that projection generation, not canonical history.

### MaterializationGuard hot SQLite is lost

Result: reconstruct from canonical state + completed-generation evidence; schedule current canonical target if projection head is behind.

### ProjectGuard hot SQLite is lost

Result: existing canonical snapshot/commit recovery remains unchanged and no longer needs to rebuild projection work locally.

### Cross-project request

Result: reject with a binding mismatch; never project another project's state through the wrong DO.

## Security and trust boundary

No new public unauthenticated endpoint is introduced. MaterializationGuard is reached only through Worker/internal Durable Object bindings.

It receives only project identity + projection target metadata from ProjectGuard/admin orchestration. It does not receive authority to mutate canonical business state.

## Observability requirements

Structured logs for projection handoff/execution should include when available:

- project_id;
- target revision;
- projection version;
- deployment/version identity;
- operation (`request-target`, `reconcile`, `alarm`, `materialize`);
- materialization generation/head revision;
- provider failure message.

The existing Dropbox runtime request diagnostic remains in place during rollout because it is useful evidence that canonical ProjectGuard I/O no longer begins with an already exhausted context.

## TDD and verification plan

Implementation begins with failing tests demonstrating the new boundary.

Required regression tests:

1. **separate DO binding** — projection target scheduling from a canonical commit calls `MATERIALIZATION_GUARD`, not ProjectGuard's local materialization coordinator;
2. **no ProjectGuard projection alarm** — running the ProjectGuard alarm cannot perform projection Dropbox reads/writes;
3. **MaterializationGuard alarm owns projection I/O** — its alarm advances/resumes a generation and writes normal projection evidence;
4. **canonical commit independent of projection handoff failure** — forced MaterializationGuard scheduling failure leaves the canonical transaction receipt committed;
5. **reconciliation repairs missed handoff** — current canonical revision with stale projection head is re-requested by MaterializationGuard reconciliation;
6. **cold-start reconstruction** — fresh MaterializationGuard SQLite reconstructs status from durable materialization evidence and canonical state;
7. **coalescing** — targets N then N+1 converge to N+1 without regressing;
8. **binding mismatch** — wrong project ID is rejected without provider mutation;
9. **compatibility forwarding** — legacy ProjectGuard projection routes, if retained, forward to MaterializationGuard without local Dropbox projection I/O;
10. **existing Projection Engine fault tests remain green**;
11. **existing canonical crash/recovery/high-risk tests remain green**;
12. **production canary** — after deploy, a stale/rejected PRJ-0003 transaction can reach ProjectGuard and return its expected business conflict/rejection instead of `files/download request #1` subrequest exhaustion.

Repository verification gates remain:

```text
npm run check
npm run test:persistence-high-risk
npx wrangler deploy --dry-run
```

Production gate additionally requires exact Git SHA deployment identity + `/health` success before any PRJ-0003 recovery transaction is reissued.

## Rollout sequence

1. Add tests that fail on the current single-DO architecture.
2. Add `MaterializationGuard` class/binding and move coordinator/alarm ownership.
3. Change ProjectGuard commit scheduling to internal target handoff.
4. Reroute worker materialization reconcile/materialize/status calls.
5. Preserve compatibility forwarding where required.
6. Run full CI/high-risk/dry-run gates.
7. Merge with exact head SHA protection.
8. Deploy exact Git release and verify health/identity.
9. Run a **non-mutating/stale PRJ-0003 canary first**. Expected result: normal ProjectGuard business conflict/rejection, not subrequest exhaustion.
10. Only after that proof, refresh PRJ-0003 revision and reconstruct any still-valid quarantined business intents with new transaction IDs/base revisions as required by concurrency rules.
11. Record the material architecture/infrastructure change canonically in PRJ-0002 with exact PR/SHA/CI/deployment evidence.

## Non-goals

- raising Cloudflare subrequest limits as the primary fix;
- changing Dropbox as the persistence provider;
- redesigning canonical commit format;
- changing ProjectState schema;
- changing managed-document lifecycle semantics;
- changing Mutation Gate business semantics;
- implementing `IMP-INDEX001` as part of this incident fix;
- automatically replaying stale quarantined PRJ-0003 transactions without semantic revalidation.

## Acceptance criteria

The correction is complete only when all of the following are true:

- ProjectGuard canonical transaction processing no longer shares projection execution state/alarm ownership;
- materialization runs in a separately bound Durable Object;
- full repository verification is green;
- production serves the exact merged SHA and health is green;
- a PRJ-0003 canary reaches normal revision/business validation instead of failing on Dropbox request #1;
- no unintended PRJ-0003 business revision is created during canary validation;
- projection lag/recovery still works after cold-start/restart tests;
- PRJ-0002 contains a committed governance record with authoritative source evidence.
