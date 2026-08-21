# Project OS Deployment and Workspace V2 Rollout

Project OS keeps credentials out of GitHub, generated Markdown, Obsidian, and ChatGPT conversation text. The production system is a Cloudflare Worker backed by SQLite Durable Objects, using a Dropbox App Folder for persistence and Obsidian as a human reading/navigation layer.

## 1. Cloudflare Worker

Repository and runtime:

- Repository: `zakariafadli94/project-os`
- Worker: `project-os-guard`
- Production branch: `main`
- Build command: `npm install && npm run check`
- Deploy command: `npm run deploy`

`wrangler.jsonc` declares two SQLite-backed Durable Objects:

- `ProjectGuard` → `PROJECT_GUARD`
- `RegistryGuard` → `REGISTRY_GUARD`

It also declares the five-minute scheduled recovery trigger used to retry transactions that remain in the Dropbox incoming queue.

The deployment was provisioned with declarative Durable Object `exports`. Do not replace this with Wrangler `migrations`.

## 2. Required secrets

Production requires these Cloudflare secrets:

```text
DROPBOX_APP_KEY
DROPBOX_APP_SECRET
DROPBOX_REFRESH_TOKEN
INGRESS_TOKEN
```

Never commit or copy their values into Markdown. Documentation may contain the secret names and regeneration procedures only.

`INGRESS_TOKEN` protects both normal direct transaction ingress and the workspace migration administration endpoint.

## 3. Dropbox application

Use a dedicated scoped Dropbox application with App Folder access.

Required scopes:

```text
files.content.read
files.content.write
files.metadata.read
```

Authorize it with offline OAuth access (`token_access_type=offline`) and store the resulting refresh token only as the Cloudflare `DROPBOX_REFRESH_TOKEN` secret.

The Dropbox API root for Project OS is:

```text
/PROJECT_OS
```

The user-visible physical location is under the Dropbox application folder, for example on a French-localized account:

```text
Dropbox/Applications/project-os/PROJECT_OS
```

or the locale-equivalent `Dropbox/Apps/...` path.

## 4. Storage layout modes

Project OS V2 introduces one non-secret runtime switch:

```text
PROJECT_OS_LAYOUT_MODE=legacy|shadow|v2
```

When the variable is absent, the application must behave as `legacy`.

### legacy

The existing V1 layout remains authoritative:

```text
PROJECT_OS/
├── SYSTEM/
├── PROJECTS/
├── TRANSACTIONS/
└── RECEIPTS/
```

This is the safe rollback mode and remains the default until the migration is verified.

### shadow

V1 remains canonical for transaction queue, terminal transaction artifacts, registry, and receipts, while V2 is materialized in parallel:

```text
PROJECT_OS/
├── WORKSPACE/                 # new human-only layer
├── .project-os/               # new machine mirror
├── SYSTEM/                    # legacy canonical during shadow
├── PROJECTS/                  # legacy canonical during shadow
├── TRANSACTIONS/              # legacy canonical during shadow
└── RECEIPTS/                  # legacy canonical during shadow
```

A shadow write failure must fail before the legacy committed receipt is published. A receipt must never claim success when required shadow materialization failed.

### v2

After explicit verification and cutover, machine persistence is under `.project-os/` and human Markdown is under `WORKSPACE/`:

```text
PROJECT_OS/
├── WORKSPACE/
│   ├── PORTFOLIO/
│   │   ├── DASHBOARD.md
│   │   ├── RELATIONSHIPS/
│   │   └── REVIEWS/
│   └── PROJECTS/
│       └── PRJ-xxxx-slug/
│           ├── PROJECT.md
│           ├── STATE.md
│           ├── PLAN.md
│           ├── HANDOFF.md
│           ├── DECISIONS/
│           ├── CONSTRAINTS/
│           ├── TASKS/
│           ├── RESEARCH/
│           ├── REFERENCES/
│           ├── DELIVERABLES/
│           ├── SPECS/
│           ├── MEETINGS/
│           ├── NOTES/
│           ├── INBOX/
│           └── ASSETS/
└── .project-os/
    ├── registry/
    ├── transactions/
    ├── receipts/
    └── projects/
        └── PRJ-xxxx/
            ├── state.json
            ├── manifest.json
            └── events/
```

