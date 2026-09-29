import type { MutationContext } from "../admission/mutation-context";
import { verifyMutationContext } from "../admission/mutation-context";
import { canonicalJson } from "../rules/contract";
import type { ProjectState } from "./project-state";
import type { Transaction } from "./transaction";

export const LOCAL_GOVERNANCE_ACTOR = Object.freeze({
  actor_id: "rule_governance",
  authority: "rule_governance_operator"
});

const localGovernanceOperations = new Set([
  "rule.propose",
  "rule.accept",
  "rule.activate",
  "rule.retire",
  "rule.exception.grant",
  "rule.exception.revoke"
]);

export function isLocalGovernanceOperation(operation: string): boolean {
  return localGovernanceOperations.has(operation);
}

declare const localGovernanceCapabilityBrand: unique symbol;
export interface LocalGovernanceAuthorityCapability {
  readonly [localGovernanceCapabilityBrand]: true;
}

interface BoundCapability {
  state: string;
  transaction: string;
}

const capabilities = new WeakMap<object, BoundCapability>();

/**
 * Creates an in-process capability only from the dedicated, server-signed
 * governance actor and a fresh context for this exact project state.
 */
export async function prepareLocalGovernanceAuthority(
  state: ProjectState,
  tx: Transaction,
  context: MutationContext | null,
  signingKey: string,
  nowMs = Date.now()
): Promise<LocalGovernanceAuthorityCapability> {
  if (!isLocalGovernanceOperation(tx.operation)) throw new Error("LOCAL_GOVERNANCE_OPERATION_INVALID");
  if (tx.project_id !== state.project_id) throw new Error("LOCAL_GOVERNANCE_PROJECT_MISMATCH");
  await verifyMutationContext(context, state, tx.base_revision, signingKey, nowMs);
  if (context?.actor.actor_id !== LOCAL_GOVERNANCE_ACTOR.actor_id
    || context.actor.authority !== LOCAL_GOVERNANCE_ACTOR.authority) {
    throw new Error("LOCAL_GOVERNANCE_AUTHORITY_REQUIRED");
  }

  const capability = Object.freeze({}) as LocalGovernanceAuthorityCapability;
  capabilities.set(capability, {
    state: canonicalJson(state),
    transaction: canonicalJson(tx)
  });
  return capability;
}

/** Returns true only for a capability prepared for this exact state and transaction. */
export function localGovernanceAuthorityForTransition(
  capability: unknown,
  state: ProjectState,
  tx: Transaction
): boolean {
  if (!capability || typeof capability !== "object") return false;
  const bound = capabilities.get(capability);
  return bound !== undefined
    && bound.state === canonicalJson(state)
    && bound.transaction === canonicalJson(tx);
}
