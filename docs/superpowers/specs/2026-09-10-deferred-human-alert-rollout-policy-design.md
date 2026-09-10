# Deferred human-alert rollout policy

## Context

Project OS persists convergence incidents and can deliver them through an optional HTTPS monitoring receiver. The original rollout evidence treated a real notification acknowledgement as a hard prerequisite for production activation. The operator has explicitly chosen to defer all human-facing channels for now: no e-mail, WhatsApp, subscription, receiver, or external monitoring service will be enabled.

This amendment changes only that operational prerequisite. It does not weaken canonical-write, admission, capacity, recovery, writer, fencing, compatibility, or canary requirements.

## Decision

Introduce an explicit rollout policy with two values:

- `required` (default): `notification_ack_proven` remains a rollout blocker.
- `deferred`: `notification_ack_proven` remains recorded as evidence, but does not block rollout qualification.

The policy is an explicit input to rollout review. Omitting it means `required`; only a review that records `deferred` may treat the acknowledgement as non-blocking. This prevents an absent declaration, an ambiguous configuration, or an older environment from silently bypassing the original guard.

`RolloutEvidence.notification_ack_proven` is retained. The implementation does not manufacture an acknowledgement, delete incident records, suppress structured metrics, remove retry state, or make an optional monitoring receiver unavailable. It changes only how rollout evidence is evaluated when the explicit policy says that human delivery is deferred.

## Scope and non-goals

The existing runtime has no autonomous production-rollout controller: project repair and strict-admission modes are explicit deployment configuration. Therefore this amendment does **not** claim to pause or resume a rollout automatically. Adding a persisted rollout controller would be a separate subsystem and is outside this amendment.

The following remain required before production activation or PRJ-0003 remediation:

- compatible readers, one writer, fencing, and RegistryGuard continuation;
- complete admission transport and compatible stable recovery;
- qualified capacity and recovery evidence;
- an isolated canary and its required qualification;
- the existing explicit per-project activation configuration.

No Cloudflare setting, external notification provider, canonical Dropbox file, canary, deployment, merge, or PRJ-0003 mutation is part of this design.

## Implementation shape

`src/convergence/rollout.ts` owns the policy type. `rolloutBlockers` accepts that explicit policy and excludes only `notification_ack_proven` under `deferred`; all other false evidence remains sorted and blocking. The function is deliberately pure so production review and tests evaluate the same rule.

Documentation records the policy decision, current deferred state, and the fact that a future alert channel can be introduced without changing canonical data. No Worker environment variable or deployment configuration is introduced for a gate that has no runtime consumer.

## Test and verification plan

The change follows test-first implementation:

1. Add a failing rollout test proving that an explicit deferred policy permits a false `notification_ack_proven` while every other evidence field remains required.
2. Retain the existing test proving that the default `required` policy still blocks a missing acknowledgement.
3. Prove that a second false evidence field remains blocking under `deferred`.
4. Run the focused rollout tests, type checking, all static safety contracts, persistence high-risk tests, the full suite, and a final Cloudflare dry-run on the final SHA.

The review evidence must state that alert delivery is deliberately deferred, not proven, and that this is an operational-policy exception only.
