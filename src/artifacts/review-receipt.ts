import type { ArtifactWriteReceipt, ReviewCandidateRequest } from "../domain/artifact-write";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
export function reviewReceiptMatchesObservation(
  input: unknown, request: ReviewCandidateRequest, metadata: ProviderObjectMetadata, providerId: string
): boolean {
  if (!input || typeof input !== "object") return false;
  const receipt = input as Partial<ArtifactWriteReceipt>;
  const observed = receipt.final_observation;
  return receipt.status === "committed" && receipt.operation === "REVIEW_CANDIDATE"
    && receipt.accepted === false && receipt.published === false
    && receipt.request_id === request.request_id && receipt.project_id === request.project_id
    && receipt.relative_path === request.relative_path && receipt.content_sha256 === request.content_sha256
    && observed?.provider_id === providerId && observed.path === metadata.path
    && observed.object_id === metadata.objectId && observed.revision_token === metadata.revisionToken
    && observed.size === metadata.size && metadata.size === request.source.size
    && observed.integrity?.algorithm === metadata.integrityHash?.algorithm
    && observed.integrity?.value === metadata.integrityHash?.value
    && metadata.integrityHash?.algorithm === request.source.integrity.algorithm
    && metadata.integrityHash?.value === request.source.integrity.value;
}
