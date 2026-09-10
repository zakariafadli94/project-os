# Compatible Encrypted Fallback Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Reintroduce encrypted, bounded fallback transport from draft PR #139 on the permanent-convergence branch, while preserving the current signed-admission envelope through the normal ProjectGuard transaction route and without adding a Durable Object.

**Architecture:** The public MutationGate Worker exposes an additive fallback public-key read and an authenticated encrypted relay. The existing serialized `RegistryGuard` stores only a short-lived P-256 server key exchange and exposes narrow internal `key`, `decrypt`, and `encrypt-and-rotate` operations. It remains outside registry allocation and receipt-finalization code paths. The relay accepts exactly `project_context` and `transaction`: context obtains ProjectGuard’s canonical context read and returns a compact canonical state plus its signed mutation context; transaction accepts an `AdmissionEnvelope<Transaction>` and forwards its exact JSON bytes unchanged to the normal `/v1/transactions` route. Every resulting durable change still requires a committed normal receipt.

**Tech Stack:** TypeScript, Web Crypto P-256/ECDH, HKDF-SHA-256 and AES-GCM, Cloudflare Worker/RegistryGuard SQLite, Zod/strict parsers already in the repository, Vitest. No new binding, dependency, Durable Object, Dropbox write path, GitHub plaintext transport, deployment, or production activation.

**Design:** `docs/superpowers/specs/2026-09-09-compatible-promotion-fallback-integration-design.md`.

## Boundary and non-goals

- Do not merge, rebase, cherry-pick, or otherwise apply `origin/fix/prj-0002-dropbox-connector-fallback-ingress`; its route deletes active convergence/admission behavior and adds a prohibited `FallbackIngressGuard` Durable Object.
- Fallback is transport during a connector outage, not canonical storage, an alternate admission authority, or proof of a committed mutation.
- Do not place plaintext project state, transaction data, mutation context, receipt payloads, provider URLs, secrets or ephemeral private keys in logs, errors, GitHub, or persistent business records.
- Keep current read and transaction contracts unchanged. All fallback routes and RegistryGuard internals are additive and fail closed.
- Do not start a canary, set a secret, change traffic, merge a PR, deploy, or perform PRJ-0003 repair under this plan.

## Task 1: Establish strict fallback envelope and cryptography contracts (red first)

**Files:**
- Create: `src/fallback/crypto.ts`
- Create: `src/fallback/contract.ts`
- Create: `test/fallback-crypto.spec.ts`
- Create: `test/fallback-contract.spec.ts`

- [ ] Write red tests for an external public key response, encrypted request envelope and encrypted response envelope. Define exact schema version, `key_id`, caller P-256 public JWK, IV, ciphertext and bounded base64url encoding. Reject unknown fields, malformed JWKs, wrong curves/usages, duplicate/empty fields, invalid base64url and payloads over 128 KiB before decrypting.
- [ ] Implement pure Web Crypto helpers for P-256 ECDH, HKDF-SHA-256 and AES-GCM. Bind every ciphertext to explicit associated data containing schema version, key id, operation, direction and request id so a context request cannot be replayed as a transaction or response.
- [ ] Return only opaque generic malformed-envelope errors at the public boundary. Typed internal errors may distinguish retired keys, authentication failure, size limit and invalid crypto parameters, but must contain no plaintext or key material.
- [ ] Build a strict decrypted fallback request union with only `project_context` (`request_id`, `project_id`) and `transaction` (`request_id`, `admission_json`: a bounded UTF-8 JSON string containing an `AdmissionEnvelope<Transaction>`). Validate the envelope from that string without reserializing it, so its original bytes can be forwarded. Do not parse a naked transaction on the fallback path.
- [ ] Run `"/Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ./node_modules/vitest/vitest.mjs run test/fallback-crypto.spec.ts test/fallback-contract.spec.ts`; ensure malformed/key-direction/replay tests are red before implementing helpers.

## Task 2: Add narrow fallback-key exchange to the existing RegistryGuard (red first)

