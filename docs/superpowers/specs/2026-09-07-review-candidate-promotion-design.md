# Governed binary REVIEW candidate promotion

## Context

The binary `REVIEW_CANDIDATE` ingress now validates and stores immutable review attachments under `REVIEW/CANDIDATES/<artifact_request_id>/<filename>`. The attachment is deliberately not a managed document and the committed ingress receipt remains `accepted: false`, `published: false`. PRJ-0007 currently has seven validated binary candidates that require an explicit, governed publication path.

## Design

Add a managed-document operation named `review_candidate.promote`. The caller supplies a new managed-document `request_id`, the committed `candidate_request_id`, the target managed `logical_path`, the current `expected_project_revision`, and the literal `accepted: true`. The target document id is deterministic from project id and logical path. Promotion is create-only: an existing managed head or a pre-existing visible target is a conflict unless it is the exact deterministic replay of the same promotion request.

ProjectGuard first uses the durable managed-document intent and receipt ledger. The service then loads the immutable candidate terminal record, requires a committed REVIEW_CANDIDATE receipt with `accepted: false` and `published: false`, and re-reads the candidate's frozen final provider observation. It verifies provider id, source path, object id, revision token, size, provider integrity, source SHA-256 and supported format signature immediately before copying. The candidate remains in REVIEW as the audit source.

The service copies the verified bytes to the requested `DELIVERABLES/<logical_path>` path and snapshots the same bytes into the immutable managed-document provider payload namespace. It writes a published `DocumentVersionRecord` with the media type and source candidate request id, then writes the immutable managed-document head and promotion evidence. The receipt is durable only after all managed evidence has committed. Replays return the same receipt without copying a second time; a changed candidate, stale project revision, target collision or altered request returns a deterministic conflict/rejection.

## Persistence and failure rules

- Candidate terminal evidence is immutable and is never deleted or rewritten by promotion.
- The managed version record is immutable and records the candidate request id, target path, destination provider evidence and media type.
- The durable managed-document request receipt is the receipt gate. SQL cache loss replays from the provider receipt and version record.
- A provider copy that succeeds before a response is lost may be repaired by exact replay when destination payload evidence matches; a different destination payload is never overwritten.
- Provider errors remain retryable; validation, stale revision and collision errors are terminal and explicit.
- No PRJ-0007 candidate is promoted by this change.

## Verification

Tests cover schema parsing, candidate receipt gating, provider identity/revision/size/hash validation, explicit acceptance, target collision, stale revision, immutable history, exact replay after local receipt loss, provider-copy response loss, and unchanged candidate retention. Documentation describes the operation and its safety boundaries.
