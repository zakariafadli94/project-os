import type { MutationContext } from "./mutation-context";
import type { ArtifactWriteRequest } from "../domain/artifact-write";
import type { ManagedDocumentRequest } from "../domain/managed-document-request";
import type { Transaction } from "../domain/transaction";
import type { Env } from "../env";
import { executeTransactionWithContinuity, routeArtifact, routeManagedDocument } from "../index-neutral";

export type GovernedSubmission =
  | { kind: "transaction"; request: Transaction }
  | { kind: "document"; request: ManagedDocumentRequest }
  | { kind: "artifact"; request: ArtifactWriteRequest };

export async function executeGovernedSubmission(env: Env, submission: GovernedSubmission, context: MutationContext | null) {
  if (submission.kind === "transaction") return executeTransactionWithContinuity(env, submission.request, undefined, context);
  if (submission.kind === "document") return routeManagedDocument(env, submission.request, context);
  return routeArtifact(env, submission.request, context);
}