**Files:**
- Modify: `src/durable/registry-guard-neutral.ts`
- Create: `test/registry-guard-fallback-key.spec.ts`
- Modify: `test/registry-guard-recovery.spec.ts`

- [ ] Add failing direct-DO tests proving `GET /fallback/key` returns a public, non-cacheable P-256 key with an opaque `key_id`, and no private key appears in its response, SQLite observable metadata, error messages or logs.
- [ ] Extend only RegistryGuard’s existing constructor schema with a technical `fallback_key_sessions` table (opaque key id, private JWK serialization, created/retired timestamps). It must be separate from `meta`, `requests`, `projects`, registry rendering and receipt persistence. Use the existing `serialize` queue for all exchange operations.
- [ ] Add private internal routes: `GET /fallback/key`, `POST /fallback/decrypt`, `POST /fallback/encrypt-and-rotate`. Each invokes the strict crypto module. Decrypt accepts only the currently live key; encrypt authenticates the paired caller key, emits an encrypted response, and retires the used server key only after successful response encryption. Generate the next server key for the next exchange.
- [ ] Make key rotation one-shot and deterministic under concurrent requests: a duplicate replay using a retired key fails closed; a failure before encryption leaves the key usable only if no response could have been emitted; no request may rotate an unrelated exchange. Limit session lifetime and count so an abandoned client cannot cause unbounded SQLite growth.
- [ ] Add recovery tests that simulate local RegistryGuard SQLite loss or re-instantiation. The implementation must either recover a valid pending exchange from its technical state or fail closed and issue a fresh public key; it must never decrypt with an invented/private-key mismatch, alter registry allocation state, or lose/modify committed RegistryGuard receipts.
- [ ] Re-run the existing registry allocation, convergence fleet cursor and recovery suites to prove fallback technical state does not alter RegistryGuard authority.

## Task 3: Add the public encrypted relay and canonical-context operation (red first)

**Files:**
- Modify: `src/index-mutation-gate.ts`
- Modify: `src/index-neutral.ts` only if an exported authenticated canonical-read helper is necessary
- Create: `test/fallback-ingress.spec.ts`
- Modify: `test/mutation-context-route.spec.ts`

- [ ] Write red tests for `GET /v1/fallback-ingress/key`: it returns the RegistryGuard key only, uses `cache-control: no-store`, returns no business/project state, and is safe to call unauthenticated if that is the accepted bootstrap contract.
- [ ] Add a public `POST /v1/fallback-ingress` guard: require `INGRESS_TOKEN` using the existing constant-time comparison; reject declared and measured bodies above 128 KiB; reject a missing/incorrect auth header before contacting RegistryGuard; read raw bytes exactly once; apply `no-store` on every response. Do not write plaintext to logs.
- [ ] Decrypt through the narrow RegistryGuard endpoint. Strictly parse the decrypted union and dispatch only the two supported operations. Reject unknown operations, invalid request ids, bare transactions and surplus top-level content.
- [ ] For `project_context`, call `PROJECT_GUARD.getByName(project_id)` at its existing internal `/mutation-context` route. It must return a current canonical state and signed mutation context generated by ProjectGuard, not reconstruct a state by reading the provider from the relay. Build a deterministic compact projection containing only the fields needed for fallback operation (identity, revision, lifecycle/objective, current phase, active/blocked tasks, blockers, constraints, accepted decisions, research/deliverable indexes and timestamps) plus the signed `mutation_context` unchanged.
- [ ] If ProjectGuard cannot provide a complete/bound canonical record, encrypt a compact unavailable result with a code/status; do not guess a snapshot, leak an upstream response, or return plaintext 5xx data.
- [ ] Encrypt every success/unavailable/normal transaction response with RegistryGuard’s paired response operation. Preserve opaque errors at the outer route and include `cache-control: no-store` and JSON content type.
- [ ] Run: `"/Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ./node_modules/vitest/vitest.mjs run test/fallback-ingress.spec.ts test/mutation-context-route.spec.ts`.

## Task 4: Forward admission envelopes unchanged to the normal transaction path (red first)

