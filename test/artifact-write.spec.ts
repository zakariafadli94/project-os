import { describe, expect, it } from "vitest";
import { parseArtifactWriteRequest } from "../src/domain/artifact-write";
import { workspaceArtifactPath } from "../src/persistence/layout";

const hash = "a".repeat(64);

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    request_id: "ART-GROWTH-000001",
    project_id: "PRJ-0003",
    relative_path: "playbooks/06-acquisition-multicanale.md",
    content: "# Acquisition",
    content_sha256: hash,
    mode: "create",
    ...overrides
  };
}

describe("artifact write request", () => {
  it("accepts a safe nested artifact path", () => {
    expect(parseArtifactWriteRequest(validRequest())).toMatchObject({ project_id: "PRJ-0003", mode: "create" });
    expect(workspaceArtifactPath("PRJ-0003", "agence-growth-externalise", "playbooks/06-acquisition-multicanale.md"))
      .toBe("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-agence-growth-externalise/ARTIFACTS/playbooks/06-acquisition-multicanale.md");
  });

  it.each([
    "../STATE.md",
    "playbooks/../../STATE.md",
    "/absolute.md",
    "playbooks//double.md",
    ".",
    ".."
  ])("rejects unsafe relative path %s", (relativePath) => {
    expect(() => parseArtifactWriteRequest(validRequest({ relative_path: relativePath }))).toThrow();
  });

  it("rejects invalid request identifiers and hashes", () => {
    expect(() => parseArtifactWriteRequest(validRequest({ request_id: "bad" }))).toThrow();
    expect(() => parseArtifactWriteRequest(validRequest({ content_sha256: "abc" }))).toThrow();
  });

  it("rejects unsupported write modes and unknown fields", () => {
    expect(() => parseArtifactWriteRequest(validRequest({ mode: "append" }))).toThrow();
    expect(() => parseArtifactWriteRequest({ ...validRequest(), extra: true })).toThrow();
  });
});
