export * from "./repository-core";

import type { ArtifactWriteRequest } from "../domain/artifact-write";
import { parseCanonicalCommitRecord, type CanonicalCommitRecord } from "../domain/commit-record";
import type { ProjectState } from "../domain/project-state";
import type { Receipt } from "../domain/receipt";
import { ArtifactMutationIntentService } from "../mutation-gate/artifact-intent";
import { MutationGateRepository } from "../mutation-gate/repository";
import {
  MutationGateService,
  type CandidateResolutionContext,
  type MutationGateMode
} from "../mutation-gate/service";
import { LegacyArtifactDocumentWriter } from "../documents/legacy-artifact";
import { encodeManifest } from "../schema/manifest";
import { encodeProjectState, readProjectState as readProjectStateRecord } from "../schema/project-state";
import { readReceipt as readReceiptRecord } from "../schema/receipt";
import type { SchemaWriterStage } from "../schema/writer-stage";
import { resolveArtifactDestination, type ResolvedArtifactDestination } from "./artifact-routing";
import {
  machineCommitRecordPath,
  machineManifestPath,
  machineReceiptPath,
  machineStatePath,
  workspaceManagedZoneRoot,
  type LayoutMode
} from "./layout";
import { receiptPath } from "./paths";
import type { ProjectOsPersistenceRuntime } from "./provider/capabilities";
import { ProviderConflictError } from "./provider/errors";
import {
  asProjectOsPersistence,
  type PersistenceInput
} from "./provider/runtime";
import { ProjectRepository as CoreProjectRepository, type CommitWriteOptions } from "./repository-core";

type ActivationDerivativeOptions = CommitWriteOptions & {
  projectionVersion?: number;
};

export class ProjectRepository extends CoreProjectRepository {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly artifactMutationIntents: ArtifactMutationIntentService;
  private readonly mutationGate: MutationGateService;

  constructor(
    input: PersistenceInput,
    private readonly repositoryMode: LayoutMode = "legacy",
    mutationGateMode: MutationGateMode = "observe",
    private readonly schemaWriterStage: SchemaWriterStage = "v1_only"
  ) {
    const runtime = asProjectOsPersistence(input);
    super(runtime, repositoryMode);
    this.runtime = runtime;
    const mutationRepository = new MutationGateRepository(runtime, schemaWriterStage);
    this.artifactMutationIntents = new ArtifactMutationIntentService(mutationRepository, runtime);
    this.mutationGate = new MutationGateService(runtime, mutationGateMode, schemaWriterStage);
  }

  override async readProjectState(projectId: string): Promise<ProjectState | null> {
    if (this.repositoryMode === "legacy") return null;
    const raw = await this.runtime.objects.readText(machineStatePath(projectId));
    if (raw === null) return null;
    const state = readProjectStateRecord(JSON.parse(raw)).state;
    if (state.project_id !== projectId) {
      throw new Error(`Canonical project state binding mismatch: expected ${projectId}, got ${state.project_id}`);
    }
    return state;
  }

  override async readReceipt(transactionId: string): Promise<Receipt | null> {
    const path = this.repositoryMode === "v2"
      ? machineReceiptPath(transactionId)
      : receiptPath(transactionId);
    const raw = await this.runtime.objects.readText(path);
    if (raw === null) return null;
    const receipt = readReceiptRecord(JSON.parse(raw));
    if (receipt.transaction_id !== transactionId) {
      throw new Error(`Canonical receipt binding mismatch: expected ${transactionId}, got ${receipt.transaction_id}`);
    }
    return receipt;
  }

  override async writeCommitRecord(record: CanonicalCommitRecord): Promise<void> {
    if (this.repositoryMode !== "v2") throw new Error("Canonical commit records require V2 layout mode");
    const validated = parseCanonicalCommitRecord(record);
    const durableRecord = {
      ...validated,
      state: encodeProjectState(validated.state, this.schemaWriterStage)
    };
    // Reparse before publication so the envelope and nested family binding are
    // proven together while preserving the 1.0 commit envelope.
    parseCanonicalCommitRecord(durableRecord);
    const path = machineCommitRecordPath(validated.project_id, validated.new_revision);
    const content = pretty(durableRecord);
    try {
      await this.runtime.objects.createText(path, content);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.runtime.objects.readText(path);
      if (existing !== content) {
        throw new Error(`Immutable persistence path conflict with different content: ${path}`);
      }
    }
  }

