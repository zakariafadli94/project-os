import type { ArtifactWriteReceipt, ArtifactWriteRequest } from "../domain/artifact-write";
import { parseCanonicalCommitRecord, type CanonicalCommitRecord } from "../domain/commit-record";
import type { DomainEvent } from "../domain/event";
import {
  parseCompletedMaterializationRecord,
  parseMaterializationHead,
  type CompletedMaterializationRecord,
  type MaterializationGenerationRef,
  type MaterializationHead
} from "../domain/materialization";
import type { ProjectState } from "../domain/project-state";
import { normalizeProjectState } from "../domain/project-state-normalizer";
import type { Receipt } from "../domain/receipt";
import type { Transaction } from "../domain/transaction";
import { renderBrief } from "../render/brief";
import { renderConstraint } from "../render/constraint";
import { renderDecision } from "../render/decision";
import { renderDeliverable } from "../render/deliverable";
import { renderDiscovery } from "../render/discovery";
import { renderHandoff } from "../render/handoff";
import { renderPlan } from "../render/plan";
import { renderProject } from "../render/project";
import { renderResearch } from "../render/research";
import { renderRoadmap } from "../render/roadmap";
import { renderState } from "../render/state";
import { renderTask } from "../render/task";
import { ArtifactGovernanceConflictError, resolveArtifactDestination } from "./artifact-routing";
import { asProjectOsPersistence, type PersistenceInput } from "./compatibility/legacy-dropbox-runtime";
import {
  archiveProjectRoot,
  type LayoutMode,
  machineArtifactReceiptPath,
  machineCommitRecordPath,
  machineEventPath,
  machineManifestPath,
  machineMaterializationHeadPath,
  machineMaterializationRecordPath,
  machineMaterializationRoot,
  machineReceiptPath,
  machineRegistryJsonPath,
  machineRegistryMarkdownPath,
  machineStatePath,
  machineTransactionPath,
  workspaceEntityPath,
  workspacePortfolioDashboardPath,
  workspaceProjectFile,
  workspaceProjectRoot
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
import type { ProjectOsPersistenceRuntime } from "./provider/capabilities";
import { ProviderConflictError } from "./provider/errors";

export { ArtifactGovernanceConflictError } from "./artifact-routing";

export interface CommitWriteOptions {
  publishReceipt?: boolean;
  projectionVersion?: number;
}

export class ArtifactContentConflictError extends Error {
  constructor(public readonly path: string) {
    super(`Artifact already exists with different content: ${path}`);
    this.name = "ArtifactContentConflictError";
  }
}

export class ProjectRepository {
  protected readonly persistence: ProjectOsPersistenceRuntime;

  constructor(
    input: PersistenceInput,
    protected readonly mode: LayoutMode = "legacy"
  ) {
    this.persistence = asProjectOsPersistence(input);
  }

  async readProjectState(projectId: string): Promise<ProjectState | null> {
    if (this.mode === "legacy") return null;
    const raw = await this.persistence.objects.readText(machineStatePath(projectId));
    if (raw === null) return null;
    const state = normalizeProjectState(JSON.parse(raw));
    if (state.project_id !== projectId) {
      throw new Error(`Canonical project state binding mismatch: expected ${projectId}, got ${state.project_id}`);
    }
    return state;
  }

  async readCommitRecord(projectId: string, revision: number): Promise<CanonicalCommitRecord | null> {
    if (this.mode !== "v2") return null;
    const raw = await this.persistence.objects.readText(machineCommitRecordPath(projectId, revision));
    if (raw === null) return null;
    const record = parseCanonicalCommitRecord(JSON.parse(raw));
    if (record.project_id !== projectId || record.new_revision !== revision) {
      throw new Error(`Canonical commit record binding mismatch for ${projectId} revision ${revision}`);
    }
    return record;
  }

  async readMaterializationHead(projectId: string): Promise<MaterializationHead | null> {
    if (this.mode !== "v2") return null;
    const raw = await this.persistence.objects.readText(machineMaterializationHeadPath(projectId));
    if (raw === null) return null;
    const head = parseMaterializationHead(JSON.parse(raw));
    if (head.project_id !== projectId) {
      throw new Error(`Materialization head binding mismatch for ${projectId}`);
    }
    const expectedPath = machineMaterializationRecordPath(projectId, head.target_revision, head.projection_version);
    if (head.record_path !== expectedPath) {
      throw new Error(`Materialization head record binding mismatch for ${projectId}`);
    }
    return head;
  }

  async readMaterializationRecord(
    projectId: string,
    revision: number,
    projectionVersion: number
  ): Promise<CompletedMaterializationRecord | null> {
    if (this.mode !== "v2") return null;
    const raw = await this.persistence.objects.readText(machineMaterializationRecordPath(projectId, revision, projectionVersion));
    if (raw === null) return null;
    const record = parseCompletedMaterializationRecord(JSON.parse(raw));
    if (record.project_id !== projectId || record.target_revision !== revision || record.projection_version !== projectionVersion) {
      throw new Error(`Materialization record binding mismatch for ${projectId} revision ${revision} projection ${projectionVersion}`);
    }
    return record;
  }

  async listMaterializationRecordRefs(projectId: string): Promise<MaterializationGenerationRef[]> {
    if (this.mode !== "v2") return [];
    const entries = await this.persistence.objects.list(machineMaterializationRoot(projectId));
    return entries
      .map((entry) => {
        const match = /^REV-([0-9]{6,})-PV-([0-9]{4,})\.json$/.exec(entry.name);
        if (!match) return null;
        return {
          target_revision: Number(match[1]),
          projection_version: Number(match[2])
        } satisfies MaterializationGenerationRef;
      })
      .filter((value): value is MaterializationGenerationRef => value !== null)
      .sort((a, b) => a.projection_version - b.projection_version || a.target_revision - b.target_revision);
  }

  async writeCompletedMaterializationRecord(record: CompletedMaterializationRecord): Promise<void> {
    if (this.mode !== "v2") return;
    const path = machineMaterializationRecordPath(record.project_id, record.target_revision, record.projection_version);
    const content = `${JSON.stringify(record, null, 2)}\n`;
    await this.writeImmutableText(path, content, "Materialization record");
  }

  async writeMaterializationHead(head: MaterializationHead): Promise<void> {
    if (this.mode !== "v2") return;
    const record = await this.readMaterializationRecord(head.project_id, head.target_revision, head.projection_version);
    if (!record || record.result_root_hash !== head.result_root_hash || record.workspace_location !== head.workspace_location) {
      throw new Error(`Materialization head is not backed by matching immutable record for ${head.project_id}`);
    }
    await this.persistence.objects.writeText(machineMaterializationHeadPath(head.project_id), `${JSON.stringify(head, null, 2)}\n`, "overwrite");
  }

  async writeCanonicalCommit(record: CanonicalCommitRecord, options: CommitWriteOptions = {}): Promise<void> {
    if (this.mode !== "v2") return;
    await this.writeCanonicalCommitRecord(record);
    await this.materializeCanonicalDerivatives(record, options);
  }

  async writeCanonicalCommitRecord(record: CanonicalCommitRecord): Promise<void> {
    if (this.mode !== "v2") return;
    await this.writeImmutableText(
      machineCommitRecordPath(record.project_id, record.new_revision),
      `${JSON.stringify(record, null, 2)}\n`,
      "Canonical commit record"
    );
  }

  async materializeCanonicalDerivatives(record: CanonicalCommitRecord, options: CommitWriteOptions = {}): Promise<void> {
    if (this.mode !== "v2") return;
    await Promise.all([
      this.persistence.objects.writeText(machineStatePath(record.project_id), `${JSON.stringify(record.state, null, 2)}\n`, "overwrite"),
      this.persistence.objects.writeText(machineEventPath(record.project_id, record.event.event_id), `${JSON.stringify(record.event, null, 2)}\n`, "add"),
      this.persistence.objects.writeText(machineTransactionPath(record.transaction.transaction_id), `${JSON.stringify(record.transaction, null, 2)}\n`, "add"),
      ...(options.publishReceipt === false
        ? []
        : [this.persistence.objects.writeText(machineReceiptPath(record.transaction.transaction_id), `${JSON.stringify(record.receipt, null, 2)}\n`, "overwrite")])
    ]);
  }

  async writeProjectState(state: ProjectState): Promise<void> {
    if (this.mode !== "v2") return;
    await this.persistence.objects.writeText(machineStatePath(state.project_id), `${JSON.stringify(state, null, 2)}\n`, "overwrite");
  }

  async writeEvent(projectId: string, event: DomainEvent): Promise<void> {
    if (this.mode !== "v2") return;
    await this.persistence.objects.writeText(machineEventPath(projectId, event.event_id), `${JSON.stringify(event, null, 2)}\n`, "add");
  }

  async writeTransaction(transaction: Transaction): Promise<void> {
    if (this.mode !== "v2") return;
    await this.persistence.objects.writeText(machineTransactionPath(transaction.transaction_id), `${JSON.stringify(transaction, null, 2)}\n`, "add");
  }

  async writeReceipt(receipt: Receipt): Promise<void> {
    if (this.mode !== "v2") return;
    await this.persistence.objects.writeText(machineReceiptPath(receipt.transaction_id), `${JSON.stringify(receipt, null, 2)}\n`, "overwrite");
  }

  async readReceipt(transactionId: string): Promise<Receipt | null> {
    if (this.mode !== "v2") return null;
    const raw = await this.persistence.objects.readText(machineReceiptPath(transactionId));
    return raw ? JSON.parse(raw) as Receipt : null;
  }

  async writeManifest(projectId: string, manifest: unknown): Promise<void> {
    if (this.mode !== "v2") return;
    await this.persistence.objects.writeText(machineManifestPath(projectId), `${JSON.stringify(manifest, null, 2)}\n`, "overwrite");
  }

  async materializeHumanWorkspace(state: ProjectState): Promise<void> {
    if (this.mode !== "v2") return;
    const root = workspaceProjectRoot(state.project_id, state.slug);
    await Promise.all([
      this.persistence.objects.writeText(workspaceProjectFile(state.project_id, state.slug, "PROJECT.md"), renderProject(state), "overwrite"),
      this.persistence.objects.writeText(workspaceProjectFile(state.project_id, state.slug, "BRIEF.md"), renderBrief(state), "overwrite"),
      this.persistence.objects.writeText(workspaceProjectFile(state.project_id, state.slug, "DISCOVERY.md"), renderDiscovery(state), "overwrite"),
      this.persistence.objects.writeText(workspaceProjectFile(state.project_id, state.slug, "ROADMAP.md"), renderRoadmap(state), "overwrite"),
      this.persistence.objects.writeText(workspaceProjectFile(state.project_id, state.slug, "STATE.md"), renderState(state), "overwrite"),
      this.persistence.objects.writeText(workspaceProjectFile(state.project_id, state.slug, "PLAN.md"), renderPlan(state), "overwrite"),
      this.persistence.objects.writeText(workspaceProjectFile(state.project_id, state.slug, "HANDOFF.md"), renderHandoff(state), "overwrite"),
      ...Object.values(state.tasks).map((task) => this.persistence.objects.writeText(workspaceEntityPath(root, "tasks", task.task_id), renderTask(task), "overwrite")),
      ...Object.values(state.decisions).map((decision) => this.persistence.objects.writeText(workspaceEntityPath(root, "decisions", decision.decision_id), renderDecision(decision), "overwrite")),
      ...Object.values(state.research).map((research) => this.persistence.objects.writeText(workspaceEntityPath(root, "research", research.research_id), renderResearch(research), "overwrite")),
      ...Object.values(state.deliverables).map((deliverable) => this.persistence.objects.writeText(workspaceEntityPath(root, "deliverables", deliverable.deliverable_id), renderDeliverable(deliverable), "overwrite")),
      ...Object.values(state.constraints).map((constraint) => this.persistence.objects.writeText(workspaceEntityPath(root, "constraints", constraint.constraint_id), renderConstraint(constraint), "overwrite"))
    ]);
  }

  async archiveHumanWorkspace(state: ProjectState): Promise<void> {
    if (this.mode !== "v2") return;
    const activeRoot = workspaceProjectRoot(state.project_id, state.slug);
    const archiveRoot = archiveProjectRoot(state.project_id, state.slug);
    await this.persistence.objects.move(activeRoot, archiveRoot);
  }

  async writeArtifact(
    state: ProjectState,
    request: ArtifactWriteRequest,
    _preparedDestination?: unknown
  ): Promise<"written" | "idempotent"> {
    if (this.mode === "legacy") return "written";

    const destination = resolveArtifactDestination(state, request.relative_path);
    const existing = await this.persistence.objects.readText(destination.path);
    if (existing === request.content) return "idempotent";
    if (existing !== null) throw new ArtifactContentConflictError(destination.path);

    if (destination.archive_path) {
      const archived = await this.persistence.objects.readText(destination.archive_path);
      if (archived === request.content) return "idempotent";
      if (archived !== null) throw new ArtifactContentConflictError(destination.archive_path);
    }

    try {
      await this.persistence.objects.writeText(destination.path, request.content, "add");
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const reread = await this.persistence.objects.readText(destination.path);
      if (reread === request.content) return "idempotent";
      throw new ArtifactContentConflictError(destination.path);
    }

    const receipt: ArtifactWriteReceipt = {
      schema_version: "1.0",
      request_id: request.request_id,
      status: "committed",
      project_id: request.project_id,
      relative_path: request.relative_path,
      content_hash: request.content_hash,
      destination_path: destination.path,
      committed_at: new Date().toISOString()
    };
    await this.persistence.objects.writeText(machineArtifactReceiptPath(request.request_id), `${JSON.stringify(receipt, null, 2)}\n`, "overwrite");
    return "written";
  }

  async readArtifactReceipt(requestId: string): Promise<ArtifactWriteReceipt | null> {
    if (this.mode !== "v2") return null;
    const raw = await this.persistence.objects.readText(machineArtifactReceiptPath(requestId));
    return raw ? JSON.parse(raw) as ArtifactWriteReceipt : null;
  }

  async readRegistryJson(): Promise<unknown | null> {
    const raw = await this.persistence.objects.readText(machineRegistryJsonPath());
    return raw ? JSON.parse(raw) : null;
  }

  async writeRegistryJson(registry: unknown): Promise<void> {
    await this.persistence.objects.writeText(machineRegistryJsonPath(), `${JSON.stringify(registry, null, 2)}\n`, "overwrite");
  }

  async writeRegistryMarkdown(content: string): Promise<void> {
    await this.persistence.objects.writeText(machineRegistryMarkdownPath(), content, "overwrite");
  }

  async writePortfolioDashboard(content: string): Promise<void> {
    await this.persistence.objects.writeText(workspacePortfolioDashboardPath(), content, "overwrite");
  }

  private async writeImmutableText(path: string, content: string, label: string): Promise<void> {
    try {
      await this.persistence.objects.writeText(path, content, "add");
      return;
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
    }
    const existing = await this.persistence.objects.readText(path);
    if (existing === content) return;
    throw new Error(`${label} conflict with different content: ${path}`);
  }
}
