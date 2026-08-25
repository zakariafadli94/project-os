import { describe, expect, it } from "vitest";
import { documentIdFor } from "../src/domain/managed-document";
import { emptyProjectState } from "../src/domain/transitions";
import { type DropboxEntry, type DropboxFileMetadata, type DropboxTransport } from "../src/dropbox/client";
import { machineDocumentHeadPath } from "../src/dropbox/layout";
import { MutationGateClassifier } from "../src/mutation-gate/classifier";

class FakeClassifierDropbox implements DropboxTransport {
  readonly files = new Map<string, string>();
  readonly metadata = new Map<string, DropboxFileMetadata>();
  private revision = 0;

  async seed(path: string, content: string, id?: string): Promise<DropboxFileMetadata> {
    this.revision += 1;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const metadata: DropboxFileMetadata = {
      id: id ?? `id:classifier-${this.revision}`,
      path,
      rev: `rev-${this.revision}`,
      content_hash: hash,
      size: new TextEncoder().encode(content).byteLength,
      server_modified: "2026-08-25T16:30:00+01:00"
    };
    this.files.set(path, content);
    this.metadata.set(path, metadata);
    return metadata;
  }

  async upload(path: string, content: string): Promise<void> { this.files.set(path, content); }
  async download(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async move(): Promise<void> { throw new Error("unused"); }
  async getMetadata(path: string): Promise<DropboxFileMetadata | null> { return this.metadata.get(path) ?? null; }
  async listFolder(path: string): Promise<DropboxEntry[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map((candidate) => ({ tag: "file", name: candidate.slice(prefix.length), path_display: candidate }));
  }
}

function state() {
  return emptyProjectState("PRJ-0002", "Project OS", "project-os", "Mutation gate classification");
}

describe("MutationGateClassifier", () => {
  it("leaves collaborative zones outside strict final-zone classification", async () => {
    const transport = new FakeClassifierDropbox();
    const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/WORKING/strategy/draft.md";
    const metadata = await transport.seed(path, "# draft");

    await expect(new MutationGateClassifier(transport).classify(state(), path, metadata))
      .resolves.toEqual({ kind: "not_final_zone" });
  });

  it("classifies an unknown DELIVERABLE as an external candidate", async () => {
    const transport = new FakeClassifierDropbox();
    const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/strategy/direct.md";
    const metadata = await transport.seed(path, "# direct bypass", "id:direct-bypass");

    await expect(new MutationGateClassifier(transport).classify(state(), path, metadata))
      .resolves.toEqual({ kind: "external_candidate" });
  });

  it("recognizes exact existing published provider evidence as governed current", async () => {
    const transport = new FakeClassifierDropbox();
    const logicalPath = "strategy/governed.md";
    const path = `/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/${logicalPath}`;
    const metadata = await transport.seed(path, "# governed", "id:governed-published");
    const documentId = await documentIdFor("PRJ-0002", logicalPath);
    await transport.upload(machineDocumentHeadPath("PRJ-0002", documentId), `${JSON.stringify({
      schema_version: "1.0",
      project_id: "PRJ-0002",
      document_id: documentId,
      kind: "work_product",
      logical_path: logicalPath,
      published_version_id: "VER-EXT-111111111111111111111111",
      provider: {
        published: {
          path,
          file_id: metadata.id,
          rev: metadata.rev,
          content_hash: metadata.content_hash,
          size: metadata.size
        }
      },
      reconciliation_status: "clean"
    }, null, 2)}\n`, "overwrite");

    await expect(new MutationGateClassifier(transport).classify(state(), path, metadata))
      .resolves.toEqual({ kind: "governed_current", documentId });
  });
});
