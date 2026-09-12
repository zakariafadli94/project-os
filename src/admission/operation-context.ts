import type { ArtifactWriteRequest } from "../domain/artifact-write";
import type { ProjectState } from "../domain/project-state";
import { resolveArtifactDestination, ArtifactGovernanceConflictError, type ArtifactDestinationIntent } from "../persistence/artifact-routing";
import { workspaceProjectRoot } from "../persistence/layout";
import { AdmissionError } from "./mutation-context";
import type { ManagedDocumentRequest } from "../domain/managed-document-request";
import { documentIdFor } from "../domain/managed-document";
import type { MutationCandidateResolutionRequest } from "../domain/mutation-candidate-resolution";
import type { Transaction } from "../domain/transaction";
import type { WorkingHeadRequest } from "../domain/working-head-request";
import { sha256Canonical } from "../materialization/hash";
import type { RuleResource } from "../rules/contract";
import { packageResourceVersion } from "../domain/document-package";

export interface NormalizedAdmissionOperation {
  project_id: string;
  operation: string;
  resources: RuleResource[];
  request_hash: string;
}

export async function normalizeTransactionAdmission(request: Transaction): Promise<NormalizedAdmissionOperation> {
  const resourceType = request.operation.split(".")[0] ?? "project";
  return normalized(request.project_id, request.operation, [{ resource_id: request.transaction_id, resource_type: resourceType, zone: "PROJECT", version: String(request.base_revision) }], request);
}

// The destination check needs the typed intent, not source bytes. Production ingress supplies
// the fully parsed request; read-only qualification uses this same boundary without effects.
export type ArtifactAdmissionIntent = ArtifactDestinationIntent & Pick<ArtifactWriteRequest, "relative_path" | "content_sha256">;
export async function normalizeArtifactAdmission(request: ArtifactWriteRequest | ArtifactAdmissionIntent, state: ProjectState): Promise<NormalizedAdmissionOperation> {
  if (state.project_id !== request.project_id) throw new AdmissionError("mutation_context_invalid", 428);
  const root = `${workspaceProjectRoot(state.project_id, state.slug)}/`;
  let destination: string;
  try { destination = resolveArtifactDestination(state, request.relative_path, request).path; }
  catch (error) { if (error instanceof ArtifactGovernanceConflictError) throw new AdmissionError("ARTIFACT_DESTINATION_FORBIDDEN", 409); throw error; }
  if (!destination.startsWith(root)) throw new AdmissionError("ARTIFACT_DESTINATION_FORBIDDEN", 409);
  const zone = destination.slice(root.length).split("/")[0];
  // Keep the logical reference for allowed_destination's independent route
  // validation, but derive rule scope only from this bound server destination.
  return normalized(request.project_id, "artifact.write", [{ resource_id: request.request_id, resource_type: "artifact", zone, version: request.content_sha256, relative_path: request.relative_path, ...("operation" in request && request.operation === "REVIEW_CANDIDATE" ? { artifact_operation: "REVIEW_CANDIDATE" as const } : {}) }], request);
}

export async function normalizeDocumentAdmission(request: ManagedDocumentRequest): Promise<NormalizedAdmissionOperation> {
  if (request.operation === "package.replace") return normalized(request.project_id, request.operation, [{ resource_id: request.candidate.package_id, resource_type: "package", zone: request.zone, version: packageResourceVersion(request.candidate) }], request);
  const operation = request.operation === "publish"
    ? "document.publish"
    : request.operation === "reopen"
      ? "document.reopen"
      : request.operation === "review_candidate.promote"
        ? "review.promote"
        : request.operation;
  const resourceId = "document_id" in request
    ? request.document_id
    : await documentIdFor(request.project_id, request.logical_path);
  const version = "expected_version_id" in request && request.expected_version_id ? request.expected_version_id : request.request_id;
  return normalized(request.project_id, operation, [{ resource_id: resourceId, resource_type: "document", zone: "DOCUMENTS", version, expected_version: "expected_version_id" in request ? request.expected_version_id : undefined, relative_path: "logical_path" in request ? request.logical_path : undefined }], request);
}

export async function normalizeCandidateResolutionAdmission(request: MutationCandidateResolutionRequest): Promise<NormalizedAdmissionOperation> {
  return normalized(request.project_id, "candidate.resolve", [{ resource_id: request.candidate_id, resource_type: "candidate", zone: "MUTATION_GATE", version: request.resolution_id }], request);
}

export async function normalizeWorkingHeadAdmission(request: WorkingHeadRequest): Promise<NormalizedAdmissionOperation> {
  const resourceId = request.operation === "working.supersede" ? request.document_id : request.source_document_id;
  return normalized(request.project_id, request.operation, [{ resource_id: resourceId, resource_type: "document", zone: "WORKING", version: request.content_sha256, expected_version: request.expected_version_id, relative_path: request.new_logical_path }], request);
}

export async function normalizeSystemAdmission(project_id: string, operation: string, zone: string, resource_id: string, version: string, intent: unknown = undefined): Promise<NormalizedAdmissionOperation> {
  return normalized(project_id, operation, [{ resource_id, resource_type: operation.startsWith("input.") ? "input" : "project", zone, version }], { project_id, operation, zone, resource_id, version, intent });
}

async function normalized(project_id: string, operation: string, resources: RuleResource[], request: unknown): Promise<NormalizedAdmissionOperation> {
  return { project_id, operation, resources, request_hash: await sha256Canonical(request) };
}
