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
import type { InboxProcessSummary } from "./processor";

interface RegistryProject {
  project_id: string;
  slug: string;
}

export async function processReferralInbox(env: Env): Promise<InboxProcessSummary> {
  const persistence = createProductionPersistence(env);
  const objects = persistence.objects;
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
      } catch (error) {
        const fallbackId = filenameRequestId ?? await syntheticReferralId(entry.name, raw);
        await safeAdd(objects, referralRequestPath("rejected", fallbackId), raw);
        await archiveSource(objects, sourcePath, referralRequestPath("rejected", fallbackId));
        summary.processed += 1;
        continue;
      }

      let receipt: ReferralWriteReceipt;
      try {
        receipt = await routeReferral(env, referral);
      } catch (error) {
        summary.failed += 1;
        console.error("Project OS referral processing failed", {
          request_id: referral.request_id,
          message: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      await safeAdd(objects, referralReceiptPath(referral.request_id), pretty(receipt));
      const terminal = receipt.status === "conflict" ? "conflicts" : receipt.status;
      await archiveSource(objects, sourcePath, referralRequestPath(terminal, referral.request_id));
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
