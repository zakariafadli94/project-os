import { isReviewCandidate } from "../domain/artifact-write";
import type { ArtifactWriteReceipt, ArtifactWriteRequest } from "../domain/artifact-write";
import type { Transaction } from "../domain/transaction";
import { binaryArtifactPolicyViolation } from "../artifacts/policy";
import type { Env } from "../env";
import { AdmissionError, parseMutationContextOrNull, type MutationContext } from "../admission/mutation-context";
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
    async (transaction, context) => executeTransactionWithContinuity(
      env,
      transaction,
      undefined,
      await resolveInboxTransactionContext(env, transaction, context)
    ),
    { respectRetryBackoff: true }
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

/**
 * The official Dropbox inbox is a server-owned ingress boundary.  Old and
 * connector-limited clients can submit a typed request there, but never hold
 * a signing secret.  Obtain the short-lived context immediately before the
 * normal ProjectGuard admission; direct HTTP routes remain strict.
 */
export async function resolveInboxTransactionContext(
  env: Pick<Env, "PROJECT_GUARD" | "INGRESS_TOKEN">,
  transaction: Transaction,
  context?: MutationContext | null
): Promise<MutationContext | null> {
  // Project creation is authorized by RegistryGuard, which allocates the
  // project ID.  It never has a project-local mutation context.
  if (context || transaction.operation === "project.create") return context ?? null;

  const response = await env.PROJECT_GUARD.getByName(transaction.project_id).fetch(
    "https://project-guard.internal/mutation-context?include_state=false",
    { headers: { authorization: `Bearer ${env.INGRESS_TOKEN}` } }
  );
  if (!response.ok) throw new AdmissionError("canonical_unavailable", 503);

  let body: { context?: unknown };
  try {
    body = await response.json<{ context?: unknown }>();
  } catch {
    throw new AdmissionError("canonical_unavailable", 503);
  }
  const fresh = parseMutationContextOrNull(body.context ?? null);
  if (!fresh) throw new AdmissionError("canonical_unavailable", 503);
  return fresh;
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
    const body: { error?: string; detail?: Record<string, unknown> } = await response.json<{ error?: string; detail?: Record<string, unknown> }>().catch(() => ({}));
    if (body.error && ["mutation_context_missing", "mutation_context_expired", "mutation_context_invalid", "mutation_context_stale", "canonical_unavailable", "GLOBAL_GOVERNANCE_UNAVAILABLE", "RULE_ADMISSION_STALE", "idempotency_payload_mismatch", "convergence_capacity_exceeded"].includes(body.error)) {
      throw new AdmissionError(body.error as AdmissionError["code"], response.status as AdmissionError["status"], body.detail);
    }
    throw new Error(`ProjectGuard artifact route returned ${response.status}`);
  }
  return response.json<ArtifactWriteReceipt>();
}
