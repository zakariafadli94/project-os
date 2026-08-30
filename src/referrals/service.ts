import {
  parseReferralWriteRequest,
  type ReferralTransportReceipt,
  type ReferralWriteRequest
} from "../domain/referral";
import { workspaceManagedDocumentPath } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
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
      throw new Error(`Referral target project was not found: ${request.target_project_id}`);
    }

    const envelope = { ...request, canonical: false as const };
    const markdown = renderReferralMarkdown(envelope);
    const inputPath = workspaceManagedDocumentPath(
      target.project_id,
      target.slug,
      "inputs",
      `REFERRAL-${request.referral_id}.md`
    );

    await this.runtime.objects.createText(inputPath, markdown);

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
}
