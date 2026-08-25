import type { MutationDetectionSource } from "../domain/mutation-gate";
import type { ProjectState } from "../domain/project-state";
import type { DropboxChangeEntry, DropboxFileMetadata, DropboxTransport } from "../dropbox/client";
import { ResilientDropboxTransport } from "../dropbox/resilient-transport";
import { MutationGateClassifier } from "./classifier";
import { MutationGateRepository } from "./repository";

export type MutationGateMode = "observe" | "enforce";

export interface MutationGateProcessSummary {
  candidates: number;
  mutation_gate_mode: MutationGateMode;
  policy_violations: number;
  last_candidate_detection_source?: MutationDetectionSource;
}

export interface MutationCandidateStatus {
  candidate_id: string;
  project_id: string;
  provider_path: string;
  detection_source: MutationDetectionSource;
  detected_at: string;
  gate_mode: MutationGateMode;
  resolution_state: "unresolved" | "resolved";
  resolution_action?: "adopt_as_artifact" | "adopt_as_working" | "reject";
  resolution_id?: string;
}

export class UnresolvedExternalMutationCandidateError extends Error {
  readonly code = "UNRESOLVED_EXTERNAL_CANDIDATE";

  constructor(
    public readonly destinationPath: string,
    public readonly candidateIds: string[]
  ) {
    super(`Unresolved external mutation candidate blocks destination: ${destinationPath}`);
    this.name = "UnresolvedExternalMutationCandidateError";
  }
}

export function parseMutationGateMode(value: string | undefined): MutationGateMode {
  if (value === undefined || value === "" || value === "observe") return "observe";
  if (value === "enforce") return "enforce";
  throw new Error(`Unsupported PROJECT_OS_MUTATION_GATE_MODE: ${value}`);
}

export class MutationGateService {
  private readonly transport: ResilientDropboxTransport;
  private readonly classifier: MutationGateClassifier;
  private readonly repository: MutationGateRepository;

  constructor(
    transport: DropboxTransport,
    private readonly mode: MutationGateMode = "observe"
  ) {
    this.transport = new ResilientDropboxTransport(transport);
    this.classifier = new MutationGateClassifier(transport);
    this.repository = new MutationGateRepository(transport);
  }

  async processChanges(
    state: ProjectState,
    changes: DropboxChangeEntry[],
    detectionSource: MutationDetectionSource
  ): Promise<MutationGateProcessSummary> {
    let candidates = 0;
    for (const change of changes) {
      if (change.tag !== "file") continue;
      const metadata = await this.metadataFor(change);
      if (!metadata) continue;
      const classification = await this.classifier.classify(state, change.path, metadata);
      if (classification.kind !== "external_candidate") continue;
      await this.captureExternalCandidate(state, change.path, metadata, detectionSource);
      candidates += 1;
    }
    return {
      candidates,
      mutation_gate_mode: this.mode,
      policy_violations: this.mode === "enforce" ? candidates : 0,
      ...(candidates > 0 ? { last_candidate_detection_source: detectionSource } : {})
    };
  }

  async captureExternalCandidate(
    state: ProjectState,
    path: string,
    metadata: DropboxFileMetadata,
    detectionSource: MutationDetectionSource
  ) {
    return this.repository.captureCandidate({
      projectId: state.project_id,
      detectionSource,
      visiblePath: path,
      metadata,
      detectedAt: metadata.server_modified ?? new Date().toISOString()
    });
  }

  async assertDestinationClear(state: ProjectState, destinationPath: string): Promise<void> {
    const metadata = await this.transport.getMetadata(destinationPath);
    if (metadata) {
      const classification = await this.classifier.classify(state, destinationPath, metadata);
      if (classification.kind === "external_candidate") {
        await this.captureExternalCandidate(state, destinationPath, metadata, "incremental");
      }
    }

    const unresolved = await this.listUnresolved(state.project_id, { destinationPath });
    if (unresolved.length > 0) {
      throw new UnresolvedExternalMutationCandidateError(
        destinationPath,
        unresolved.map((item) => item.candidate_id)
      );
    }
  }

  async listUnresolved(
    projectId: string,
    filter: { destinationPath?: string } = {}
  ): Promise<MutationCandidateStatus[]> {
    const candidates = await this.repository.listCandidates(projectId);
    const result: MutationCandidateStatus[] = [];
    for (const candidate of candidates) {
      if (filter.destinationPath && candidate.provider_path !== filter.destinationPath) continue;
      const resolutions = await this.repository.readResolutions(projectId, candidate.candidate_id);
      if (resolutions.length > 0) continue;
      result.push({
        candidate_id: candidate.candidate_id,
        project_id: candidate.project_id,
        provider_path: candidate.provider_path,
        detection_source: candidate.detection_source,
        detected_at: candidate.detected_at,
        gate_mode: this.mode,
        resolution_state: "unresolved"
      });
    }
    return result;
  }

  async list(projectId: string): Promise<MutationCandidateStatus[]> {
    const candidates = await this.repository.listCandidates(projectId);
    return Promise.all(candidates.map((candidate) => this.status(projectId, candidate.candidate_id))).then((items) =>
      items.filter((item): item is MutationCandidateStatus => item !== null)
    );
  }

  async status(projectId: string, candidateId: string): Promise<MutationCandidateStatus | null> {
    const candidate = await this.repository.readCandidate(projectId, candidateId);
    if (!candidate) return null;
    const resolutions = await this.repository.readResolutions(projectId, candidateId);
    const terminal = resolutions.at(-1);
    return {
      candidate_id: candidate.candidate_id,
      project_id: candidate.project_id,
      provider_path: candidate.provider_path,
      detection_source: candidate.detection_source,
      detected_at: candidate.detected_at,
      gate_mode: this.mode,
      resolution_state: terminal ? "resolved" : "unresolved",
      ...(terminal ? {
        resolution_action: terminal.action,
        resolution_id: terminal.resolution_id
      } : {})
    };
  }

  private async metadataFor(change: DropboxChangeEntry): Promise<DropboxFileMetadata | null> {
    if (change.id && change.rev && change.content_hash && change.size !== undefined) {
      return {
        id: change.id,
        path: change.path,
        rev: change.rev,
        content_hash: change.content_hash,
        size: change.size,
        ...(change.server_modified ? { server_modified: change.server_modified } : {})
      };
    }
    return this.transport.getMetadata(change.path);
  }
}
