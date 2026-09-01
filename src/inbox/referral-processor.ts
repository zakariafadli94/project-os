import type { ReferralWriteReceipt, ReferralWriteRequest } from "../domain/referral-write";
import { parseReferralWriteRequest } from "../domain/referral-write";
import type { Env } from "../env";
import {
  referralInboxPath,
  referralReceiptPath,
  referralRequestPath
} from "../documents/referral-provenance";
import { createProductionPersistence } from "../persistence/production-factory";
import type { ObjectPersistence } from "../persistence/provider/contract";
import { ProviderConflictError } from "../persistence/provider/errors";
import { MAX_RETRYABLE_INBOX_ATTEMPTS, type InboxProcessSummary } from "./processor";

interface RegistryProject {
  project_id: string;
  slug: string;
}

interface ReferralFailureDiagnostic {
  schema_version: "1.0";
  request_id: string;
  source_project_id: string;
  target_project_id: string;
  status: "retryable_failure";
  attempt_count: number;
  first_failed_at: string;
  last_failed_at: string;
  message: string;
}

export type ExecuteReferral = (request: ReferralWriteRequest) => Promise<ReferralWriteReceipt>;

export async function processReferralInbox(env: Env): Promise<InboxProcessSummary> {
  const persistence = createProductionPersistence(env);
  return processReferralInboxEntries(
    persistence.objects,
    (referral) => routeReferral(env, referral)
  );
}