**Files:**
- Modify: `src/index-mutation-gate.ts`
- Modify: `src/admission/transport.ts` only if an existing canonical serializer/parser is missing
- Modify: `src/continuity/rollback.ts` only if an existing candidate/stable executor drops the envelope
- Modify: `test/fallback-ingress.spec.ts`
- Modify: `test/mutation-context-transport.spec.ts`
- Modify: `test/rollback-admission-context.spec.ts`

- [ ] Add a red end-to-end test: fetch a fallback key, encrypt `project_context`, decrypt its response, take its signed `mutation_context`, construct a valid serialized `AdmissionEnvelope<Transaction>`, place it in `admission_json` in an encrypted `transaction` fallback request, and verify the normal transaction route produces a committed receipt that is returned only inside the encrypted response.
- [ ] Implement transaction forwarding using the received `admission_json` exact UTF-8 bytes. Forward it to the ordinary `baseWorker.fetch` transaction route with the normal ingress authorization; never reserialize, decode/re-sign, or substitute the context in the relay. The ordinary ProjectGuard remains responsible for typed validation, strict admission, idempotent intent, canonical commit and receipt.
- [ ] Assert in tests that missing, stale, forged, altered, wrong-project, and wrong-base-revision contexts return the same fail-closed admission error as direct ingress, without a provider mutation or terminal committed receipt. Test an exact transaction replay returns the original committed receipt; a changed payload under the same id remains rejected.
- [ ] Add candidate/stable rollback transport tests to prove existing fallback/candidate continuation closures preserve the admission envelope rather than reducing it to a naked transaction after a retry or rollback route.
- [ ] Add a regression test which instruments baseWorker and proves relay code never calls a provider repository or direct Dropbox interface for transactions. It is a transport adapter only.
- [ ] Run all fallback, admission transport and rollback context suites.

## Task 5: Failure containment, static gates and qualification record

**Files:**
- Create: `docs/superpowers/evidence/2026-09-09-compatible-encrypted-fallback-qualification.md`
- Modify: existing static-gate test/script only when it can prove a new fallback invariant

- [ ] Add source-policy coverage that forbids a `FallbackIngressGuard` class/binding/export, new `durable_objects` binding, raw Dropbox provider import, `console.*` of fallback plaintext, or a direct transaction execution path in `src/fallback/**` and `src/index-mutation-gate.ts`.
- [ ] Test key rotation, retired-key rejection, malformed encryption, wrong caller key, wrong AAD direction/operation, auth failure, declared/measured oversized input, unavailable canonical context, response-encryption failure and bounded request/response behavior. Every non-success condition must fail closed and leak no plaintext.
- [ ] Run selected registry, transaction, ProjectGuard, convergence, context, inbox and rollback suites. Then run TypeScript, repository static gates, persistence high-risk gate, the complete test suite and `wrangler deploy --dry-run` on the exact final SHA using the configured Node runtime.
- [ ] Record only observed commands, SHA, test counts and dry-run output in the evidence document. Explicitly mark production monitoring receiver/ACK, isolated 24-hour canary, activation and PRJ-0003 repair as still external gated work.
- [ ] Commit the encrypted fallback implementation and qualification evidence as coherent commits after all tests pass. Verify the worktree is clean.

## Verification command shape

Use the configured Node runtime because `node`, `npm` and `npx` are not on this host PATH:

```bash
RUNTIME_NODE="/Users/zakariafadli/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
"$RUNTIME_NODE" ./node_modules/vitest/vitest.mjs run test/fallback-crypto.spec.ts test/registry-guard-fallback-key.spec.ts test/fallback-ingress.spec.ts
"$RUNTIME_NODE" ./node_modules/typescript/bin/tsc --noEmit
"$RUNTIME_NODE" ./node_modules/wrangler/bin/wrangler.js deploy --dry-run
```

Expected final behavior: a client receives a one-shot public key, authenticates an encrypted request, obtains an encrypted canonical context with its true signed mutation context, and may submit only that envelope through the ordinary ProjectGuard path. Any malformed, stale, unauthorized, retired, oversized or unavailable state remains encrypted/fail-closed and creates no durable business change.
