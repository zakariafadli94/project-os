# Project OS V1 Deployment

This deployment intentionally keeps credentials out of GitHub and out of ChatGPT conversation text.

## 1. Cloudflare Worker

Create/import a Cloudflare Worker from the private GitHub repository:

- Repository: `zakariafadli94/project-os`
- Worker name: `project-os-guard`
- Validation branch during V1 bring-up: `feat/project-os-v1`
- Final production branch after verification: `main`
- Build command: `npm install && npm run check`
- Deploy command: `npm run deploy`

The Worker name must match `name` in `wrangler.jsonc`.

`wrangler.jsonc` declares two SQLite-backed Durable Object classes:

- `ProjectGuard` → binding `PROJECT_GUARD`
- `RegistryGuard` → binding `REGISTRY_GUARD`

It also declares a scheduled recovery trigger every five minutes. The cron calls the same inbox processor as the Dropbox webhook; it exists only to recover missed webhook delivery or transient processing failures.

Do not create Durable Object namespaces manually when Wrangler can reconcile them from repository configuration.

## 2. Cloudflare secrets

Configure exactly these production secrets in the Worker. Never commit their values:

```text
DROPBOX_APP_KEY
DROPBOX_APP_SECRET
DROPBOX_REFRESH_TOKEN
INGRESS_TOKEN
```

`INGRESS_TOKEN` must be a high-entropy random secret. It protects `POST /v1/transactions`.

The Dropbox webhook uses `DROPBOX_APP_SECRET` for HMAC verification.

## 3. Dropbox Developer App

Create a scoped Dropbox app dedicated to Project OS.

Recommended content access:

```text
App Folder
```

This limits the app credential to its dedicated Dropbox app folder instead of the user's whole Dropbox.

Required scopes for V1:

```text
files.content.read
files.content.write
files.metadata.read
```

`files.metadata.read` is required for Dropbox webhook notifications on scoped apps.

The app must be authorized with offline access so Cloudflare can run unattended. The OAuth authorization request must include:

```text
token_access_type=offline
```

Exchange the returned authorization code for a refresh token and store that refresh token as the Cloudflare secret `DROPBOX_REFRESH_TOKEN`.

Do not paste the app secret, refresh token, or ingress token into a ChatGPT conversation.

## 4. Dropbox path mapping

Project Guard uses paths relative to the Dropbox app's API root:

```text
/PROJECT_OS/
```

With an App Folder-scoped Dropbox application, the user's Dropbox UI/local sync will show the same data under the app's physical folder, for example:

```text
Dropbox/
└── Apps/
    └── <Dropbox app folder>/
        └── PROJECT_OS/
            ├── SYSTEM/
            ├── PROJECTS/
            ├── TRANSACTIONS/
            └── RECEIPTS/
```

The exact `<Dropbox app folder>` name is determined by the Dropbox app configuration.

No empty project hierarchy needs to be created manually. The first committed writes create folders lazily through Dropbox file paths.

## 5. Dropbox webhook and scheduled recovery

After the Cloudflare Worker has a stable `workers.dev` URL, register this webhook in the Dropbox app console:

```text
https://<worker-host>/dropbox/webhook
```

Dropbox first sends a GET verification request with `?challenge=...`. The Worker echoes the exact challenge and returns `X-Content-Type-Options: nosniff`.

Subsequent POST webhook requests are accepted only when `X-Dropbox-Signature` matches the HMAC-SHA256 of the exact request body using `DROPBOX_APP_SECRET`.

The webhook notification is only a wake-up signal. Project OS scans only:

```text
/PROJECT_OS/TRANSACTIONS/incoming/
```

It does not scan or interpret arbitrary Dropbox files.

A Cloudflare scheduled trigger runs every five minutes and executes the same inbox scan. Successfully processed transactions have already been removed from `incoming/`, while failed transient operations remain there and are retried idempotently.

## 6. ChatGPT transaction ingress

The normal ChatGPT/Dropbox flow places one JSON transaction per durable change into:

```text
<visible Dropbox app folder>/PROJECT_OS/TRANSACTIONS/incoming/TXN-....json
```

The JSON filename must exactly match `transaction_id`.

A new project uses:

```json
{
  "project_id": "PRJ-AUTO",
  "base_revision": 0,
  "operation": "project.create"
}
```

`RegistryGuard` replaces `PRJ-AUTO` with the next canonical `PRJ-xxxx`; ChatGPT never allocates canonical project IDs itself.

For `project.create`, the per-project guard writes the project state/event first but intentionally does not publish the final Dropbox receipt. `RegistryGuard` then updates the global registry and only after that succeeds writes the `committed` receipt. This prevents a user-visible success proof from existing while the global registry is still stale.

For non-creation transactions, `project_id` must be an existing `PRJ-xxxx`.

## 7. Obsidian

Install Dropbox desktop sync on the Mac, then open this folder as the Obsidian Vault (or as a folder inside a larger Vault):

```text
Dropbox/Apps/<Dropbox app folder>/PROJECT_OS/
```

Obsidian is a human view/editing surface. Machine-managed generated documents include a warning comment. V1 does not support arbitrary two-way reconciliation of manual edits inside machine-managed sections.

## 8. Verification before production

Before promoting `main`, all of these must succeed:

```bash
npm install
npm run check
npx wrangler deploy --dry-run
```

And the following behavioral tests must pass:

- duplicate transaction replay commits once;
- global project allocation never duplicates a project ID;
- duplicate project identity is rejected;
- `project.create` does not publish a final receipt until registry persistence succeeds;
- scheduled recovery processes an incoming transaction even without a webhook;
- stale additive research can apply by explicit rule;
- stale L2 direction changes conflict;
- Durable Object eviction preserves state/idempotency;
- Dropbox write retry cannot produce a false committed receipt;
- path traversal is rejected;
- arbitrary operations such as `edit_file` are rejected;
- webhook HMAC verification rejects modified bodies;
- materialized Markdown can be regenerated from structured state.

## 9. Production promotion

Once validation on `feat/project-os-v1` is green:

1. merge PR #1 into `main`;
2. set Workers Builds production branch to `main`;
3. deploy `main`;
4. confirm `GET /health` returns `{ "status": "ok" }`;
5. register/verify the Dropbox webhook;
6. send one pilot `project.create` transaction;
7. confirm the receipt, project folder, event, state, handoff and Obsidian sync;
8. leave the pilot transaction path idle long enough to confirm the scheduled recovery trigger is deployed and healthy.

Do not bulk-migrate projects until the pilot completes end-to-end.
