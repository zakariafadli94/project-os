import { describe, expect, it } from "vitest";
import { machineArtifactStagingPath } from "../src/persistence/layout";

describe("artifact staging layout", () => {
  it("builds a request-owned machine staging path", () => {
    expect(machineArtifactStagingPath("ART-BINARY-000001", "example.pdf")).toBe(
      "/PROJECT_OS/.project-os/artifacts/staging/ART-BINARY-000001/example.pdf"
    );
  });

  it.each(["../example.pdf", "sub/example.pdf", ".hidden", ""])("rejects unsafe file name %s", (name) => {
    expect(() => machineArtifactStagingPath("ART-BINARY-000001", name)).toThrow();
  });
});
