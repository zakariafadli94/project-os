import { parseArtifactWriteRequest, type ArtifactWriteReceipt } from "../domain/artifact-write";
import type { MutationDetectionSource } from "../domain/mutation-gate";
import type { ProjectState } from "../domain/project-state";
import { ArtifactContentConflictError } from "../persistence/repository-core";
import { sha256Text } from "../documents/hash";
import {
  asProjectOsPersistence,
  toProviderChangeEntry,
  toProviderObjectMetadata,
  type LegacyDropboxChangeEntry,
  type LegacyDropboxFileMetadata,
  type PersistenceInput
} from "../persistence/compatibility/legacy-dropbox-runtime";
import { machineArtifactReceiptPath } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderChangeEntry, ProviderObjectMetadata } from "../persistence/provider/contract";
import type { SchemaWriterStage } from "../schema/writer-stage";
import { MutationGateClassifier } from "./classifier";
import { MutationGateRepository } from "./repository";

export type MutationGateMode = "observe" | "enforce";
export type MutationVerificationState =
  | "submitted"
  | "committed"
  | "canonical_verified"
  | "external_candidate"
  | "conflict"
  | "rejected";

const CANDIDATE_RESOLUTION_CAPABILITY = Symbol("ProjectOSCandidateResolution");

export interface CandidateResolutionContext {
  readonly candidateId: string;
  readonly destinationPath: string;
  readonly [CANDIDATE_RESOLUTION_CAPABILITY]: true;
}

export function createCandidateResolutionContext(candidateId: string, destinationPath: string): CandidateResolutionContext {
  return {
    candidateId,
    destinationPath,
    [CANDIDATE_RESOLUTION_CAPABILITY]: true
  };
}

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
  verification_state: "external_candidate" | "canonical_verified";
  resolution_state: "unresolved" | "resolved";
  resolution_action?: "adopt_as_artifact" | "adopt_as_working" | "reject";
  resolution_id?: string;
}

export interface MutationArtifactStatus {
  request_id: string;
  project_id: string;
  intent_id: string;
  destination_path: string;
  gate_mode: MutationGateMode;
  verification_state: "submitted" | "committed" | "canonical_verified" | "conflict" | "rejected";
  receipt_status?: ArtifactWriteReceipt["status"];
}

export class UnresolvedExternalMutationCandidateError extends ArtifactContentConflictError {
  readonly code = "UNRESOLVED_EXTERNAL_CANDIDATE";

  constructor(
    public readonly destinationPath: string,
    public readonly candidateIds: string[]
  ) {
    super(destinationPath);
    this.name = "UnresolvedExternalMutationCandidateError";
    this.message = `Unresolved external mutation candidate blocks destination: ${destinationPath}`;
  }
}

export function parseMutationGateMode(value: string | undefined): MutationGateMode {
  if (value === undefined || value === "" || value === "observe") return "observe";
  if (value === "enforce") return "enforce";
  throw new Error(`Unsupported PROJECT_OS_MUTATION_GATE_MODE: ${value}`);
}

export class MutationGateService {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly classifier: MutationGateClassifier;
  private readonly repository: MutationGateRepository;

  constructor(
    input: PersistenceInput,
    private readonly mode: MutationGateMode = "observe",
    schemaWriterStage: SchemaWriterStage = "v1_only"
  ) {
    this.runtime = asProjectOsPersistence(input);
    this.classifier = new MutationGateClassifier(this.runtime);
    this.repository = new MutationGateRepository(this.runtime, schemaWriterStage);
  }

