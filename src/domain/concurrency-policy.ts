import type { Transaction } from "./transaction";

const staleRebasableOperations = new Set<Transaction["operation"]>([
  "research.add",
  "constraint.add",
  "task.create",
  "deliverable.add"
]);

export function mayRebaseStaleOperation(operation: Transaction["operation"]): boolean {
  return staleRebasableOperations.has(operation);
}
