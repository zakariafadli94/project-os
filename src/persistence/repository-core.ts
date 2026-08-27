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
    if (
      record.project_id !== projectId
      || record.target_revision !== revision
      || record.projection_version !== projectionVersion
    ) {
      throw new Error(`Materialization record binding mismatch for ${projectId} revision ${revision} projection ${projectionVersion}`);
    }
    return record;
  }

  async listMaterializationRecordRefs(projectId: string): Promise<MaterializationGenerationRef[]> {
    if (this.mode !== "v2") return [];
    const entries = await this.persistence.objects.listChildren(machineMaterializationRoot(projectId));
    const refs: MaterializationGenerationRef[] = [];
    for (const entry of entries) {
      if (entry.kind !== "file") continue;
      const match = /^REV-(\d{6,})-PV-(\d{4,})\.json$/.exec(entry.name);
      if (!match) continue;
      const target_revision = Number.parseInt(match[1], 10);
      const projection_version = Number.parseInt(match[2], 10);
      if (!Number.isSafeInteger(target_revision) || !Number.isSafeInteger(projection_version) || projection_version < 1) continue;
      refs.push({ target_revision, projection_version });
    }
    return refs.sort((a, b) =>
      a.projection_version - b.projection_version || a.target_revision - b.target_revision
    );
  }

  async readReceipt(transactionId: string): Promise<Receipt | null> {
    const path = this.mode === "v2"
      ? machineReceiptPath(transactionId)
      : receiptPath(transactionId);
    const raw = await this.persistence.objects.readText(path);
    if (raw === null) return null;
    const receipt = JSON.parse(raw) as Receipt;
    if (receipt.transaction_id !== transactionId) {
      throw new Error(`Canonical receipt binding mismatch: expected ${transactionId}, got ${receipt.transaction_id}`);
    }
    return receipt;
  }

  async readRegistry(): Promise<unknown | null> {
    const path = this.mode === "v2" ? machineRegistryJsonPath() : registryJsonPath();
    const raw = await this.persistence.objects.readText(path);
    return raw === null ? null : JSON.parse(raw);
  }

  async writeCommitRecord(record: CanonicalCommitRecord): Promise<void> {
    if (this.mode !== "v2") throw new Error("Canonical commit records require V2 layout mode");
    const validated = parseCanonicalCommitRecord(record);
    await this.safeAdd(
      machineCommitRecordPath(validated.project_id, validated.new_revision),
      pretty(validated)
    );
  }

  async writeCompletedMaterializationRecord(record: CompletedMaterializationRecord): Promise<void> {
    if (this.mode !== "v2") throw new Error("Completed materialization records require V2 layout mode");
    const validated = parseCompletedMaterializationRecord(record);
    await this.safeAdd(
      machineMaterializationRecordPath(
        validated.project_id,
        validated.target_revision,
        validated.projection_version
      ),
      pretty(validated)
    );
  }

  async writeMaterializationHead(head: MaterializationHead): Promise<void> {
    if (this.mode !== "v2") throw new Error("Materialization head requires V2 layout mode");
    const validated = parseMaterializationHead(head);
    const expectedPath = machineMaterializationRecordPath(
      validated.project_id,
      validated.target_revision,
      validated.projection_version
    );
    if (validated.record_path !== expectedPath) {
      throw new Error("Materialization head does not reference its canonical generation record path");
    }
    const record = await this.readMaterializationRecord(
      validated.project_id,
      validated.target_revision,
      validated.projection_version
    );
    if (
      !record
      || record.project_id !== validated.project_id
      || record.target_revision !== validated.target_revision
      || record.projection_version !== validated.projection_version
      || record.result_root_hash !== validated.result_root_hash
      || record.workspace_location !== validated.workspace_location
    ) {
      throw new Error("Materialization head does not match its immutable completed record");
    }
    await this.persistence.objects.upsertText(
      machineMaterializationHeadPath(validated.project_id),
      pretty(validated)
    );
  }

  async materializeCommit(
    record: CanonicalCommitRecord,
    options: CommitWriteOptions = {}
  ): Promise<void> {
    if (this.mode !== "v2") throw new Error("Canonical commit materialization requires V2 layout mode");
    const validated = parseCanonicalCommitRecord(record);
    await this.writeMachineState(validated.state, validated.event);

    if (validated.state.status === "archived") {
      await this.materializeArchivedWorkspace(validated.state);
    } else {
      await this.writeHumanViews(validated.state);
    }

    if (options.publishReceipt !== false) {
      await this.writeReceipt(validated.receipt);
    }
  }

  async materializeCanonicalDerivatives(
    record: CanonicalCommitRecord,
    options: CommitWriteOptions = {}
  ): Promise<void> {
    if (this.mode !== "v2") throw new Error("Canonical derivative materialization requires V2 layout mode");
    const validated = parseCanonicalCommitRecord(record);
    await this.writeMachineState(validated.state, validated.event);
    if (options.publishReceipt !== false) {
      await this.writeReceipt(validated.receipt);
    }
  }

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

    if (state.status === "archived") {
      await this.archiveHumanWorkspace(state);
    }

    if (options.publishReceipt !== false) {
      await this.writeReceipt(receipt);
    }
  }

  async writeArtifact(state: ProjectState, request: ArtifactWriteRequest): Promise<"written" | "idempotent"> {
    if (this.mode === "legacy") throw new Error("Artifact writes require workspace layout mode");
    if (request.project_id !== state.project_id) throw new Error("Artifact request project_id does not match project state");
    if (state.status === "archived") throw new Error("Archived projects do not accept artifact writes");

    const destination = resolveArtifactDestination(state, request.relative_path);
    const path = destination.path;
    const existing = await this.persistence.objects.readText(path);
    if (existing === request.content) return "idempotent";

    if (request.mode === "create" && existing !== null) {
      throw new ArtifactContentConflictError(path);
    }

    if (request.mode === "replace" && existing !== null && destination.archive_path) {
      await this.archiveExisting(destination.archive_path, existing);
    }

    try {
      if (existing === null) await this.persistence.objects.createText(path, request.content);
      else await this.persistence.objects.upsertText(path, request.content);
      return "written";
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const current = await this.persistence.objects.readText(path);
      if (current === request.content) return "idempotent";
      if (request.mode === "create") throw new ArtifactContentConflictError(path);
      if (current !== null && destination.archive_path) await this.archiveExisting(destination.archive_path, current);
      await this.persistence.objects.upsertText(path, request.content);
      return "written";
    }
  }

  async writeArtifactReceipt(receipt: ArtifactWriteReceipt): Promise<void> {
    if (this.mode === "legacy") throw new Error("Artifact receipts require workspace layout mode");
    await this.safeAdd(machineArtifactReceiptPath(receipt.request_id), pretty(receipt));
  }

  async writeHumanViews(state: ProjectState): Promise<void> {
    for (const id of Object.keys(state.decisions).sort()) {
      await this.persistence.objects.upsertText(
        workspaceEntityPath(state.project_id, state.slug, "DECISIONS", id),
        renderDecision(state, state.decisions[id])
      );
    }
    for (const id of Object.keys(state.constraints).sort()) {
      await this.persistence.objects.upsertText(
        workspaceEntityPath(state.project_id, state.slug, "CONSTRAINTS", id),
        renderConstraint(state, state.constraints[id])
      );
    }
    for (const id of Object.keys(state.tasks).sort()) {
      await this.persistence.objects.upsertText(
        workspaceEntityPath(state.project_id, state.slug, "TASKS", id),
        renderTask(state, state.tasks[id])
      );
    }
    for (const id of Object.keys(state.research).sort()) {
      await this.persistence.objects.upsertText(
        workspaceEntityPath(state.project_id, state.slug, "RESEARCH", id),
        renderResearch(state, state.research[id])
      );
    }
    for (const id of Object.keys(state.deliverables).sort()) {
      await this.persistence.objects.upsertText(
        workspaceEntityPath(state.project_id, state.slug, "DELIVERABLES", id),
        renderDeliverable(state, state.deliverables[id])
      );
    }

    await this.persistence.objects.upsertText(workspaceProjectFile(state.project_id, state.slug, "BRIEF.md"), renderBrief(state));
    await this.persistence.objects.upsertText(workspaceProjectFile(state.project_id, state.slug, "DISCOVERY.md"), renderDiscovery(state));
    await this.persistence.objects.upsertText(workspaceProjectFile(state.project_id, state.slug, "ROADMAP.md"), renderRoadmap(state));
    await this.persistence.objects.upsertText(workspaceProjectFile(state.project_id, state.slug, "PROJECT.md"), renderProject(state));
    await this.persistence.objects.upsertText(workspaceProjectFile(state.project_id, state.slug, "STATE.md"), renderState(state));
    await this.persistence.objects.upsertText(workspaceProjectFile(state.project_id, state.slug, "PLAN.md"), renderPlan(state));
    await this.persistence.objects.upsertText(workspaceProjectFile(state.project_id, state.slug, "HANDOFF.md"), renderHandoff(state));
  }

  async archiveHumanWorkspace(state: ProjectState): Promise<void> {
    if (this.mode === "legacy") return;

    const from = workspaceProjectRoot(state.project_id, state.slug);
    const to = archiveProjectRoot(state.project_id, state.slug);
    try {
      await this.persistence.objects.move(from, to);
      return;
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
    }

    const archivedProject = await this.persistence.objects.readText(`${to}/PROJECT.md`);
    const workspaceProject = await this.persistence.objects.readText(`${from}/PROJECT.md`);
    if (archivedProject !== null && workspaceProject === null) return;
    if (archivedProject === null && workspaceProject === null) return;
    throw new Error(`Archived workspace move is inconsistent: ${from} -> ${to}`);
  }

  async writeMachineState(state: ProjectState, event: DomainEvent): Promise<void> {
    await this.safeAdd(machineEventPath(state.project_id, event.event_id), pretty(event));
    await this.writeMachineSnapshot(state);
  }

  async writeMachineSnapshot(state: ProjectState): Promise<void> {
    await this.persistence.objects.upsertText(machineStatePath(state.project_id), pretty(state));
    await this.persistence.objects.upsertText(machineManifestPath(state.project_id), pretty(manifestFor(state)));
  }

  async materializeWorkspace(state: ProjectState): Promise<void> {
    if (state.status === "archived") {
      await this.archiveHumanWorkspace(state);
      return;
    }
    await this.writeHumanViews(state);
  }

  async materializeV2(state: ProjectState): Promise<void> {
    await this.writeMachineSnapshot(state);
    if (state.status === "archived") {
      await this.archiveHumanWorkspace(state);
      return;
    }
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
      await this.persistence.objects.upsertText(registryJsonPath(), pretty(registry));
      await this.persistence.objects.upsertText(registryMarkdownPath(), markdown);
    }
    if (this.mode === "shadow" || this.mode === "v2") {
      await this.persistence.objects.upsertText(machineRegistryJsonPath(), pretty(registry));
      await this.persistence.objects.upsertText(machineRegistryMarkdownPath(), markdown);
      await this.persistence.objects.upsertText(workspacePortfolioDashboardPath(), markdown);
    }
  }

  private async materializeArchivedWorkspace(state: ProjectState): Promise<void> {
    const archivedProjectPath = `${archiveProjectRoot(state.project_id, state.slug)}/PROJECT.md`;
    const workspaceProjectPath = `${workspaceProjectRoot(state.project_id, state.slug)}/PROJECT.md`;
    const archivedProject = await this.persistence.objects.readText(archivedProjectPath);
    const workspaceProject = await this.persistence.objects.readText(workspaceProjectPath);

    if (archivedProject !== null) {
      if (workspaceProject !== null) {
        throw new Error(`Archived workspace already exists while active workspace is still present: ${state.project_id}`);
      }
      return;
    }

    await this.writeHumanViews(state);
    await this.archiveHumanWorkspace(state);
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
      await this.persistence.objects.upsertText(decisionPath(state.project_id, state.slug, decisionId), renderDecision(state, decision));
    }

    await this.persistence.objects.upsertText(projectFile(state.project_id, state.slug, "PROJECT.md"), renderProject(state));
    await this.persistence.objects.upsertText(projectFile(state.project_id, state.slug, "STATE.md"), renderState(state));
    await this.persistence.objects.upsertText(projectFile(state.project_id, state.slug, "PLAN.md"), renderPlan(state));
    await this.persistence.objects.upsertText(projectFile(state.project_id, state.slug, "HANDOFF.md"), renderHandoff(state));
    await this.persistence.objects.upsertText(manifestPath(state.project_id, state.slug), pretty(manifestFor(state)));
  }

  private async archiveExisting(basePath: string, content: string): Promise<void> {
    const hash = await sha256(content);
    const slash = basePath.lastIndexOf("/");
    const dot = basePath.lastIndexOf(".");
    const hasExtension = dot > slash;
    const archivePath = hasExtension
      ? `${basePath.slice(0, dot)}.previous-${hash.slice(0, 12)}${basePath.slice(dot)}`
      : `${basePath}.previous-${hash.slice(0, 12)}`;
    await this.safeAdd(archivePath, content);
  }

  private async safeAdd(path: string, content: string): Promise<void> {
    try {
      await this.persistence.objects.createText(path, content);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.persistence.objects.readText(path);
      if (existing !== content) {
        throw new Error(`Immutable persistence path conflict with different content: ${path}`);
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

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