  override async writeMachineSnapshot(state: ProjectState): Promise<void> {
    const encodedState = encodeProjectState(state, this.schemaWriterStage);
    const encodedManifest = encodeManifest(state, this.schemaWriterStage);
    await this.runtime.objects.upsertText(machineStatePath(state.project_id), pretty(encodedState));
    await this.runtime.objects.upsertText(machineManifestPath(state.project_id), pretty(encodedManifest));
  }

  override async materializeCanonicalDerivatives(
    record: CanonicalCommitRecord,
    options: ActivationDerivativeOptions = {}
  ): Promise<void> {
    await super.materializeCanonicalDerivatives(record, options);
    if (
      this.repositoryMode !== "v2"
      || options.projectionVersion === undefined
      || options.projectionVersion < 2
      || record.state.status === "archived"
    ) return;
    await this.ensureManagedWorkspaceDirectories(record.state);
  }

  async ensureManagedWorkspaceDirectories(state: ProjectState): Promise<void> {
    const provisioning = this.runtime.directoryProvisioning;
    if (!provisioning) {
      throw new Error("Projection-v2 managed-zone bootstrap requires directory-provisioning capability");
    }

    const references = workspaceManagedZoneRoot(state.project_id, state.slug, "references");
    const directories = [
      workspaceManagedZoneRoot(state.project_id, state.slug, "inputs"),
      references,
      `${references}/UNCLASSIFIED`,
      workspaceManagedZoneRoot(state.project_id, state.slug, "working"),
      workspaceManagedZoneRoot(state.project_id, state.slug, "review"),
      workspaceManagedZoneRoot(state.project_id, state.slug, "deliverables")
    ];

    for (const path of directories) await provisioning.ensureDirectory(path);
  }

  override async writeArtifact(
    state: ProjectState,
    request: ArtifactWriteRequest,
    preparedDestination?: ResolvedArtifactDestination,
    resolutionContext?: CandidateResolutionContext
  ): Promise<"written" | "idempotent"> {
    if (this.repositoryMode === "legacy") return super.writeArtifact(state, request);

    const prepared = await this.artifactMutationIntents.prepare(state, request);
    if (preparedDestination && !sameDestination(preparedDestination, prepared.destination)) {
      throw new Error(`Prepared artifact destination does not match durable mutation intent: ${request.request_id}`);
    }
    const replayState = stateForPreparedDestination(state, request, prepared.destination);
    await this.mutationGate.assertDestinationClear(replayState, prepared.destination.path, resolutionContext);

    const managed = await new LegacyArtifactDocumentWriter(this.runtime).writeIfManaged(replayState, request);
    if (managed !== null) return managed;
    return super.writeArtifact(replayState, request);
  }
}

function stateForPreparedDestination(
  state: ProjectState,
  request: ArtifactWriteRequest,
  destination: ResolvedArtifactDestination
): ProjectState {
  const replayState: ProjectState = {
    ...state,
    artifact_routes: destination.route
      ? {
          [destination.route.route_id]: {
            ...destination.route,
            decision_ids: []
          }
        }
      : {}
  };
  const reconstructed = resolveArtifactDestination(replayState, request.relative_path);
  if (!sameDestination(reconstructed, destination)) {
    throw new Error(`Durable artifact destination cannot be reconstructed safely: ${request.request_id}`);
  }
  return replayState;
}

function sameDestination(left: ResolvedArtifactDestination, right: ResolvedArtifactDestination): boolean {
  return left.path === right.path
    && left.archive_path === right.archive_path
    && left.route?.route_id === right.route?.route_id
    && left.route?.source_prefix === right.route?.source_prefix
    && left.route?.target_prefix === right.route?.target_prefix
    && left.route?.archive_prefix === right.route?.archive_prefix;
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}