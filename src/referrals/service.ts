import {
  parseReferralWriteRequest,
  type ReferralTransportReceipt,
  type ReferralWriteRequest
} from "../domain/referral";
import { workspaceManagedDocumentPath } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { ProviderConflictError } from "../persistence/provider/errors";
import { asProjectOsPersistence, type PersistenceInput } from "../persistence/provider/runtime";
import { ReferralRepository } from "./repository";
import { renderReferralMarkdown } from "./renderer";

export interface ReferralProjectIdentity {
  project_id: string;
  slug: string;
  status: "active" | "paused" | "completed" | "archived";
}

export interface ReferralProjectDirectory {
  resolveProject(projectId: string): Promise<ReferralProjectIdentity | null>;
}

export class ReferralService {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly repository: ReferralRepository;

  constructor(
    input: PersistenceInput,
    private readonly directory: ReferralProjectDirectory,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    this.runtime = asProjectOsPersistence(input);
    this.repository = new ReferralRepository(this.runtime);
  }

  async deliver(input: ReferralWriteRequest): Promise<ReferralTransportReceipt> {
    const request = parseReferralWriteRequest(input);
    const target = await this.directory.resolveProject(request.target_project_id);
    if (!target || target.project_id !== request.target_project_id) {
      return this.rejected(request, "REFERRAL_TARGET_NOT_FOUND", "Referral target project was not found");
    }
    if (target.status === "archived") {
      return this.rejected(request, "REFERRAL_TARGET_ARCHIVED", "Archived projects do not accept referrals");
    }

    const envelope = { ...request, canonical: false as const };
    const markdown = renderReferralMarkdown(envelope);
    const inputPath = workspaceManagedDocumentPath(
      target.project_id,
      target.slug,
      "inputs",
      `REFERRAL-${request.referral_id}.md`
    );

    const existingReceipt = await this.repository.readReceipt(request.referral_id);
    if (existingReceipt) {
      const existingInput = existingReceipt.input_path
        ? await this.runtime.objects.readText(existingReceipt.input_path)
        : null;
      if (existingReceipt.status === "delivered" && existingReceipt.input_path === inputPath && existingInput === markdown) {
        return existingReceipt;
      }
      throw new Error(`Referral idempotency mismatch: ${request.referral_id}`);
    }

    try {
      await this.runtime.objects.createText(inputPath, markdown);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.runtime.objects.readText(inputPath);
      if (existing !== markdown) throw new Error(`Referral destination conflict: ${inputPath}`);
    }

    const receipt: ReferralTransportReceipt = {
      schema_version: "1.0",
      referral_id: request.referral_id,
      status: "delivered",
      source_project_id: request.source_project_id,
      target_project_id: request.target_project_id,
      input_path: inputPath,
      delivered_at: this.now()
    };
    await this.repository.writeReceipt(receipt);
    return receipt;
  }

  private async rejected(
    request: ReferralWriteRequest,
    code: string,
    message: string
  ): Promise<ReferralTransportReceipt> {
    const receipt: ReferralTransportReceipt = {
      schema_version: "1.0",
      referral_id: request.referral_id,
      status: "rejected",
      source_project_id: request.source_project_id,
      target_project_id: request.target_project_id,
      code,
      message
    };
    await this.repository.writeReceipt(receipt);
    return receipt;
  }
}
