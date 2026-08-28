# MutationGate operator readiness fix design

This is a bounded regression fix to the existing ephemeral MutationGate operator workflow.

After installing `MUTATION_GATE_OPERATOR_TOKEN`, the workflow must not use `/health` as evidence that the serving Worker version already has the new secret. Instead it must probe `/v1/mutation-candidates/resolve` with the ephemeral bearer token and an intentionally invalid `{}` JSON body. A `400` response carrying `invalid_mutation_candidate_resolution` proves authentication succeeded without producing a candidate resolution. A `401` means the new secret is not yet active on the serving version and must be retried for a bounded window. Any other response is a hard failure.

The candidate reject loop, eight candidate IDs, global concurrency group, `INGRESS_TOKEN`, Cloudflare credentials, sequential commits, unconditional cleanup, production health after cleanup, and post-cleanup HTTP 401 revocation verification remain unchanged.
