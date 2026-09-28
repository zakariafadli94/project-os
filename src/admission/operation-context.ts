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
  dependency_classification?: "resource_bound" | "unknown";
  dependency_resources?: RuleResource[];
}

export async function normalizeTransactionAdmission(request: Transaction): Promise<NormalizedAdmissionOperation> {
  const resourceType = request.operation.split(".")[0] ?? "project";
  const ruleResources = [{ resource_id: request.transaction_id, resource_type: resourceType, zone: "PROJECT", version: String(request.base_revision) }];
  const payload = request.payload as Record<string, unknown>;
  const refs: Array<{ resource_id: string; resource_type: string }> = [];
  const add = (key: string, type: string) => {
    const value = payload[key];
    if (typeof value === "string") refs.push({ resource_id: value, resource_type: type });
  };
  const dependencyClassification: NormalizedAdmissionOperation["dependency_classification"] = "resource_bound";
  switch (request.operation) {
    case "task.create": case "task.start": case "task.complete": case "task.block":
      add("task_id", "task"); add("phase_id", "phase"); break;
    case "plan.phase.create": case "plan.phase.update": case "plan.phase.complete":
      add("phase_id", "phase"); break;
    case "decision.accept": case "decision.supersede":
      add("decision_id", "decision"); add("replacement_decision_id", "decision"); break;
    case "deliverable.create": case "deliverable.add": case "deliverable.start": case "deliverable.revise":
    case "deliverable.submit_review": case "deliverable.accept": case "deliverable.supersede":
    case "deliverable.abandon": case "deliverable.complete":
      add("deliverable_id", "deliverable"); add("replacement_deliverable_id", "deliverable");
      add("phase_id", "phase");
      if (Array.isArray(payload.decision_ids)) for (const id of payload.decision_ids) if (typeof id === "string") refs.push({ resource_id: id, resource_type: "decision" });
      break;
    case "research.add": add("research_id", "research"); break;
    case "constraint.add": add("constraint_id", "constraint"); break;
    case "artifact.route.configure":
      add("route_id", "route");
      if (Array.isArray(payload.decision_ids)) for (const id of payload.decision_ids) if (typeof id === "string") refs.push({ resource_id: id, resource_type: "decision" });
      break;
    case "rule.propose": {
      const rule = payload.rule;
      if (rule && typeof rule === "object" && !Array.isArray(rule)) {
        const item = rule as Record<string, unknown>;
        if (typeof item.rule_id === "string") refs.push({ resource_id: `${item.rule_id}@${String(item.version)}`, resource_type: "rule" });
      }
      break;
    }
    case "rule.accept": case "rule.activate": case "rule.retire":
      if (typeof payload.rule_id === "string" && Number.isSafeInteger(payload.version)) refs.push({ resource_id: `${payload.rule_id}@${String(payload.version)}`, resource_type: "rule" });
      break;
    case "rule.exception.grant": {
      const exception = payload.exception;
      if (exception && typeof exception === "object" && !Array.isArray(exception)) {
        const item = exception as Record<string, unknown>;
        if (typeof item.exception_id === "string") refs.push({ resource_id: item.exception_id, resource_type: "rule_exception" });
        if (typeof item.rule_id === "string" && Number.isSafeInteger(item.rule_version)) refs.push({ resource_id: `${item.rule_id}@${String(item.rule_version)}`, resource_type: "rule" });
      }
      break;
    }
    case "rule.exception.revoke": add("exception_id", "rule_exception"); break;
    default: break;
  }
  const dependency_classification = refs.length > 0 ? dependencyClassification : "unknown";
  const dependency_resources = [...new Map(refs.map((ref) => [`${ref.resource_type}:${ref.resource_id}`, {
    ...ref, zone: "PROJECT", version: String(request.base_revision)
  }])).values()];
  return { ...await normalized(request.project_id, request.operation, ruleResources, request), dependency_classification,
    dependency_resources };
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
  const resources = [{ resource_id: request.request_id, resource_type: "artifact", zone, version: request.content_sha256, relative_path: request.relative_path, ...("operation" in request && request.operation === "REVIEW_CANDIDATE" ? { artifact_operation: "REVIEW_CANDIDATE" as const } : {}) }];
  return { ...await normalized(request.project_id, "artifact.write", resources, request), dependency_classification: "resource_bound", dependency_resources: resources };
}

export async function normalizeDocumentAdmission(request: ManagedDocumentRequest): Promise<NormalizedAdmissionOperation> {
  if (request.operation === "navigation.reconcile") {
    const resources = [{ resource_id: `navigation:${request.zone}`, resource_type: "navigation", zone: request.zone, version: String(request.expected_generation) }];
    return { ...await normalized(request.project_id, request.operation, resources, request), dependency_classification: "resource_bound", dependency_resources: resources };
  }
  if (request.operation === "document.instance.repair") {
    const providerBinding = await sha256Canonical({ historical_provider: request.historical_provider, current_provider: request.current_provider });
    const resources = [{
      resource_id: request.document_id,
      resource_type: "document",
      zone: "WORKING",
      version: `${request.version_id}:${request.expected_source_generation}:${request.expected_version_record_sha256}:${request.content_sha256}:${providerBinding}`,
      expected_version: request.version_id,
      relative_path: request.logical_path
    }];
    return { ...await normalized(request.project_id, request.operation, resources, request), dependency_classification: "resource_bound", dependency_resources: resources };
  }
  if (request.operation === "package.replace") {
    const resources = [{ resource_id: request.candidate.package_id, resource_type: "package", zone: request.zone, version: packageResourceVersion(request.candidate) }];
    return { ...await normalized(request.project_id, request.operation, resources, request), dependency_classification: "resource_bound", dependency_resources: resources };
  }
  if (request.operation === "document.archive") {
    const resources = [{
      resource_id: request.document_id,
      resource_type: "document",
      zone: "ARCHIVES",
      version: request.expected_version_id,
      expected_version: request.expected_version_id
    }];
    return { ...await normalized(request.project_id, request.operation, resources, request), dependency_classification: "resource_bound", dependency_resources: resources };
  }
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
  const resources = [{ resource_id: resourceId, resource_type: "document", zone: "DOCUMENTS", version, expected_version: "expected_version_id" in request ? request.expected_version_id : undefined, relative_path: "logical_path" in request ? request.logical_path : undefined }];
  return { ...await normalized(request.project_id, operation, resources, request), dependency_classification: "resource_bound", dependency_resources: resources };
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
  return { project_id, operation, resources, request_hash: await sha256Canonical(request), dependency_classification: "unknown" };
}
