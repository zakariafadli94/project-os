import type { ArtifactWriteReceipt, ArtifactWriteRequest } from "../domain/artifact-write";
import type { Env } from "../env";
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

export const ARTIFACT_INGRESS_SCAN_BUDGET_PER_INVOCATION = 2;
export const ARTIFACT_INGRESS_WORK_ITEM_BUDGET_PER_INVOCATION = 1;

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
    (transaction) => executeTransactionWithContinuity(env, transaction)
  );
  const artifactSummary = await processArtifactInbox(
    persistence.objects,
    mode,
    (artifact) => routeArtifact(env, artifact),
    {
      maxScanEntries: ARTIFACT_INGRESS_SCAN_BUDGET_PER_INVOCATION,
      maxWorkItems: ARTIFACT_INGRESS_WORK_ITEM_BUDGET_PER_INVOCATION,
      respectRetryBackoff: true
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

async function routeArtifact(env: Env, artifact: ArtifactWriteRequest): Promise<ArtifactWriteReceipt> {
  const stub = env.PROJECT_GUARD.getByName(artifact.project_id);
  const response = await stub.fetch("https://project-guard.internal/artifact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(artifact)
  });
  if (!response.ok) throw new Error(`ProjectGuard artifact route returned ${response.status}`);
  return response.json<ArtifactWriteReceipt>();
}