export async function processReferralInboxEntries(
  objects: ObjectPersistence,
  executeReferral: ExecuteReferral
): Promise<InboxProcessSummary> {
  const entries = (await objects.listChildren(referralInboxPath()))
    .filter((entry) => entry.kind === "file" && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const summary: InboxProcessSummary = { scanned: entries.length, processed: 0, failed: 0 };

  for (const entry of entries) {
    const sourcePath = entry.path;
    if (!sourcePath) {
      summary.failed += 1;
      console.error("Project OS referral inbox entry missing provider path", { name: entry.name });
      continue;
    }

    try {
      const raw = await objects.readText(sourcePath);
      if (raw === null) {
        summary.failed += 1;
        console.error("Project OS referral inbox entry disappeared before processing", { name: entry.name, sourcePath });
        continue;
      }

      const filenameRequestId = requestIdFromFilename(entry.name);
      let referral: ReferralWriteRequest;
      try {
        referral = parseReferralWriteRequest(JSON.parse(raw));
        if (!filenameRequestId || filenameRequestId !== referral.request_id) {
          throw new Error("Referral filename must exactly match request_id");
        }
      } catch {
        const fallbackId = filenameRequestId ?? await syntheticReferralId(entry.name, raw);
        await safeAdd(objects, referralRequestPath("rejected", fallbackId), raw);
        await archiveSource(objects, sourcePath, referralRequestPath("rejected", fallbackId));
        summary.processed += 1;
        continue;
      }

      let receipt: ReferralWriteReceipt;
      try {
        receipt = await executeReferral(referral);
      } catch (error) {
        summary.failed += 1;
        console.error("Project OS referral processing failed", {
          request_id: referral.request_id,
          message: error instanceof Error ? error.message : String(error)
        });
        try {
          const diagnostic = await recordReferralFailure(objects, referral, error);
          if (diagnostic.attempt_count >= MAX_RETRYABLE_INBOX_ATTEMPTS) {
            await archiveSource(objects, sourcePath, referralQuarantinePath(referral.request_id));
          }
        } catch (diagnosticError) {
          console.error("Project OS referral failure diagnostic could not be persisted", {
            request_id: referral.request_id,
            source_project_id: referral.source_project_id,
            target_project_id: referral.target_project_id,
            message: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
          });
        }
        continue;
      }

      await safeAdd(objects, referralReceiptPath(referral.request_id), pretty(receipt));
      const terminal = receipt.status === "conflict" ? "conflicts" : receipt.status;
      await archiveSource(objects, sourcePath, referralRequestPath(terminal, referral.request_id));
      await clearReferralFailureBestEffort(objects, referral.request_id);
      summary.processed += 1;
    } catch (error) {
      summary.failed += 1;
      console.error("Project OS referral inbox entry failed", {
        name: entry.name,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return summary;
}

async function routeReferral(env: Env, request: ReferralWriteRequest): Promise<ReferralWriteReceipt> {
  const registryStub = env.REGISTRY_GUARD.getByName("global");
  const response = await registryStub.fetch("https://registry-guard.internal/registry", { method: "GET" });
  if (!response.ok) throw new Error(`RegistryGuard referral lookup returned ${response.status}`);
  const registry = await response.json<{ projects: RegistryProject[] }>();
  const projectIds = new Set(registry.projects.map((project) => project.project_id));

  if (!projectIds.has(request.source_project_id)) {
    return terminalReceipt(request, "rejected", "SOURCE_PROJECT_NOT_FOUND", "Referral source project is not registered");
  }
  if (!projectIds.has(request.target_project_id)) {
    return terminalReceipt(request, "rejected", "TARGET_PROJECT_NOT_FOUND", "Referral target project is not registered");
  }

  const target = env.PROJECT_GUARD.getByName(request.target_project_id);
  const targetResponse = await target.fetch("https://project-guard.internal/referral", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });
  if (!targetResponse.ok) {
    throw new Error(`ProjectGuard referral route returned ${targetResponse.status}`);
  }
  return targetResponse.json<ReferralWriteReceipt>();
}

function terminalReceipt(
  request: ReferralWriteRequest,
  status: ReferralWriteReceipt["status"],
  code: string,
  message: string
): ReferralWriteReceipt {
  return {
    request_id: request.request_id,
    source_project_id: request.source_project_id,
    target_project_id: request.target_project_id,
    relative_path: request.relative_path,
    content_sha256: request.content_sha256,
    status,
    code,
    message
  };
}

function requestIdFromFilename(filename: string): string | null {
  return /^(REF-[A-Z0-9-]{10,})\.json$/.exec(filename)?.[1] ?? null;
}

function referralFailurePath(requestId: string): string {
  return `${referralRoot()}/failures/${requestId}.json`;
}

function referralQuarantinePath(requestId: string): string {
  return `${referralRoot()}/quarantine/${requestId}.json`;
}

function referralRoot(): string {
  return referralInboxPath().replace(/\/incoming$/, "");
}

async function recordReferralFailure(
  objects: ObjectPersistence,
  referral: ReferralWriteRequest,
  error: unknown
): Promise<ReferralFailureDiagnostic> {
  const path = referralFailurePath(referral.request_id);
  const previous = await readReferralFailure(objects, path, referral);
  const now = new Date().toISOString();
  const diagnostic: ReferralFailureDiagnostic = {
    schema_version: "1.0",
    request_id: referral.request_id,
    source_project_id: referral.source_project_id,
    target_project_id: referral.target_project_id,
    status: "retryable_failure",
    attempt_count: (previous?.attempt_count ?? 0) + 1,
    first_failed_at: previous?.first_failed_at ?? now,
    last_failed_at: now,
    message: error instanceof Error ? error.message : String(error)
  };
  await objects.upsertText(path, pretty(diagnostic));
  return diagnostic;
}

async function readReferralFailure(
  objects: ObjectPersistence,
  path: string,
  referral: ReferralWriteRequest
): Promise<ReferralFailureDiagnostic | null> {
  const raw = await objects.readText(path);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReferralFailureDiagnostic>;
    if (
      parsed.schema_version !== "1.0"
      || parsed.request_id !== referral.request_id
      || parsed.source_project_id !== referral.source_project_id
      || parsed.target_project_id !== referral.target_project_id
      || parsed.status !== "retryable_failure"
      || !Number.isSafeInteger(parsed.attempt_count)
      || (parsed.attempt_count ?? 0) < 1
      || typeof parsed.first_failed_at !== "string"
      || typeof parsed.last_failed_at !== "string"
      || typeof parsed.message !== "string"
    ) return null;
    return parsed as ReferralFailureDiagnostic;
  } catch {
    return null;
  }
}

async function clearReferralFailureBestEffort(objects: ObjectPersistence, requestId: string): Promise<void> {
  const path = referralFailurePath(requestId);
  try {
    if (await objects.readText(path) !== null) await objects.delete(path);
  } catch (error) {
    console.error("Project OS referral failure diagnostic cleanup failed", {
      request_id: requestId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function syntheticReferralId(filename: string, raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${filename}\0${raw}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `REF-INVALID-${hex.slice(0, 24)}`;
}

async function safeAdd(objects: ObjectPersistence, path: string, content: string): Promise<void> {
  try {
    await objects.createText(path, content);
  } catch (error) {
    if (!(error instanceof ProviderConflictError)) throw error;
    const existing = await objects.readText(path);
    if (existing !== content) throw new Error(`Conflicting referral terminal artifact at ${path}`);
  }
}

async function archiveSource(objects: ObjectPersistence, source: string, destination: string): Promise<void> {
  try {
    await objects.move(source, destination);
  } catch (error) {
    if (!(error instanceof ProviderConflictError)) throw error;
    const sourceStillExists = await objects.readText(source);
    if (sourceStillExists === null) return;
    const destinationExists = await objects.readText(destination);
    if (destinationExists === sourceStillExists) {
      await objects.delete(source);
      return;
    }
    throw error;
  }
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
