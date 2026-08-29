# IMP-SCHEMA001 R0 post-disconnect evidence — 2026-08-29

This record documents the manual external cutover step required by IMP-SCHEMA001 R0 deployment-authority safety.

## Context

Before this cutover, Project OS had more than one mechanism capable of changing Cloudflare production traffic:

- GitHub Actions `.github/workflows/deploy.yml` on `main`;
- Cloudflare Workers Builds connected directly to `zakariafadli94/project-os`;
- the historical MutationGate repair workflow, which was subsequently constrained by the repo-side R0 change so operator versions do not become a second standard production promoter.

Historical evidence showed the Cloudflare Workers Builds integration could publish a separate Worker version after the GitHub Actions deployment for the same Git commit. R0 therefore requires Workers Builds to stop acting as an autonomous production promoter before any durable Schema V2 writer is activated.

## Manual account cutover

On 2026-08-29, the project owner disconnected the Git repository from the `project-os-guard` Worker in Cloudflare Dashboard under `Settings -> Builds`.

The post-action Cloudflare UI showed:

```text
Git repository    Connect
```

rather than a connected repository and `Disconnect` control.

This action disconnects the Cloudflare Workers Builds Git integration only. It does not delete or disable the `project-os-guard` Worker, its workers.dev endpoint, Durable Objects, variables, secrets, cron trigger, or the GitHub Actions deployment path.

## Required post-disconnect proof

The next `main` push after this record is merged is the verification probe for the external cutover:

1. GitHub Actions CI and the authoritative `deploy.yml` must run for the exact merge SHA.
2. Production health must remain green.
3. The authoritative deploy workflow must report the exact Git SHA / Worker version identity.
4. No new `Workers Builds: project-os-guard` check may be created for that post-disconnect SHA.

Only after those checks pass is R0 considered fully closed for IMP-SCHEMA001. Until then, the Schema writer stage remains `v1_only` and no production durable V2 write is authorized.
