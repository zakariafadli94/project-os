export * from "./repository-core";

import type { ArtifactWriteRequest } from "../domain/artifact-write";
import type { ProjectState } from "../domain/project-state";
import { ArtifactMutationIntentService } from "../mutation-gate/artifact-intent";
import { MutationGateRepository } from "../mutation-gate/repository";
import { resolveArtifactDestination, type ResolvedArtifactDestination } from "./artifact-routing";
import type { DropboxTransport } from "./client";
import type { LayoutMode } from "./layout";
import { ProjectRepository as CoreProjectRepository } from "./repository-core";

export class ProjectRepository extends CoreProjectRepository {
  private readonly artifactMutationIntents: ArtifactMutationIntentService;

  constructor(
    private readonly rawTransport: DropboxTransport,
    private readonly repositoryMode: LayoutMode = "legacy"
  ) {
    super(rawTransport, repositoryMode);
    this.artifactMutationIntents = new ArtifactMutationIntentService(new MutationGateRepository(rawTransport));
  }

  override async writeArtifact(
    state: ProjectState,
    request: ArtifactWriteRequest,
    preparedDestination?: ResolvedArtifactDestination
  ): Promise<"written" | "idempotent"> {
    if (this.repositoryMode === "legacy") return super.writeArtifact(state, request);

    const prepared = await this.artifactMutationIntents.prepare(state, request);
    if (preparedDestination && !sameDestination(preparedDestination, prepared.destination)) {
      throw new Error(`Prepared artifact destination does not match durable mutation intent: ${request.request_id}`);
    }
    const replayState = stateForPreparedDestination(state, request, prepared.destination);

    const { LegacyArtifactDocumentWriter } = await import("../documents/legacy-artifact");
    const managed = await new LegacyArtifactDocumentWriter(this.rawTransport).writeIfManaged(replayState, request);
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
            // The durable intent proves the route was authorized when submitted.
            // Replay reconstructs routing only; it does not re-decide current business governance.
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
