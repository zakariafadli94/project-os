# MutationGate Ephemeral Operator Design

## Goal

Allow the Project OS control plane to execute governed MutationGate candidate resolutions without requiring the human operator to copy `INGRESS_TOKEN` into GitHub Actions or expose any secret in chat.

## Accepted direction

- Preserve the existing `INGRESS_TOKEN` and its current behavior unchanged.
- Add a separate optional Worker secret named `MUTATION_GATE_OPERATOR_TOKEN`.
- Accept that token **only** on `POST /v1/mutation-candidates/resolve`; it must not authorize `/v1/transactions`, artifact ingress, managed-document ingress, or any other route.
- Make the operator token short-lived by encoding its issue time and rejecting it after 15 minutes, even if secret cleanup fails.
- Generate a fresh cryptographically random token inside the GitHub Actions runner for each operator run and mask it immediately.
- Install the token with the already-configured Cloudflare deployment credentials using `wrangler secret bulk`; omitted Worker secrets, including `INGRESS_TOKEN`, remain unchanged.
- Verify Worker health after installing the token.
- Execute the existing deterministic candidate reject requests through the governed public endpoint and require `{status:"committed", action:"reject"}` plus identity matching for every candidate.
- In an `always()` cleanup path, delete only `MUTATION_GATE_OPERATOR_TOKEN`, verify Worker health again, and prove the removed token now receives HTTP 401.
- Keep `workflow_dispatch` for direct operator use.
- Add an owner-only, exact-title GitHub issue trigger so ChatGPT can launch the operator workflow through the existing GitHub connector without requiring the human to operate GitHub Actions. The event is an explicit auditable operator request, not an automatic push/deploy trigger.
- The issue-triggered path is intentionally scoped to the already validated PRJ-0003 eight-candidate reject repair; generic future candidate resolution continues to use `workflow_dispatch` inputs.

## Security invariants

1. No secret value is stored in the repository, Dropbox canonical state, issue text, logs, or chat.
2. `INGRESS_TOKEN` is never read, overwritten, rotated, or deleted by this workflow.
3. The ephemeral token is useless on every public mutation route except candidate resolution.
4. The ephemeral token expires after 15 minutes even if Cloudflare cleanup cannot run.
5. Cleanup runs after success or failure and deletion is verified by an authenticated-route 401 probe.
6. The issue trigger requires the repository owner as actor and an exact control issue title; arbitrary issues do not execute the repair.
7. Candidate resolution remains idempotent and governed by MutationGate terminal evidence.
8. No direct Dropbox write is introduced.

## Production behavior

Cloudflare documents that `wrangler secret bulk` preserves secrets omitted from the request, and that secret changes create/deploy a new Worker version. The workflow therefore health-checks both the installation and cleanup deployments. The code deployment that introduces operator-token support remains separately gated through the normal PR/CI/merge process before any repair run.
