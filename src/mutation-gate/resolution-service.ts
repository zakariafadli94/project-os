import type { ArtifactWriteReceipt } from "../domain/artifact-write";
import { documentIdFor } from "../domain/managed-document";
import type {
  MutationCandidateAdoptArtifactRequest,
  MutationCandidateAdoptWorkingRequest,
  MutationCandidateResolutionRequest
} from "../domain/mutation-candidate-resolution";
import type { ExternalMutationResolutionRecord } from "../domain/mutation-gate";
import type { ProjectState } from "../domain/project-state";
import { resolveArtifactDestination } from "../dropbox/artifact-routing";
import type { DropboxTransport } from "../dropbox/client";
import { sha256Text } from "../documents/hash";
import { MutationGateRepository } from "./repository";

export interface CandidateResolutionDownstreamReceipt {
  status: "committed" | "conflict" | "rejected";
  request_id?: string;
  document_id?: string;
  code?: string;
  message?: string;
}

export interface MutationCandidateResolutionReceipt {
  resolution_id: string;
  project_id: string;
  candidate_id: string;
  action: "adopt_as_artifact" | "adopt_as_working" | "reject";
  status: "committed" | "conflict" | "rejected";
  downstream_request_id?: string;
  document_id?: string;
  code?: string;
  message?: string;
}

export interface MutationCandidateResolutionExecutors {
  artifact(
    request: MutationCandidateAdoptArtifactRequest,
    state: ProjectState,
    candidatePath: string
  ): Promise<ArtifactWriteReceipt>;
  working(
    request: MutationCandidateAdoptWorkingRequest,
    state: ProjectState
  ): Promise<CandidateResolutionDownstreamReceipt>;
}

export class MutationCandidateResolutionService {
  private readonly repository: MutationGateRepository;

  constructor(transport: DropboxTransport) {
    this.repository = new MutationGateRepository(transport);
  }

