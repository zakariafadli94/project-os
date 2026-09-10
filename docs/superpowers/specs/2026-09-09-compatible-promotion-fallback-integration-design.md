# Compatible promotion and fallback integration

## Decision

Do not merge or cherry-pick PR #147 or PR #139. Their heads predate the
convergence runtime and a direct merge removes active fencing, journal,
budget and admission modules. Rebuild only their user-visible capabilities
on the current permanent-convergence branch, using its canonical-read and
signed-admission boundaries.

This design adds no business schema shortcut, no direct Dropbox write, no
new Durable Object and no production activation. It preserves the existing
Dropbox canon, typed transaction receipt gate, and ProjectGuard ownership of
all business mutations.

## Governed review-candidate promotion

`review_candidate.promote` is an explicit managed-document operation. Its
request contains a fresh document request id, the committed candidate request
id, a safe logical destination, the expected project revision, and literal
`accepted: true`.

The integration keeps the original promotion invariants:

- reload immutable candidate terminal evidence and require its committed
  REVIEW receipt (`accepted: false`, `published: false`);
- re-observe identity, object id, revision token, size, provider integrity,
  SHA-256 and supported signature immediately before copying;
- create the visible deliverable, immutable provider payload, version record,
  promotion evidence and managed head in receipt-gated order;
- preserve the REVIEW candidate forever, reject target collisions and stale
  project revisions, and repair only exact provider-copy replays.

The outer ingress is an `AdmissionEnvelope<ManagedDocumentRequest>`. The
existing ProjectGuard verifies the signed, current mutation context before
the promotion service obtains any writable capability. Replays use the same
request id and return the original terminal result; a mismatched payload is
rejected.

## Encrypted fallback ingress

The fallback route remains an encrypted transport for connector outages; it
does not become a second source of project truth. It exposes a public P-256
key and accepts only an authenticated encrypted envelope below the bounded
request size.

To retain per-exchange key rotation without creating a new Durable Object,
the existing serialized RegistryGuard holds only the short-lived fallback key
pair and provides narrow internal `key`, `decrypt`, and `encrypt-and-rotate`
operations. This does not change RegistryGuard allocation, registry, or
receipt-finalization authority. Its state is technical session material, not
canonical project data.

The public Worker route supports exactly two encrypted operations:

1. `project_context` calls the authenticated canonical mutation-context read
   for the requested project and returns a compact canonical state plus its
   signed mutation context. A missing or inconsistent canonical record yields
   an encrypted unavailable response, never a guessed snapshot.
2. `transaction` accepts an `AdmissionEnvelope<Transaction>` and forwards its
   bytes unchanged to the ordinary transaction route. ProjectGuard performs
   fresh admission, idempotent replay, typed transaction validation and the
   normal receipt gate. A fallback delivery is not proof of a durable change.

The response stays encrypted, no-store, bounded, and keyed to the caller's
ephemeral public key. Plaintext project data, transactions, contexts and
receipts never enter relay logs, GitHub comments or console output.

## Failure and compatibility rules

- RegistryGuard serialization queues concurrent fallback key exchanges; it
  does not queue or invent business mutations.
- A retired fallback key, malformed envelope, missing authorization, missing
  signed context, stale context, or malformed transaction fails closed.
- Candidate/stable transaction fallback preserves the same envelope bytes and
  context across the existing rollback path.
- The pre-existing readable routes keep their wire contracts. New routes are
  additive and unavailable until their bindings and secrets are explicitly
  configured in a canary environment.
- No PRJ-0007 publication, PRJ-0003 repair, canary allocation, merge or
  deployment occurs as part of this implementation.

## Verification

Tests must first demonstrate the missing behavior, then cover:

- promotion acceptance, stale revision, candidate byte/provider drift,
  destination collision, exact replay and candidate retention;
- fallback encryption, authorization, key rotation, bounded input, encrypted
  canonical-context read, exact signed-context transport, receipt replay and
  rejection of stale/missing context;
- RegistryGuard recovery after local SQLite loss without losing a valid key
  exchange or its rotation boundary;
- regression suites for convergence, context transport, rollback, managed
  documents and fallback relay.

The implementation is complete only after targeted tests, TypeScript, all
static gates, the persistence high-risk gate, the full suite and a dry-run on
the final SHA. Production remains gated on a real monitoring receiver and an
isolated 24-hour canary.
