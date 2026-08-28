# MutationGate operator readiness fix

Bounded regression fix for the PR #44 ephemeral operator flow.

The failed production operator run proved that `/health` can succeed before the newly installed `MUTATION_GATE_OPERATOR_TOKEN` is accepted by the serving Worker version. The fix replaces that false readiness signal with an authenticated, non-mutating probe against `/v1/mutation-candidates/resolve` using an intentionally invalid `{}` payload. Readiness is established only when the endpoint returns the authenticated validation response (`400 invalid_mutation_candidate_resolution`); `401` is retried for a bounded period. No candidate is touched during readiness probing.

Scope remains unchanged: the same eight PRJ-0003 candidates, global operator serialization, existing Cloudflare credentials, untouched `INGRESS_TOKEN`, sequential governed `candidate.reject`, unconditional secret cleanup, and post-cleanup revocation verification.
