export * from "./repository-core";

import type { ArtifactWriteRequest } from "../domain/artifact-write";
import type { CanonicalCommitRecord } from "../domain/commit-record";
import type { ProjectState } from "../domain/project-state";
import { ArtifactMutationIntentService } from "../mutation-gate/artifact-intent";
import { MutationGateRepository } from "../mutation-gate/repository";
import {
  MutationGateService,
  type CandidateResolutionContext,
  type MutationGateMode
} from "../mutation-gate/service";
import { LegacyArtifactDocumentWriter } from "../documents/legacy-artifact";
import { resolveArtifactDestination, type ResolvedArtifactDestination } from "./artifact-routing";
import { workspaceManagedZoneRoot, type LayoutMode } from "./layout";
import type { ProjectOsPersistenceRuntime } from "./provider/capabilities";
import {
  asProjectOsPersistence,
  type PersistenceInput
} from "./provider/runtime";
import { ProjectRepository as CoreProjectRepository, type CommitWriteOptions } from "./repository-core";

export class ProjectRepository extends CoreProjectRepository {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly artifactMutationIntents: ArtifactMutationIntentService;
  private readonly mutationGate: MutationGateService;

  constructor(
    input: PersistenceInput,
    private readonly repositoryMode: LayoutMode = "legacy",
    mutationGateMode: MutationGateMode = "observe"
  ) {
    const runtime = asProjectOsPersistence(input);
    super(runtime, repositoryMode);
    this.runtime = runtime;
    const mutationRepository = new MutationGateRepository(runtime);
    this.artifactMutationIntents = new ArtifactMutationIntentService(mutationRepository, runtime);
    this.mutationGate = new MutationGateService(runtime, mutationGateMode);
  }

  override async materializeCanonicalDerivatives(
    record: CanonicalCommitRecord,
    options: CommitWriteOptions = {}
  ): Promise<void> {
    await super.materializeCanonicalDerivatives(record, options);
    if (this.repositoryMode !== "v2" || record.state.status === "archived") return;
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
