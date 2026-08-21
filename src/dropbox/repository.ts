import type { DomainEvent } from "../domain/event";
import type { ProjectState } from "../domain/project-state";
import type { Receipt } from "../domain/receipt";
import type { Transaction } from "../domain/transaction";
import { renderConstraint } from "../render/constraint";
import { renderDecision } from "../render/decision";
import { renderDeliverable } from "../render/deliverable";
import { renderHandoff } from "../render/handoff";
import { renderPlan } from "../render/plan";
import { renderProject } from "../render/project";
import { renderResearch } from "../render/research";
import { renderState } from "../render/state";
import { renderTask } from "../render/task";
import { DropboxConflictError, type DropboxTransport } from "./client";
import {
  type LayoutMode,
  machineEventPath,
  machineManifestPath,
  machineReceiptPath,
  machineRegistryJsonPath,
  machineRegistryMarkdownPath,
  machineStatePath,
  machineTransactionPath,
  workspaceEntityPath,
  workspacePortfolioDashboardPath,
  workspaceProjectFile
} from "./layout";
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
  constructor(
    private readonly transport: DropboxTransport,
    private readonly mode: LayoutMode = "legacy"
  ) {}

  async writeCommit(
    state: ProjectState,
    event: DomainEvent,
    receipt: Receipt,
    options: CommitWriteOptions = {}
  ): Promise<void> {
    if (this.mode === "legacy") {
      await this.writeLegacyArtifacts(state, event);
    } else if (this.mode === "shadow") {
      await this.writeLegacyArtifacts(state, event);
      await this.writeMachineState(state, event);
      await this.writeHumanViews(state);
    } else {
      await this.writeMachineState(state, event);
      await this.writeHumanViews(state);
    }

    if (options.publishReceipt !== false) {
      await this.writeReceipt(receipt);
    }
  }

  async writeHumanViews(state: ProjectState): Promise<void> {
    for (const id of Object.keys(state.decisions).sort()) {
      await this.transport.upload(
        workspaceEntityPath(state.project_id, state.slug, "DECISIONS", id),
        renderDecision(state, state.decisions[id]),
        "overwrite"
      );
    }
    for (const id of Object.keys(state.constraints).sort()) {
      await this.transport.upload(
        workspaceEntityPath(state.project_id, state.slug, "CONSTRAINTS", id),
        renderConstraint(state, state.constraints[id]),
        "overwrite"
      );
    }
    for (const id of Object.keys(state.tasks).sort()) {
      await this.transport.upload(
        workspaceEntityPath(state.project_id, state.slug, "TASKS", id),
        renderTask(state, state.tasks[id]),
        "overwrite"
      );
    }
    for (const id of Object.keys(state.research).sort()) {
      await this.transport.upload(
        workspaceEntityPath(state.project_id, state.slug, "RESEARCH", id),
        renderResearch(state, state.research[id]),
        "overwrite"
      );
    }
    for (const id of Object.keys(state.deliverables).sort()) {
      await this.transport.upload(
        workspaceEntityPath(state.project_id, state.slug, "DELIVERABLES", id),
        renderDeliverable(state, state.deliverables[id]),
        "overwrite"
      );
    }

    await this.transport.upload(workspaceProjectFile(state.project_id, state.slug, "PROJECT.md"), renderProject(state), "overwrite");
    await this.transport.upload(workspaceProjectFile(state.project_id, state.slug, "STATE.md"), renderState(state), "overwrite");
    await this.transport.upload(workspaceProjectFile(state.project_id, state.slug, "PLAN.md"), renderPlan(state), "overwrite");
    await this.transport.upload(workspaceProjectFile(state.project_id, state.slug, "HANDOFF.md"), renderHandoff(state), "overwrite");
  }

  async writeMachineState(state: ProjectState, event: DomainEvent): Promise<void> {
    await this.safeAdd(machineEventPath(state.project_id, event.event_id), pretty(event));
    await this.transport.upload(machineStatePath(state.project_id), pretty(state), "overwrite");
    await this.transport.upload(machineManifestPath(state.project_id), pretty(manifestFor(state)), "overwrite");
  }

  async materializeWorkspace(state: ProjectState): Promise<void> {
    await this.writeHumanViews(state);
  }

  async writeReceipt(receipt: Receipt): Promise<void> {
    const path = this.mode === "v2"
      ? machineReceiptPath(receipt.transaction_id)
      : receiptPath(receipt.transaction_id);
    await this.safeAdd(path, pretty(receipt));
  }

  async writeTerminalTransaction(transaction: Transaction, receipt: Receipt): Promise<void> {
    const statusFolder = receipt.status === "conflict" ? "conflicts" : receipt.status;
    const path = this.mode === "v2"
      ? machineTransactionPath(statusFolder, transaction.transaction_id)
      : transactionPath(statusFolder, transaction.transaction_id);
    await this.safeAdd(path, pretty({ transaction, receipt }));
    await this.writeReceipt(receipt);
  }

  async writeRegistry(registry: unknown, markdown: string): Promise<void> {
    if (this.mode === "legacy" || this.mode === "shadow") {
      await this.transport.upload(registryJsonPath(), pretty(registry), "overwrite");
      await this.transport.upload(registryMarkdownPath(), markdown, "overwrite");
    }
    if (this.mode === "shadow" || this.mode === "v2") {
      await this.transport.upload(machineRegistryJsonPath(), pretty(registry), "overwrite");
      await this.transport.upload(machineRegistryMarkdownPath(), markdown, "overwrite");
      await this.transport.upload(workspacePortfolioDashboardPath(), markdown, "overwrite");
    }
  }

  private async writeLegacyArtifacts(state: ProjectState, event: DomainEvent): Promise<void> {
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
    await this.transport.upload(manifestPath(state.project_id, state.slug), pretty(manifestFor(state)), "overwrite");
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

function manifestFor(state: ProjectState): object {
  return {
    schema_version: state.schema_version,
    project_id: state.project_id,
    slug: state.slug,
    revision: state.revision,
    status: state.status,
    last_event_id: state.last_event_id,
    updated_at: state.updated_at
  };
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
