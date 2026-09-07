# Binary Review Candidate Implementation Plan

**Goal:** Submit bounded, explicitly authorized binary review attachments through ProjectGuard.
**Architecture:** Reserved immutable candidate namespace, strict scoped authorization, optional bounded binary provider port, existing intents/receipts and MutationGate.
**Tech Stack:** TypeScript, Zod, Cloudflare Workers/Durable Objects, Vitest, Dropbox provider.
**Spec:** ../specs/2026-09-07-binary-review-candidate-design.md

## Constraints

Revision 149 canonical context; branch only. No production mutations, merge, deployment or activation. Existing global binary mode remains off by default. REVIEW never implies acceptance/publication.

## Execution

- [x] Schema/policy RED: parse explicit create-only candidates; reject unsafe staging/path, unsupported declarations, altered/expired/wildcard capability. GREEN: strict request variant and scoped policy, checked public/inbox/guard.
- [x] Binary RED: SHA/type/size mismatches and provider changes reject before copy; absent binary port fails closed. GREEN: bounded provider byte reader and source validation.
- [x] Governance RED: candidate destination, stale revision, crash replay, immutable receipt, unknown candidate, reserved managed path, reconciliation without heads. GREEN: request-aware resolution, revision check before intent and reserved namespace handling.
- [x] Batch RED: four artifacts handled after transactions, fifth retained, backoff failures do not monopolize scan. GREEN: common bounded budgets across entrypoints.
- [x] Documentation: update binary ingress SOP and security gate with default-off capability and exact request examples; retain canonical rendering contract.
- [ ] Verify targeted tests, complete suite, persistence high-risk and security gates, dry-run; compare #139 and #141–#145; commit/push and dedicated PR; exact CI; independent counter-review.

Each implementation step starts with its regression test and an observed RED run; targeted GREEN follows before the next component. Tests and evidence are recorded with the final PR. Execution stays in this task under the explicit autonomous mandate; independent review is delegated separately.
