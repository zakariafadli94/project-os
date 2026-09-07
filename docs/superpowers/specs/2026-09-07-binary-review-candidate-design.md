# Binary REVIEW_CANDIDATE ingress

Status: proposed code/SOP on the dedicated branch; autonomous implementation authorized by the PRJ-0002 mandate. Canonical HANDOFF, STATE, OPERATING and structured state were read at revision 149. Main baseline: 03d6b7f4e765016bcd7335101a82eb394b0a32b0. No canonical mutation, merge, production deployment or activation is authorized.

## Decision

Use an explicit staged `operation: REVIEW_CANDIDATE`, create-only, with a canonical `base_revision`, declared media type and provider identity. Resolve it to `REVIEW/CANDIDATES/<request_id>/<filename>`. This reserved immutable submission namespace holds review attachments, not managed document heads. It never implies acceptance or publication and cannot supersede an existing working/review lineage. Managed document operations cannot claim the reserved namespace. Ordinary artifact routes remain forbidden from targeting REVIEW.

Alternatives rejected: adding REVIEW to the ordinary artifact allowlist would bypass document lifecycle; extending all managed-document working/supersede/publish operations to binary transport would expand this correction into an unrelated lifecycle migration. Subsequent promotion remains a separate governed operation, not implemented here.

## Authorization

A dedicated REVIEW ingress mode defaults off. Scoped mode additionally requires a strictly parsed capability configuration with issuance/expiry no more than one hour apart and at most ten exact review requests. Every request, including project, operation, revision, path, source identity/revision/size/integrity, media type and content SHA, must equal an authorized entry. Wildcards and unknown keys are invalid. Capability expiry, missing configuration or invalid policy fails closed. The existing global binary mode remains off by default and cannot authorize REVIEW. Ordinary binary policy remains checked before routing. REVIEW reaches ProjectGuard so exact terminal replay can be recovered before authorization for any new effect; authorization is checked at the guard and immediately before copy. Removing the capability or setting REVIEW mode off rolls back authorization without deleting evidence. Terminal exact replay remains readable through public and inbox entrypoints after expiry, without authorizing another copy.

## Evidence

Preserve request ID and staging-directory binding. Verify source metadata, bounded raw bytes, SHA-256, declared container signature and filename extension, then recheck source identity/revision before and after server-side copy. Verify destination size and provider integrity. Initially support PDF, PNG, JPEG and ZIP containers; Office documents can be packaged inside ZIP attachments, never advertised as validated OOXML semantics. Unsupported types fail closed. The binary read capability is optional at the provider boundary, but mandatory for REVIEW; no text decoding is permitted.

Freeze the entire request and destination in the existing durable intent. Require current canonical revision before first intent; exact crash replay uses the frozen intent revision and immutable request. Persist deterministic terminal receipts with explicit REVIEW_CANDIDATE/nonaccepted/nonpublished semantics. Keep existing conflict and cleanup rules; never replace a candidate.

## Reconciliation

MutationGate continues to classify reserved candidate paths: exact frozen evidence is governed, unknown/modified objects remain external candidates. Managed-document reconciliation/bootstrap skips only the reserved submission namespace and creates no document heads. Existing working/review heads remain unchanged.

## Bounded processing

Process transactions first. Increase artifact work budget from one to four and scan budget from two to sixteen; preserve retry ceilings/backoff and bound failed/malformed work. Use the same budgets in both inbox entrypoints. Do not parallelize same-project writes or bypass ProjectGuard. Validate actual multi-item execution and transaction ordering.

## Verification and integration

TDD schema/policy, binary bytes/provider behavior, guard/repository/reconciliation and bounded batch tests. Run targeted tests, full suite, persistence/security gates and Wrangler deploy --dry-run. Verify #141–#145 remain in main and test compatibility with #139 without merging it. Open a dedicated PR, wait for CI on exact head/test merge, obtain independent counter-review and stop at READY or a precise blocker. Live canary, deployment, activation and PRJ-0007 file publication remain outside this mandate.
