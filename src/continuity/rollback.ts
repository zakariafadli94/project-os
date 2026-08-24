import type { Receipt } from "../domain/receipt";
import { AUTO_PROJECT_ID, type Transaction } from "../domain/transaction";
import type { ContinuityPath } from "./policy";

export type TransactionExecutor = (transaction: Transaction) => Promise<unknown>;

export interface RollbackExecution {
  receipt: Receipt;
  selected_path: ContinuityPath;
  final_path: ContinuityPath;
  fallback_occurred: boolean;
  candidate_failure?: "technical" | "malformed_result";
}

export interface RollbackExecutionInput {
  selectedPath: ContinuityPath;
  transaction: Transaction;
  stable: TransactionExecutor;
  candidate?: TransactionExecutor;
}

export async function executeWithRollback(input: RollbackExecutionInput): Promise<RollbackExecution> {
  if (input.selectedPath === "stable") {
    return {
      receipt: requireBusinessReceipt(await input.stable(input.transaction), input.transaction),
      selected_path: "stable",
      final_path: "stable",
      fallback_occurred: false
    };
  }

  let candidateFailure: RollbackExecution["candidate_failure"] = "technical";
  try {
    if (!input.candidate) throw new Error("Candidate executor unavailable");
    const value = await input.candidate(input.transaction);
    const candidateReceipt = businessReceiptOrNull(value, input.transaction);
    if (candidateReceipt) {
      return {
        receipt: candidateReceipt,
        selected_path: "candidate",
        final_path: "candidate",
        fallback_occurred: false
      };
    }
    candidateFailure = "malformed_result";
  } catch {
    candidateFailure = "technical";
  }

  return {
    receipt: requireBusinessReceipt(await input.stable(input.transaction), input.transaction),
    selected_path: "candidate",
    final_path: "stable",
    fallback_occurred: true,
    candidate_failure: candidateFailure
  };
}

function requireBusinessReceipt(value: unknown, transaction: Transaction): Receipt {
  const receipt = businessReceiptOrNull(value, transaction);
  if (!receipt) throw new Error("Stable executor returned an invalid receipt");
  return receipt;
}

function businessReceiptOrNull(value: unknown, transaction: Transaction): Receipt | null {
  if (!isRecord(value)) return null;
  if (value.schema_version !== "1.0") return null;
  if (value.transaction_id !== transaction.transaction_id) return null;
  if (!receiptProjectMatchesTransaction(value.project_id, transaction)) return null;
  if (value.status !== "committed" && value.status !== "rejected" && value.status !== "conflict") return null;
  if (!isNonNegativeInteger(value.previous_revision) || !isNonNegativeInteger(value.new_revision)) return null;

  return value as unknown as Receipt;
}

function receiptProjectMatchesTransaction(projectId: unknown, transaction: Transaction): boolean {
  if (typeof projectId !== "string") return false;
  if (projectId === transaction.project_id) return true;
  return transaction.operation === "project.create"
    && transaction.project_id === AUTO_PROJECT_ID
    && /^PRJ-[0-9]{4,}$/.test(projectId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