Folders are created lazily. Empty project subdirectories are not required.

## 5. Dropbox webhook and scheduled recovery

Webhook URL:

```text
https://<worker-host>/dropbox/webhook
```

Dropbox GET verification must echo `challenge` exactly. POST requests must pass Dropbox HMAC-SHA256 verification using `DROPBOX_APP_SECRET`.

The webhook is a wake-up signal only. The Worker processes the incoming transaction folder chosen by the layout mode:

```text
legacy/shadow: /PROJECT_OS/TRANSACTIONS/incoming/
v2:            /PROJECT_OS/.project-os/transactions/incoming/
```

The scheduled trigger executes the same processor every five minutes. Transiently failed source transactions remain in `incoming` and are retried idempotently.

## 6. Transaction ingress and receipt gate

Normal durable changes still use typed Project OS transactions. A new project uses:

```json
{
  "project_id": "PRJ-AUTO",
  "base_revision": 0,
  "operation": "project.create"
}
```

`RegistryGuard` allocates the canonical `PRJ-xxxx` ID.

The final committed receipt is always the proof of persistence. For `project.create`, the final receipt appears only after both per-project creation and registry persistence succeed.

The public direct ingress endpoint remains:

```text
POST /v1/transactions
Authorization: Bearer <INGRESS_TOKEN>
```

## 7. Existing-project workspace materialization

Workspace V2 migration does not create fake business events and does not increment project revisions.

Authenticated migration endpoint:

```text
POST /v1/admin/workspace-v2/materialize
Authorization: Bearer <INGRESS_TOKEN>
Content-Type: application/json
```

Example body:

```json
{
  "project_ids": ["PRJ-0001", "PRJ-0002"]
}
```

For each existing project, the migration:

1. resolves its canonical slug from RegistryGuard;
2. reads immutable V1 events from `PROJECTS/<PRJ>-<slug>/.system/events/`;
3. mirrors each event to `.project-os/projects/<PRJ>/events/` using add-if-absent semantics;
4. on destination conflict, requires byte-for-byte content equality;
5. calls the ProjectGuard non-mutating `/materialize` endpoint;
6. regenerates human views into `WORKSPACE/PROJECTS/<PRJ>-<slug>/`;
7. reports the existing business revision unchanged.

The operation is safe to rerun. It never deletes or moves V1 source material.

## 8. Obsidian Vault — V2 target

**Do not use the entire `PROJECT_OS/` root as the long-term Obsidian Vault after V2 shadow verification.**

The Vault root becomes only:

```text
Dropbox/Applications/project-os/PROJECT_OS/WORKSPACE
```

or the locale-equivalent Dropbox App Folder path.

This deliberately keeps these machine artifacts outside Obsidian indexing:

```text
.project-os/
SYSTEM/
TRANSACTIONS/
RECEIPTS/
legacy per-project .system/
```

The user should normally see only:

```text
PORTFOLIO/
PROJECTS/
```

inside the Vault.

## 9. Obsidian graph isolation

A single Vault is retained, but each project is treated as a separate logical graph.

Every generated project note contains stable frontmatter including:

```yaml
---
project_id: PRJ-0002
project_slug: project-os
project_name: Project OS
note_id: RES-CODE0001
note_type: research
canonical: true
revision: 19
---
```

For the Project OS project, use this graph filter:

```text
path:"PROJECTS/PRJ-0002-project-os"
```

For another project, substitute its exact project directory.

The unfiltered Vault graph is intentionally the Portfolio graph. It is not the working graph for an individual project.

Generated links between project entities are path-qualified, for example:

