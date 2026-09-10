import { ProviderBinaryReadLimitError } from "../persistence/provider/errors";
import type { ReviewCandidateRequest } from "../domain/artifact-write";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";

export async function verifyReviewBytes(runtime: ProjectOsPersistenceRuntime, request: ReviewCandidateRequest): Promise<void> {
  return verifyReviewBytesAtPath(runtime, request, request.source.path);
}

export async function verifyReviewBytesAtPath(
  runtime: ProjectOsPersistenceRuntime,
  request: ReviewCandidateRequest,
  path: string
): Promise<void> {
  if (request.source.provider_id !== runtime.providerId) throw new ReviewBinaryValidationError("provider identity mismatch");
  if (!runtime.objects.readBytes) throw new ReviewBinaryValidationError("bounded binary read capability required");
  if (request.source.size < 1 || request.source.size > 10 * 1024 * 1024) throw new ReviewBinaryValidationError("binary size limit");
  let bytes: Uint8Array | null;
  try { bytes = await runtime.objects.readBytes(path, request.source.size); }
  catch (error) {
    if (error instanceof ProviderBinaryReadLimitError) throw new ReviewBinaryValidationError(error.message);
    throw error;
  }
  if (!bytes || bytes.length !== request.source.size) throw new ReviewBinaryValidationError("binary size mismatch");
  const sha = await digest(bytes);
  if (hex(sha) !== request.content_sha256) throw new ReviewBinaryValidationError("content SHA-256 mismatch");
  let providerHash: string;
  if (request.source.integrity.algorithm === "sha256") providerHash = hex(sha);
  else if (request.source.integrity.algorithm === "dropbox-content-hash" && runtime.providerId === "dropbox") {
    const blocks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += 4 * 1024 * 1024) {
      blocks.push(await digest(bytes.subarray(offset, offset + 4 * 1024 * 1024)));
    }
    const hashes = new Uint8Array(blocks.length * 32);
    blocks.forEach((block, i) => hashes.set(block, i * 32));
    providerHash = hex(await digest(hashes));
  } else throw new ReviewBinaryValidationError("unsupported provider integrity algorithm");
  if (providerHash !== request.source.integrity.value) throw new ReviewBinaryValidationError("provider integrity does not match bytes");
  const starts = (...signature: number[]) => signature.every((value, i) => bytes[i] === value);
  const extension = request.relative_path.split(".").at(-1)?.toLowerCase();
  const valid = request.media_type === "application/pdf" ? extension === "pdf" && starts(37, 80, 68, 70, 45)
    : request.media_type === "image/png" ? extension === "png" && starts(137, 80, 78, 71, 13, 10, 26, 10)
    : request.media_type === "image/jpeg" ? (extension === "jpg" || extension === "jpeg") && starts(255, 216, 255)
    : extension === "zip" && (starts(80, 75, 3, 4) || starts(80, 75, 5, 6));
  if (!valid) throw new ReviewBinaryValidationError("binary format signature or extension mismatch");
}
async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}
function hex(bytes: Uint8Array): string { return [...bytes].map(x => x.toString(16).padStart(2, "0")).join(""); }

export class ReviewBinaryValidationError extends Error {}
