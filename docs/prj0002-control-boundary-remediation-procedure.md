# PRJ-0002 Control Boundary Remediation Procedure

Status: pre-merge remediation evidence; non-canonical procedure.

This document records the operational procedure used for the 2026-09-03 control-boundary anomaly. It does not supersede the generated Project OS operating contract, create a durable decision, or authorize a canonical mutation.

## Mandatory cross-project remediation flow

1. **Deposit evidence into the target project INPUTS boundary.** A source project or control session that discovers a defect affecting another project must route a factual report into the target project's `INPUTS/` through an authorized referral/artifact path. The report must preserve source project, target project, evidence, timestamp, and the requested remediation scope. Routing does not rebind the source session.
2. **Triage in the target project's control chat.** The target control chat resolves the target project from the canonical registry, refreshes the target project's current canonical context and revision, treats the INPUT as evidence rather than accepted architecture, and checks current branches/PRs/work for collisions.
3. **Explicitly accept or reject execution.** The target control chat decides whether the evidence warrants execution under the authority already granted by the user/Founder. The existence of an INPUT alone does not create a task, decision, accepted research record, plan change, or mutation authority.
4. **Dispatch only from target control to a reserved execution chat.** If execution is accepted, the target control chat sends an explicit bounded mandate to a chat already reserved and bound to the target project. Before dispatch it verifies that the destination is not actively executing unrelated work and that the mandate will not collide with current branches or PRs.
5. **Reject direct source-to-execution control.** A target execution chat must not treat a corrective mandate sent directly by another project's control/execution session as authority to mutate the target project. It should require the target INPUT + target-control triage/dispatch chain before acting.
6. **Preserve ordinary mutation gates.** Any later durable change remains subject to the normal Project OS typed-transaction, concurrency, MutationGate, receipt, and authorization requirements. This procedure grants none of those permissions by itself.

## Verification checklist

A cross-project corrective dispatch is conformant only when all applicable checks are evidenced:

- [ ] A factual report exists in the target project's `INPUTS/` boundary with provenance.
- [ ] The target project's control chat has triaged the report against fresh canonical state/revision.
- [ ] The target control has explicitly accepted the bounded execution scope, or the user's mandate already provides that acceptance.
- [ ] An explicit dispatch from target control to a target-bound reserved execution chat exists.
- [ ] The execution destination was checked for conflicting active work before dispatch.
- [ ] No source-project chat directly exercised target-project mutation authority.
- [ ] No canonical mutation occurred merely because the report was routed.
- [ ] Any durable mutation, if later authorized, is evidenced by the normal committed receipt.

## Code-boundary finding

The current Project OS runtime has a governed cross-project referral path whose target is the destination project's `INPUTS/` boundary, and the generated operating contract already states that routed inputs are evidence/request material rather than accepted canonical truth. The runtime does not orchestrate ChatGPT control chats, reserve execution chats, or grant chat-level dispatch authority.

Therefore the 2026-09-03 anomaly is remediated at this gate as a controller/session procedure, not by inventing a Worker endpoint that claims to control chat orchestration. Making the target-control triage and dispatch rule part of the canonical generated operating contract would be a governance/architecture decision and requires the appropriate Founder acceptance and durable Project OS mutation outside this pre-merge remediation scope.