  async processChanges(
    state: ProjectState,
    changes: Array<ProviderChangeEntry | LegacyDropboxChangeEntry>,
    detectionSource: MutationDetectionSource
  ): Promise<MutationGateProcessSummary> {
    let candidates = 0;
    for (const changeInput of changes) {
      const change = toProviderChangeEntry(changeInput);
      if (change.kind !== "file") continue;
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
    metadataInput: ProviderObjectMetadata | LegacyDropboxFileMetadata,
    detectionSource: MutationDetectionSource
  ) {
    const metadata = toProviderObjectMetadata(metadataInput);
    return this.repository.captureCandidate({
      projectId: state.project_id,
      detectionSource,
      visiblePath: path,
      metadata,
      detectedAt: metadata.modifiedAt ?? new Date().toISOString()
    });
  }

  async assertDestinationClear(
    state: ProjectState,
    destinationPath: string,
    resolutionContext?: CandidateResolutionContext
  ): Promise<void> {
    if (resolutionContext && resolutionContext.destinationPath !== destinationPath) {
      throw new Error("Candidate resolution capability does not match artifact destination");
    }

    // A missing destination cannot contain an unresolved external mutation. Do
    // not scan historical candidates: that makes every new write grow with the
    // lifetime history of the project and can exhaust a Worker subrequest budget.
    const metadata = await this.runtime.objects.getMetadata(destinationPath);
    if (!metadata) return;

    const classification = await this.classifier.classify(state, destinationPath, metadata);
    if (classification.kind !== "external_candidate") return;

    // The visible provider revision deterministically identifies the only
    // candidate that can block this destination now. Historical candidates at
    // the same path are irrelevant once their provider revision is no longer
    // visible, so inspect only this current candidate.
    const captured = await this.captureExternalCandidate(state, destinationPath, metadata, "incremental");
    const candidateId = captured.record.candidate_id;

    if (resolutionContext) {
      if (resolutionContext.candidateId === candidateId) return;
      throw new Error("Candidate resolution capability does not reference the unresolved destination candidate");
    }

    const terminal = await this.repository.readTerminalResolutionRecord(state.project_id, candidateId);
    if (terminal) return;

    throw new UnresolvedExternalMutationCandidateError(destinationPath, [candidateId]);
  }

  async artifactStatus(projectId: string, requestId: string): Promise<MutationArtifactStatus | null> {
    const intent = await this.repository.readArtifactIntent(projectId, requestId);
    if (!intent) return null;

    const rawReceipt = await this.runtime.objects.readText(machineArtifactReceiptPath(requestId));
    if (rawReceipt === null) {
      return {
        request_id: requestId,
        project_id: projectId,
        intent_id: intent.intent_id,
        destination_path: intent.destination_path,
        gate_mode: this.mode,
        verification_state: "submitted"
      };
    }

    const receipt = parseArtifactReceipt(rawReceipt, intent);
    if (receipt.status !== "committed") {
      return {
        request_id: requestId,
        project_id: projectId,
        intent_id: intent.intent_id,
        destination_path: intent.destination_path,
        gate_mode: this.mode,
        verification_state: receipt.status,
        receipt_status: receipt.status
      };
    }

    const visible = await this.runtime.objects.readText(intent.destination_path);
    const finalEffectVerified = visible !== null
      && await sha256Text(visible) === intent.expected_content_sha256;
    return {
      request_id: requestId,
      project_id: projectId,
      intent_id: intent.intent_id,
      destination_path: intent.destination_path,
      gate_mode: this.mode,
      verification_state: finalEffectVerified ? "canonical_verified" : "committed",
      receipt_status: "committed"
    };
  }

  async listUnresolved(
    projectId: string,
    filter: { destinationPath?: string } = {}
  ): Promise<MutationCandidateStatus[]> {
    const candidates = await this.repository.listCandidates(projectId);
    const result: MutationCandidateStatus[] = [];
    for (const candidate of candidates) {
      if (filter.destinationPath && candidate.provider.path !== filter.destinationPath) continue;
      const terminal = await this.repository.readTerminalResolutionRecord(projectId, candidate.candidate_id);
      if (terminal) continue;
      result.push({
        candidate_id: candidate.candidate_id,
        project_id: candidate.project_id,
        provider_path: candidate.provider.path,
        detection_source: candidate.detection_source,
        detected_at: candidate.detected_at,
        gate_mode: this.mode,
        verification_state: "external_candidate",
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
    const terminal = await this.repository.readTerminalResolutionRecord(projectId, candidateId);
    return {
      candidate_id: candidate.candidate_id,
      project_id: candidate.project_id,
      provider_path: candidate.provider.path,
      detection_source: candidate.detection_source,
      detected_at: candidate.detected_at,
      gate_mode: this.mode,
      verification_state: terminal ? "canonical_verified" : "external_candidate",
      resolution_state: terminal ? "resolved" : "unresolved",
      ...(terminal ? {
        resolution_action: terminal.resolution.action,
        resolution_id: terminal.resolution_id
      } : {})
    };
  }

  private async metadataFor(change: ProviderChangeEntry): Promise<ProviderObjectMetadata | null> {
    if (change.metadata) return change.metadata;
    return this.runtime.objects.getMetadata(change.path);
  }
}

function parseArtifactReceipt(raw: string, intent: Awaited<ReturnType<MutationGateRepository["readArtifactIntent"]>>): ArtifactWriteReceipt {
  if (!intent) throw new Error("Mutation artifact receipt parser requires a durable intent");
  const parsed = JSON.parse(raw) as Partial<ArtifactWriteReceipt>;
  const frozenRequest = parseArtifactWriteRequest(JSON.parse(intent.request_json));
  if (
    frozenRequest.request_id !== intent.request_id
    || frozenRequest.project_id !== intent.project_id
    || frozenRequest.content_sha256 !== intent.expected_content_sha256
    || parsed.request_id !== intent.request_id
    || parsed.project_id !== intent.project_id
    || parsed.content_sha256 !== intent.expected_content_sha256
    || parsed.relative_path !== frozenRequest.relative_path
    || (parsed.status !== "committed" && parsed.status !== "conflict" && parsed.status !== "rejected")
  ) {
    throw new Error(`Artifact receipt does not match durable mutation intent: ${intent.request_id}`);
  }
  return parsed as ArtifactWriteReceipt;
}
