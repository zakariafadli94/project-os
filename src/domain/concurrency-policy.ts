import type { Transaction } from "./transaction";
import { governanceOperationValues } from "./rule-governance";

const staleRebasableOperations = new Set<Transaction["operation"]>([
  "research.add",
  "constraint.add",
  "task.create",
  "deliverable.add"
]);

export function mayRebaseStaleOperation(operation: Transaction["operation"]): boolean {
  // Governance changes are direction-changing and always require an exact revision.
  if ((governanceOperationValues as readonly string[]).includes(operation)) return false;
  return staleRebasableOperations.has(operation);
}
