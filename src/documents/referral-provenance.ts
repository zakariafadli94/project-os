import type { ReferralWriteReceipt, ReferralWriteRequest } from "../domain/referral-write";
import type { ProjectState } from "../domain/project-state";
import { MACHINE_ROOT, machineProjectRoot, workspaceManagedDocumentPath } from "../persistence/layout";
import type { ObjectPersistence } from "../persistence/provider/contract";
import { ProviderConflictError } from "../persistence/provider/errors";
import { sha256Text } from "./hash";

export interface ReferralProvenanceIntent {
  schema_version: "1.0";
  request_id: string;
  source_project_id: string;
  target_project_id: string;
  relative_path: string;
  input_path: string;
  content_sha256: string;
  created_at: string;
  referral_type?: string;
  topic?: string;
}

export interface ReferralInputBinding {
  schema_version: "1.0";
  request_id: string;
  source_project_id: string;
  target_project_id: string;
  input_path: string;
  content_sha256: string;
  intent_path: string;
}

export class ReferralProvenanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferralProvenanceConflictError";
  }
}

export class ReferralProvenanceRepository {
  constructor(private readonly objects: ObjectPersistence) {}

  async deliver(state: ProjectState, request: ReferralWriteRequest): Promise<ReferralWriteReceipt> {
    if (request.target_project_id !== state.project_id) {
      return receipt(request, "rejected", "PROJECT_BINDING_MISMATCH", "Referral target does not match ProjectGuard state");
    }
    if (await sha256Text(request.content) !== request.content_sha256) {
      return receipt(request, "rejected", "CONTENT_HASH_MISMATCH", "content_sha256 does not match referral content");
    }

    const inputPath = workspaceManagedDocumentPath(
      state.project_id,
      state.slug,
      "inputs",
      request.relative_path
    );
    const intentPath = referralIntentPath(state.project_id, request.request_id);
    const bindingPath = await referralInputBindingPath(state.project_id, inputPath);
    const intent: ReferralProvenanceIntent = {
      schema_version: "1.0",
      request_id: request.request_id,
      source_project_id: request.source_project_id,
      target_project_id: request.target_project_id,
      relative_path: request.relative_path,
      input_path: inputPath,
      content_sha256: request.content_sha256,
      created_at: request.created_at,
      ...(request.referral_type ? { referral_type: request.referral_type } : {}),
      ...(request.topic ? { topic: request.topic } : {})
    };
    const binding: ReferralInputBinding = {
      schema_version: "1.0",
      request_id: request.request_id,
      source_project_id: request.source_project_id,
      target_project_id: request.target_project_id,
      input_path: inputPath,
      content_sha256: request.content_sha256,
      intent_path: intentPath
    };

    try {
      // Provenance must be durable before the visible INPUTS delivery exists.
      await ensureExactCreate(this.objects, intentPath, pretty(intent));
      await ensureExactCreate(this.objects, bindingPath, pretty(binding));
      await ensureExactCreate(this.objects, inputPath, request.content);
    } catch (error) {
      if (error instanceof ReferralProvenanceConflictError) {
        return receipt(request, "conflict", "REFERRAL_PROVENANCE_CONFLICT", error.message);
      }
      throw error;
    }

    return receipt(request, "committed");
  }

  async readBinding(projectId: string, inputPath: string): Promise<ReferralInputBinding | null> {
    const raw = await this.objects.readText(await referralInputBindingPath(projectId, inputPath));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as ReferralInputBinding;
    if (
      parsed.schema_version !== "1.0"
      || parsed.target_project_id !== projectId
      || parsed.input_path !== inputPath
      || !/^REF-[A-Z0-9-]{10,}$/.test(parsed.request_id)
      || !/^PRJ-[0-9]{4,}$/.test(parsed.source_project_id)
      || !/^[a-f0-9]{64}$/.test(parsed.content_sha256)
    ) {
      throw new ReferralProvenanceConflictError(`Invalid referral input binding for ${inputPath}`);
    }
    return parsed;
  }

  async readIntent(projectId: string, requestId: string): Promise<ReferralProvenanceIntent | null> {
    const raw = await this.objects.readText(referralIntentPath(projectId, requestId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as ReferralProvenanceIntent;
    if (
      parsed.schema_version !== "1.0"
      || parsed.request_id !== requestId
      || parsed.target_project_id !== projectId
      || !/^PRJ-[0-9]{4,}$/.test(parsed.source_project_id)
      || !/^[a-f0-9]{64}$/.test(parsed.content_sha256)
    ) {
      throw new ReferralProvenanceConflictError(`Invalid referral intent for ${projectId}/${requestId}`);
    }
    return parsed;
  }
}

export function referralInboxPath(): string {
  return `${MACHINE_ROOT}/referrals/incoming`;
}

export function referralRequestPath(
  status: "incoming" | "committed" | "rejected" | "conflicts",
  requestId: string
): string {
  return `${MACHINE_ROOT}/referrals/${status}/${assertReferralRequestId(requestId)}.json`;
}

export function referralReceiptPath(requestId: string): string {
  return `${MACHINE_ROOT}/referrals/receipts/${assertReferralRequestId(requestId)}.json`;
}

export function referralIntentPath(projectId: string, requestId: string): string {
  return `${machineProjectRoot(projectId)}/referrals/intents/${assertReferralRequestId(requestId)}.json`;
}

export async function referralInputBindingPath(projectId: string, inputPath: string): Promise<string> {
  return `${machineProjectRoot(projectId)}/referrals/input-bindings/${await sha256Text(inputPath)}.json`;
}

async function ensureExactCreate(objects: ObjectPersistence, path: string, content: string): Promise<void> {
  try {
    await objects.createText(path, content);
  } catch (error) {
    if (!(error instanceof ProviderConflictError)) throw error;
    const existing = await objects.readText(path);
    if (existing === content) return;
    throw new ReferralProvenanceConflictError(`Referral durable effect conflicts at ${path}`);
  }
}

function receipt(
  request: ReferralWriteRequest,
  status: ReferralWriteReceipt["status"],
  code?: string,
  message?: string
): ReferralWriteReceipt {
  return {
    request_id: request.request_id,
    source_project_id: request.source_project_id,
    target_project_id: request.target_project_id,
    relative_path: request.relative_path,
    content_sha256: request.content_sha256,
    status,
    ...(code ? { code } : {}),
    ...(message ? { message } : {})
  };
}

function assertReferralRequestId(value: string): string {
  if (!/^REF-[A-Z0-9-]{10,}$/.test(value)) throw new Error(`Unsafe referral request id: ${value}`);
  return value;
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
