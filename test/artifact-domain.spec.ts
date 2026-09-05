import { describe, expect, it } from "vitest";
import {
  isStagedArtifactWriteRequest,
  parseArtifactWriteRequest
} from "../src/domain/artifact-write";

const hash = "a".repeat(64);

function staged(overrides: Record<string, unknown> = {}) {
  return {
    request_id: "ART-BINARY-000001",
    project_id: "PRJ-0003",
    relative_path: "DELIVERY/example.pdf",
    content_sha256: hash,
    source: {
      kind: "staged_provider_object",
      path: "/PROJECT_OS/.project-os/artifacts/staging/ART-BINARY-000001/example.pdf",
      object_id: "id:source",
      revision_token: "rev-1",
      size: 123,
      integrity: { algorithm: "dropbox-content-hash", value: "provider-hash" }
    },
    mode: "create",
    ...overrides
  };
}

describe("artifact request domain", () => {
  it("parses staged provider objects without changing inline requests", () => {
    const request = parseArtifactWriteRequest(staged());
    expect(isStagedArtifactWriteRequest(request)).toBe(true);

    const inline = parseArtifactWriteRequest({
      request_id: "ART-INLINE-000001",
      project_id: "PRJ-0003",
      relative_path: "example.md",
      content: "# Example",
      content_sha256: hash,
      mode: "create"
    });
    expect(isStagedArtifactWriteRequest(inline)).toBe(false);
  });

  it.each([
    ["mixed payload", staged({ content: "not allowed" })],
    ["wrong request path", staged({ source: { ...staged().source, path: "/PROJECT_OS/.project-os/artifacts/staging/ART-BINARY-999999/example.pdf" } })],
    ["nested filename", staged({ source: { ...staged().source, path: "/PROJECT_OS/.project-os/artifacts/staging/ART-BINARY-000001/sub/example.pdf" } })],
    ["negative size", staged({ source: { ...staged().source, size: -1 } })],
    ["empty integrity", staged({ source: { ...staged().source, integrity: { algorithm: "", value: "" } } })]
  ])("rejects %s", (_label, value) => {
    expect(() => parseArtifactWriteRequest(value)).toThrow();
  });
});