```text
[[DECISIONS/DEC-ARCH0001|Canonical architecture]]
```

Project OS must not generate cross-project links merely because two projects contain the same title, technology, client name, or alias. Intentional cross-project relationships belong under:

```text
WORKSPACE/PORTFOLIO/RELATIONSHIPS/
```

## 10. Shadow rollout procedure

Before changing production from legacy to shadow:

```bash
npm install
npm run check
npx wrangler deploy --dry-run
```

Then:

1. merge the reviewed feature branch to `main`;
2. deploy production with `PROJECT_OS_LAYOUT_MODE=legacy` first;
3. verify `GET /health`;
4. verify an ordinary transaction still follows the legacy path and receipt gate;
5. change only `PROJECT_OS_LAYOUT_MODE` to `shadow`;
6. redeploy;
7. verify health again;
8. run `/v1/admin/workspace-v2/materialize` for `PRJ-0001` and `PRJ-0002`;
9. compare V1 and V2 project IDs/revisions;
10. confirm V2 research, deliverables, tasks, constraints and decisions are readable Markdown;
11. inspect `WORKSPACE/` locally through Dropbox sync;
12. open `WORKSPACE/` as a temporary/new Obsidian Vault and validate project graph filters;
13. create one disposable/test project through the normal transaction flow in shadow mode;
14. verify both legacy canonical output and V2 shadow output;
15. run a clean-room recovery from a new chat/platform.

Do not cut over to `v2` if any discrepancy exists.

## 11. V2 cutover procedure

Only after the shadow checklist is clean:

1. ensure legacy data remains intact;
2. set `PROJECT_OS_LAYOUT_MODE=v2`;
3. deploy;
4. confirm health;
5. submit a controlled test transaction;
6. verify the incoming source and terminal transaction artifact are under `.project-os/transactions/`;
7. verify its receipt is under `.project-os/receipts/`;
8. verify human Markdown is updated only under `WORKSPACE/`;
9. verify the registry is under `.project-os/registry/`;
10. point the normal Obsidian Vault at `PROJECT_OS/WORKSPACE`;
11. verify project-specific graph isolation;
12. run the clean-room portability test again.

V1 directories remain untouched during this stage.

## 12. Rollback

Until explicit legacy cleanup approval, the rollback path is:

```text
v2 → deploy previous known-good Worker/code if needed → PROJECT_OS_LAYOUT_MODE=legacy
```

For a shadow issue, simply return to:

```text
PROJECT_OS_LAYOUT_MODE=legacy
```

because V1 remained authoritative throughout shadow mode.

Do not delete V1 `SYSTEM`, `PROJECTS`, `TRANSACTIONS`, `RECEIPTS`, or per-project `.system` history as part of initial rollout.

Legacy cleanup is a separate destructive operation and requires explicit user approval after successful clean-room validation.

## 13. Validation requirements

The following must remain true throughout migration:

- `PRJ-0001` and `PRJ-0002` IDs do not change;
- pure materialization does not increment business revision;
- immutable events are never silently overwritten with different content;
- receipts are written last;
- no machine event, receipt, transaction, registry JSON or state JSON is stored under `WORKSPACE/`;
- no human generated project Markdown is stored under `.project-os/`;
- no secret value appears in source or Markdown;
- duplicate transaction replay remains idempotent;
- project allocation remains globally unique;
- stale direction-changing mutations still conflict;
- scheduled recovery still retries unprocessed incoming transactions;
- Durable Object declarative `exports` remain configured.

## 14. Production cleanup

There is intentionally no automatic cleanup in the V2 feature.

Only after all of these are true:

- V2 has operated successfully in production;
- clean-room recovery succeeds from another session/platform;
- Obsidian navigation and project graph isolation are validated;
- canonical project state and event history have been compared;
- rollback is no longer required;

may a separate cleanup plan be proposed.

That cleanup must receive explicit approval before any legacy Dropbox directory is deleted or archived.
