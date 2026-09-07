# PRJ-0002 Ephemeral INPUT Recovery Operator Design

## Goal

Recover the remaining historical `INPUTS/` entries for `PRJ-0002` without copying, rotating, or exposing the persistent production `INGRESS_TOKEN`.

## Context

The guarded recovery workflow is valid on `main`, but run `34092721347` stopped before mutation because GitHub Actions has no `INGRESS_TOKEN` secret. Cloudflare secrets are intentionally unreadable, so the existing value cannot be copied into GitHub. Rotating the shared ingress token would risk breaking unknown callers and is outside this remediation.

## Architecture

Extend the existing zero-traffic operator-version pattern used by MutationGate with a separate `INPUT_RECOVERY_OPERATOR_TOKEN`. The token is accepted only by `POST /v1/admin/recover-inputs` and `GET /v1/admin/input-recovery-status`, only while it is present, and only while its embedded issuance time is within the bounded validity window.

The workflow will use the already-configured Cloudflare deployment credentials to create a temporary Worker version containing the recovery token. It will attach that version at 0% traffic, keep the authoritative base version at 100%, and send recovery requests only through a version-override header pinned to the temporary version. Normal traffic must remain on the base version throughout.

## Runtime changes

- Add optional `INPUT_RECOVERY_OPERATOR_TOKEN` to `Env`.
- Add recovery-specific authorization that accepts either the unchanged `INGRESS_TOKEN` or a valid recovery operator token.
- Apply that authorization only to the two recovery administration routes.
- Preserve the existing MutationGate operator token and authorization scope unchanged.
- Reuse the existing bounded token timestamp format and constant-time comparison behavior.

## Workflow

The recovery workflow will:

1. Require manual project ID `PRJ-xxxx`, confirmation value `RECOVER`, and dispatch from `main`.
2. Require the existing `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; it will no longer require a persistent GitHub ingress secret.
3. Capture the active, single-version, 100% production deployment and verify its health identity is Git-attributed.
4. Generate and mask a random, time-bounded recovery operator token.
5. Upload a temporary Worker version containing only the new operator secret while preserving all existing Worker secrets.
6. Attach the temporary version at 0% traffic and verify normal traffic still resolves to the base version.
7. Use a version override to verify the temporary token, execute recovery only for `PRJ-0002`, validate the sanitized summary invariant, and confirm `remaining=0` through the read-only status route.
8. In an unconditional cleanup step, restore the base version to 100%, verify the temporary version is no longer addressable through the override, and verify the token receives HTTP 401 on normal production traffic.

The production deployment concurrency group will serialize this temporary version operation with other controlled production operations.

## Failure behavior

- Any missing credential, unexpected deployment shape, identity mismatch, invalid response, non-zero recovery failure/conflict count, or incomplete cleanup fails the workflow.
- If failure occurs before the temporary version is created, cleanup reports that no deployment restoration is needed.
- If failure occurs after creation, cleanup still runs and independently reports restoration or revocation failures.
- Workflow logs expose only sanitized counters and identifiers; no token or raw provider response is printed.

## Tests

- API tests prove the recovery token is accepted only by the recovery endpoints, expires correctly, and cannot authorize MutationGate candidate resolution or general ingress.
- Workflow contract tests require zero-traffic version isolation, exact project scoping, masked token handling, bounded requests, unconditional cleanup, and absence of `INGRESS_TOKEN` in GitHub secrets.
- Static checks reject broadened authentication, direct Dropbox mutation, unbounded retries, raw secret output, and missing cleanup gates.
- Run targeted tests, the full test suite, `git diff --check`, and a Wrangler dry run before opening the pull request.

## Release boundary

This change is prepared and reviewed on a branch. It is not merged or deployed without a separate explicit authorization. The actual recovery is launched only after the corrected workflow is merged and its `main` CI is green.
