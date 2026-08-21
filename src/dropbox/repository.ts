import type { DomainEvent } from "../domain/event";
import type { ProjectState } from "../domain/project-state";
import type { Receipt } from "../domain/receipt";
import type { Transaction } from "../domain/transaction";
import { renderDecision } from "../render/decision";
import { renderHandoff } from "../render/handoff";
import { renderPlan } from "../render/plan";
import { renderProject } from "../render/project";
import { renderState } from "../render/state";
import { DropboxConflictError, type DropboxTransport } from "./client";
import {
  decisionPath,
  eventPath,
  manifestPath,
  projectFile,
  receiptPath,
  registryJsonPath,
  registryMarkdownPath,
  transactionPath
} from "./paths";

export interface CommitWriteOptions {
  publishReceipt?: boolean;
}

export class ProjectRepository {
  constructor(private readonly transport: DropboxTransport) {}

  async writeCommit(
    state: ProjectState,
    event: DomainEvent,
    receipt: Receipt,
    options: CommitWriteOptions = {}
  ): Promise<void> {
    await this.safeAdd(eventPath(state.project_id, state.slug, event.event_id), pretty(event));

    if (event.type === "decision.accept") {
      const decisionId = String(event.payload.decision_id);
      const decision = state.decisions[decisionId];
      if (!decision) throw new Error(`Committed decision ${decisionId} missing from state`);
      await this.safeAdd(decisionPath(state.project_id, state.slug, decisionId), renderDecision(state, decision));
    }

    if (event.type === "decision.supersede") {
      const decisionId = String(event.payload.decision_id);
      const decision = state.decisions[decisionId];
      if (!decision) throw new Error(`Superseded decision ${decisionId} missing from state`);
      await this.transport.upload(decisionPath(state.project_id, state.slug, decisionId), renderDecision(state, decision), "overwrite");
    }

    await this.transport.upload(projectFile(state.project_id, state.slug, "PROJECT.md"), renderProject(state), "overwrite");
    await this.transport.upload(projectFile(state.project_id, state.slug, "STATE.md"), renderState(state), "overwrite");
    await this.transport.upload(projectFile(state.project_id, state.slug, "PLAN.md"), renderPlan(state), "overwrite");
    await this.transport.upload(projectFile(state.project_id, state.slug, "HANDOFF.md"), renderHandoff(state), "overwrite");
    await this.transport.upload(manifestPath(state.project_id, state.slug), pretty({
      schema_version: state.schema_version,
      project_id: state.project_id,
      slug: state.slug,
      revision: state.revision,
      status: state.status,
      last_event_id: state.last_event_id,
      updated_at: state.updated_at
    }), "overwrite");

    if (options.publishReceipt !== false) {
      await this.writeReceipt(receipt);
    }
  }

  async writeReceipt(receipt: Receipt): Promise<void> {
    await this.safeAdd(receiptPath(receipt.transaction_id), pretty(receipt));
  }

  async writeTerminalTransaction(transaction: Transaction, receipt: Receipt): Promise<void> {
    const statusFolder = receipt.status === "conflict" ? "conflicts" : receipt.status;
    await this.safeAdd(transactionPath(statusFolder, transaction.transaction_id), pretty({ transaction, receipt }));
    await this.writeReceipt(receipt);
  }

  async writeRegistry(registry: unknown, markdown: string): Promise<void> {
    await this.transport.upload(registryJsonPath(), pretty(registry), "overwrite");
    await this.transport.upload(registryMarkdownPath(), markdown, "overwrite");
  }

  private async safeAdd(path: string, content: string): Promise<void> {
    try {
      await this.transport.upload(path, content, "add");
    } catch (error) {
      if (!(error instanceof DropboxConflictError)) throw error;
      const existing = await this.transport.download(path);
      if (existing !== content) {
        throw new Error(`Immutable Dropbox path conflict with different content: ${path}`);
      }
    }
  }
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
