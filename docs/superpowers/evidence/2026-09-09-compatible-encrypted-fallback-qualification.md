# Compatible encrypted fallback ingress — qualification record

**Qualified implementation commit:** `016ad89f7dd0b84b27caf7cc1fbc6d6656366096`

**Qualification date:** 2026-09-09

## Scope

This record qualifies the compatible encrypted fallback transport added on the
permanent-convergence branch. It uses the existing RegistryGuard only for a
short-lived P-256 technical exchange and forwards durable transactions through
the ordinary signed-admission transaction route.

The change adds no Durable Object binding, no direct Dropbox mutation path, no
production activation, no canary, no secret, no deployment, and no PRJ-0003
repair.

## Observed verification

| Check | Observed result |
| --- | --- |
| Targeted fallback suite | 4 files, 21 tests passed: crypto, strict envelope parsing, RegistryGuard key exchange/rotation/recovery, encrypted context, exact admission transport, failure containment and replay. |
| Sensitive regression selection | 15 files, 70 tests passed across RegistryGuard, convergence, ProjectGuard, admission, inbox and rollback. |
| Complete suite | 201 test files and 965 tests passed. |
| Search-off prerequisite | 1 test file and 4 tests passed. |
| Persistence high-risk gate | 26 test files and 148 tests passed. |
| Type checks | `wrangler types` and `tsc --noEmit` completed successfully; the generated local type file was removed afterward. |
| Static gates | Persistence boundary, production-promotion authority, mutation-gate repair workflow, INDEX001 deployment, binary artifact ingress, recover-inputs, and fallback ingress boundary checks all passed. |
| Cloudflare dry run | `wrangler deploy --dry-run` built 1719.68 KiB (290.82 KiB gzip), listed only the six pre-existing Durable Object bindings, retained review-candidate ingress mode `off`, and ended with `--dry-run: exiting now.` |

## Verified boundaries

- Envelopes use P-256/ECDH, HKDF-SHA-256 and AES-GCM with associated data
  bound to schema version, key id, operation, direction and request id.
- RegistryGuard keys are non-cacheable, short-lived, paired, bounded and
  retired only after response encryption. Lost or retired session state fails
  closed and requires a fresh exchange.
- Project context is read through ProjectGuard’s canonical mutation-context
  route. It is projected compactly and returned only within the encrypted
  response; unavailable or inconsistent state is likewise encrypted.
- Fallback transactions retain their exact received admission-envelope bytes
  and use the ordinary `/v1/transactions` route. ProjectGuard remains the
  sole admission, idempotency, mutation and receipt authority.
- The static boundary check prohibits a fallback Durable Object, direct Dropbox
  runtime access, fallback plaintext console output and direct durable
  transaction execution.

## External gates still required

Production monitoring receiver and ACK verification, isolated 24-hour canary,
rollout activation, rollback observation, integration review/merge, deployment
and the official typed receipt-gated repair of PRJ-0003 / REV-000263 remain
external gated work. None was performed during this implementation.
