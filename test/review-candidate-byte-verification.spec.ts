import { expect, it } from "vitest";
import { verifyReviewBytesAtPath } from "../src/artifacts/review-bytes";
import { sha256Text } from "../src/documents/hash";
import type { ReviewCandidateRequest } from "../src/domain/artifact-write";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";

it("revalidates candidate bytes at the frozen provider path before promotion", async () => {
  const content = "%PDF-1.7\nreview candidate\n%%EOF";
  const bytes = new TextEncoder().encode(content);
  const hash = await sha256Text(content);
  const frozenPath = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-review/REVIEW/CANDIDATES/ART-REVIEW-CANDIDATE-0001/example.pdf";
  const reads: string[] = [];
  const runtime = {
    providerId: "dropbox",
    objects: {
      readBytes: async (path: string) => {
        reads.push(path);
        return bytes;
      }
    }
  } as unknown as ProjectOsPersistenceRuntime;
  const request: ReviewCandidateRequest = {
    request_id: "ART-REVIEW-CANDIDATE-0001",
    project_id: "PRJ-0002",
    operation: "REVIEW_CANDIDATE",
    base_revision: 149,
    relative_path: "example.pdf",
    media_type: "application/pdf",
    content_sha256: hash,
    mode: "create",
    source: {
      kind: "staged_provider_object",
      provider_id: "dropbox",
      path: "/PROJECT_OS/.project-os/artifacts/staging/ART-REVIEW-CANDIDATE-0001/example.pdf",
      object_id: "id:source",
      revision_token: "rev-1",
      size: bytes.byteLength,
      integrity: { algorithm: "sha256", value: hash }
    }
  };

  await expect(verifyReviewBytesAtPath(runtime, request, frozenPath)).resolves.toBeUndefined();
  expect(reads).toEqual([frozenPath]);
});
