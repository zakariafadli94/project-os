import { isReviewCandidate } from "../domain/artifact-write";
import type { ArtifactWriteReceipt, ArtifactWriteRequest } from "../domain/artifact-write";
import { binaryArtifactPolicyViolation } from "../artifacts/policy";
import type { Env } from "../env";
import { AdmissionError, type MutationContext } from "../admission/mutation-context";
import { executeTransactionWithContinuity } from "../index-neutral";
import { parseLayoutMode, type LayoutMode } from "../persistence/layout";
import { createProductionPersistence } from "../persistence/production-factory";
import { processReferralInbox } from "./referral-processor";
import {
  artifactInboxPath,
  inboxPath,
  processArtifactInbox,
  processTransactionInbox,
  type InboxProcessSummary
} from "./processor";

export const ARTIFACT_INGRESS_SCAN_BUDGET_PER_INVOCATION = 16;
export const ARTIFACT_INGRESS_WORK_ITEM_BUDGET_PER_INVOCATION = 4;

export interface DurableInboxProcessSummary extends InboxProcessSummary {
  mode: LayoutMode;
  inbox: string;
  artifact_inbox: string;
}

export async function processDurableInbox(env: Env): Promise<DurableInboxProcessSummary> {
  const mode = parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE);
  const persistence = createProductionPersistence(env);
  const transactionSummary = await processTransactionInbox(
    persistence.objects,
    mode,
    (transaction, context) => executeTransactionWithContinuity(env, transaction, undefined, context)
  );
  const artifactSummary = await processArtifactInbox(
    persistence.objects,
    mode,
    (artifact, context) => routeArtifact(env, artifact, context),
    {
      maxScanEntries: ARTIFACT_INGRESS_SCAN_BUDGET_PER_INVOCATION,
      maxWorkItems: ARTIFACT_INGRESS_WORK_ITEM_BUDGET_PER_INVOCATION,
      respectRetryBackoff: true,
      rotateScan: true
    }
  );
  const referralSummary = await processReferralInbox(env);

  return {
    mode,
    inbox: inboxPath(mode),
    artifact_inbox: artifactInboxPath(mode),
    scanned: transactionSummary.scanned + artifactSummary.scanned + referralSummary.scanned,
    processed: transactionSummary.processed + artifactSummary.processed + referralSummary.processed,
    failed: transactionSummary.failed + artifactSummary.failed + referralSummary.failed
  };
}

async function routeArtifact(env: Env, artifact: ArtifactWriteRequest, context: MutationContext | null = null): Promise<ArtifactWriteReceipt> {
  const policyViolation = binaryArtifactPolicyViolation(env, artifact);
  if (policyViolation && !isReviewCandidate(artifact)) {
    return {
      request_id: artifact.request_id,
      project_id: artifact.project_id,
      relative_path: artifact.relative_path,
      content_sha256: artifact.content_sha256,
      status: "rejected",
      code: policyViolation.code,
      message: policyViolation.message
    };
  }
  const stub = env.PROJECT_GUARD.getByName(artifact.project_id);
  const response = await stub.fetch("https://project-guard.internal/artifact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ admission_version: "1.0", request: artifact, mutation_context: context })
  });
  if (!response.ok) {
    const body: { error?: string } = await response.json<{ error?: string }>().catch(() => ({}));
    if (body.error && ["mutation_context_missing", "mutation_context_expired", "mutation_context_invalid", "mutation_context_stale", "canonical_unavailable", "idempotency_payload_mismatch", "convergence_capacity_exceeded"].includes(body.error)) {
      throw new AdmissionError(body.error as AdmissionError["code"], response.status as AdmissionError["status"]);
    }
    throw new Error(`ProjectGuard artifact route returned ${response.status}`);
  }
  return response.json<ArtifactWriteReceipt>();
}
