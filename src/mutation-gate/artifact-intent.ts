import type { ArtifactWriteRequest } from "../domain/artifact-write";
import {
  mutationIntentIdFor,
  type MutationIntentRecord,
  type MutationProviderPrecondition
} from "../domain/mutation-gate";
import type { ProjectState } from "../domain/project-state";
import {
  resolveArtifactDestination,
  type ResolvedArtifactDestination
} from "../persistence/artifact-routing";
import { requireDropboxV1Evidence } from "../persistence/compatibility/dropbox-v1-evidence";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import {
  asProjectOsPersistence,
  type PersistenceInput
} from "../persistence/provider/runtime";
import { sha256Text } from "../documents/hash";
import { MutationGateRepository, MutationIntentConflictError } from "./repository";

export interface PreparedArtifactMutation {
  intent: MutationIntentRecord;
  destination: ResolvedArtifactDestination;
}

export class ArtifactMutationIntentService {
  private readonly runtime: ProjectOsPersistenceRuntime;

  constructor(
    private readonly repository: MutationGateRepository,
    input: PersistenceInput
  ) {
    this.runtime = asProjectOsPersistence(input);
  }

  async prepare(state: ProjectState, request: ArtifactWriteRequest): Promise<PreparedArtifactMutation> {
    if (state.project_id !== request.project_id) {
      throw new Error("Artifact mutation intent project binding mismatch");
    }
    const requestJson = JSON.stringify(request);
    const requestSha256 = await sha256Text(requestJson);
    const existing = await this.repository.readArtifactIntent(request.project_id, request.request_id);
    if (existing) {
      if (
        existing.request_sha256 !== requestSha256
        || existing.request_json !== requestJson
        || existing.expected_content_sha256 !== request.content_sha256
        || existing.mode !== request.mode
      ) {
        throw new MutationIntentConflictError(request.request_id);
      }
      return { intent: existing, destination: destinationFromIntent(existing) };
    }

    const destination = resolveArtifactDestination(state, request.relative_path);
    const providerPrecondition = await this.providerPrecondition(destination.path);
    const intent: MutationIntentRecord = {
      schema_version: "1.0",
      intent_id: await mutationIntentIdFor(request.project_id, request.request_id),
      project_id: request.project_id,
      kind: "artifact",
      request_id: request.request_id,
      request_sha256: requestSha256,
      request_json: requestJson,
      base_project_revision: state.revision,
      destination_path: destination.path,
      ...(destination.archive_path ? { archive_path: destination.archive_path } : {}),
      ...(destination.route ? {
        route_id: destination.route.route_id,
        route_snapshot: {
          route_id: destination.route.route_id,
          source_prefix: destination.route.source_prefix,
          target_prefix: destination.route.target_prefix,
          ...(destination.route.archive_prefix ? { archive_prefix: destination.route.archive_prefix } : {}),
          exclusive: destination.route.exclusive,
          decision_ids: [...destination.route.decision_ids],
          created_at: destination.route.created_at,
          updated_at: destination.route.updated_at
        }
      } : {}),
      provider_precondition: providerPrecondition,
      expected_content_sha256: request.content_sha256,
      mode: request.mode,
      recorded_at: new Date().toISOString()
    };
    const persisted = await this.repository.ensureArtifactIntent(intent);
    return { intent: persisted, destination: destinationFromIntent(persisted) };
  }

  private async providerPrecondition(path: string): Promise<MutationProviderPrecondition> {
    const metadata = await this.runtime.objects.getMetadata(path);
    if (!metadata) return { kind: "absent" };
    const evidence = requireDropboxV1Evidence(metadata);
    return {
      kind: "existing",
      file_id: evidence.file_id,
      rev: evidence.rev,
      content_hash: evidence.content_hash,
      size: evidence.size
    };
  }
}

export function destinationFromIntent(intent: MutationIntentRecord): ResolvedArtifactDestination {
  return {
    path: intent.destination_path,
    ...(intent.archive_path ? { archive_path: intent.archive_path } : {}),
    ...(intent.route_snapshot ? {
      route: {
        route_id: intent.route_snapshot.route_id,
        source_prefix: intent.route_snapshot.source_prefix,
        target_prefix: intent.route_snapshot.target_prefix,
        ...(intent.route_snapshot.archive_prefix ? { archive_prefix: intent.route_snapshot.archive_prefix } : {}),
        exclusive: intent.route_snapshot.exclusive,
        decision_ids: [...intent.route_snapshot.decision_ids],
        created_at: intent.route_snapshot.created_at,
        updated_at: intent.route_snapshot.updated_at
      }
    } : {})
  };
}