  async resolve(
    request: MutationCandidateResolutionRequest,
    state: ProjectState,
    executors: MutationCandidateResolutionExecutors
  ): Promise<MutationCandidateResolutionReceipt> {
    if (request.project_id !== state.project_id) {
      return terminal(request, "rejected", "PROJECT_BINDING_MISMATCH", "Candidate resolution project does not match project state");
    }

    const candidate = await this.repository.readCandidate(request.project_id, request.candidate_id);
    if (!candidate) {
      return terminal(request, "rejected", "CANDIDATE_NOT_FOUND", "Mutation candidate does not exist");
    }

    const resolutions = await this.repository.readResolutions(request.project_id, request.candidate_id);
    const existing = resolutions.at(-1);
    if (existing) {
      if (existing.resolution_id === request.resolution_id && existing.action === actionFor(request)) {
        const replay = receiptFromRecord(existing);
        if (request.operation === "candidate.adopt_working") {
          if (request.document_request.operation !== "working.write") {
            throw new Error("Parsed candidate working adoption violated working.write invariant");
          }
          return {
            ...replay,
            document_id: await documentIdFor(request.project_id, request.document_request.logical_path)
          };
        }
        return replay;
      }
      return terminal(request, "conflict", "CANDIDATE_ALREADY_RESOLVED", "Mutation candidate already has a terminal resolution");
    }

    if (request.operation === "candidate.reject") {
      const record = await this.repository.writeResolution({
        schema_version: "1.0",
        resolution_id: request.resolution_id,
        project_id: request.project_id,
        candidate_id: request.candidate_id,
        action: "reject",
        resolved_at: new Date().toISOString()
      });
      return receiptFromRecord(record);
    }

    const payload = await this.repository.readCandidatePayload(request.project_id, request.candidate_id);
    if (payload === null) {
      return terminal(request, "rejected", "CANDIDATE_PAYLOAD_MISSING", "Immutable mutation candidate payload is missing");
    }
    if (!safeTextPayload(payload)) {
      return terminal(request, "rejected", "CANDIDATE_CONTENT_UNSUPPORTED", "Mutation candidate payload is not supported by the current text adoption API");
    }

    let nestedContent: string;
    let nestedSha: string;
    if (request.operation === "candidate.adopt_artifact") {
      nestedContent = request.artifact_request.content;
      nestedSha = request.artifact_request.content_sha256;
    } else {
      if (request.document_request.operation !== "working.write") {
        throw new Error("Parsed candidate working adoption violated working.write invariant");
      }
      nestedContent = request.document_request.content;
      nestedSha = request.document_request.content_sha256;
    }

    const payloadSha = await sha256Text(payload);
    if (nestedContent !== payload || nestedSha !== payloadSha) {
      return terminal(request, "conflict", "CANDIDATE_CONTENT_MISMATCH", "Nested governed request does not exactly match immutable candidate content");
    }

    let downstream: CandidateResolutionDownstreamReceipt;
    if (request.operation === "candidate.adopt_artifact") {
      const destination = resolveArtifactDestination(state, request.artifact_request.relative_path);
      if (destination.path !== candidate.provider_path) {
        return terminal(request, "conflict", "CANDIDATE_DESTINATION_MISMATCH", "Artifact adoption destination does not match candidate provider path");
      }
      downstream = await executors.artifact(request, state, candidate.provider_path);
    } else {
      downstream = await executors.working(request, state);
    }

    if (downstream.status !== "committed") {
      return {
        ...terminal(
          request,
          downstream.status,
          downstream.code ?? "DOWNSTREAM_NOT_COMMITTED",
          downstream.message ?? "Governed downstream request did not commit"
        ),
        ...(downstream.request_id ? { downstream_request_id: downstream.request_id } : {}),
        ...(downstream.document_id ? { document_id: downstream.document_id } : {})
      };
    }

    const downstreamId = downstream.request_id ?? downstreamRequestId(request);
    const record = await this.repository.writeResolution({
      schema_version: "1.0",
      resolution_id: request.resolution_id,
      project_id: request.project_id,
      candidate_id: request.candidate_id,
      action: actionFor(request),
      ...(downstreamId ? { downstream_request_id: downstreamId } : {}),
      downstream_receipt_status: "committed",
      resolved_at: new Date().toISOString()
    });

    return {
      ...receiptFromRecord(record),
      ...(downstream.document_id ? { document_id: downstream.document_id } : {})
    };
  }
}

function actionFor(
  request: MutationCandidateResolutionRequest
): ExternalMutationResolutionRecord["action"] {
  if (request.operation === "candidate.adopt_artifact") return "adopt_as_artifact";
  if (request.operation === "candidate.adopt_working") return "adopt_as_working";
  return "reject";
}

function downstreamRequestId(request: MutationCandidateResolutionRequest): string | undefined {
  if (request.operation === "candidate.adopt_artifact") return request.artifact_request.request_id;
  if (request.operation === "candidate.adopt_working") return request.document_request.request_id;
  return undefined;
}

function terminal(
  request: MutationCandidateResolutionRequest,
  status: MutationCandidateResolutionReceipt["status"],
  code: string,
  message: string
): MutationCandidateResolutionReceipt {
  return {
    resolution_id: request.resolution_id,
    project_id: request.project_id,
    candidate_id: request.candidate_id,
    action: actionFor(request),
    status,
    code,
    message
  };
}

function receiptFromRecord(record: ExternalMutationResolutionRecord): MutationCandidateResolutionReceipt {
  return {
    resolution_id: record.resolution_id,
    project_id: record.project_id,
    candidate_id: record.candidate_id,
    action: record.action,
    status: "committed",
    ...(record.downstream_request_id ? { downstream_request_id: record.downstream_request_id } : {})
  };
}

function safeTextPayload(value: string): boolean {
  if (value.includes("\u0000") || value.includes("\uFFFD")) return false;
  return !/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}
