import { describe, expect, it } from "vitest";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { sha256Text } from "../src/documents/hash";
import { packageRuntime } from "./helpers/package-runtime";

export async function packageFixture() {
  const store = packageRuntime();
  const repository = new DocumentLedgerRepository(store.runtime);
  const members = [];
  for (const [index, relative_path] of ["a.md", "b.md"].entries()) {
    const content = `member ${index}`;
    const content_sha256 = await sha256Text(content);
    const document_id = `DOC-${String(index + 1).repeat(24)}`;
    const document_version_id = `VER-REQ-${String(index + 1).repeat(24)}`;
    const immutable_payload_path = `/PROJECT_OS/.project-os/projects/PRJ-9300/documents/payloads/sha256/${content_sha256}`;
    store.put(immutable_payload_path, content);
    await repository.writeVersion({ schema_version: "1.0", project_id: "PRJ-9300", document_id, version_id: document_version_id, kind: "work_product", stage: "working", logical_path: relative_path, source: "project_os", created_at: "2026-09-12T12:00:00Z", immutable_payload_path, content_sha256, size: content.length });
    members.push({ relative_path, document_id, document_version_id, immutable_payload_path, content_sha256, size: content.length });
  }
  const manifest = { schema_version: "1.0", project_id: "PRJ-9300", creation_request_id: "DOCREQ-PACKAGE-0001", version: 1, members, links: [{ from_relative_path: "a.md", target_relative_path: "b.md" }], source_refs: ["accepted:package"], created_by: "operator", created_at: "2026-09-12T12:00:00Z" };
  return { ...store, repository: repository as any, manifest };
}

describe("frozen document package", () => {
  it("rejects a member colliding with the reserved generated index", async () => {
    const { repository, manifest } = await packageFixture();
    await expect(repository.freezePackage({ ...manifest, members: [{ ...manifest.members[0], relative_path: "index.md" }], links: [] })).rejects.toThrow("package_reserved_member");
  });
  it("reuses DOC/VER identities, canonicalizes member order and keeps immutable per-version content", async () => {
    const { repository, manifest } = await packageFixture();
    const ref = await repository.freezePackage(manifest);
    expect(ref).toMatchObject({ project_id: "PRJ-9300", version: 1 });
    expect(ref.package_id).toMatch(/^PKG-[A-F0-9]{64}$/);
    const read = await repository.readPackage(ref);
    expect(read.members.map((m: any) => m.document_id)).toEqual(["DOC-111111111111111111111111", "DOC-222222222222222222222222"]);
    expect(await repository.freezePackage({ ...manifest, members: [...manifest.members].reverse() })).toEqual(ref);
    await expect(repository.freezePackage({ ...manifest, source_refs: ["changed"] })).rejects.toThrow("package_version_conflict");
  });
  it.each(["missing_version", "wrong_hash", "traversal", "duplicate", "missing_link", "mixed_project"])("rejects incomplete or unsafe frozen manifest: %s", async (failure) => {
    const { repository, manifest } = await packageFixture();
    const candidate: any = structuredClone(manifest);
    if (failure === "missing_version") candidate.members[0].document_version_id = `VER-REQ-${"9".repeat(24)}`;
    if (failure === "wrong_hash") candidate.members[0].content_sha256 = "0".repeat(64);
    if (failure === "traversal") candidate.members[0].relative_path = "../escape";
    if (failure === "duplicate") candidate.members.push(candidate.members[0]);
    if (failure === "missing_link") candidate.links[0].target_relative_path = "missing.md";
    if (failure === "mixed_project") candidate.project_id = "PRJ-9301";
    await expect(repository.freezePackage(candidate)).rejects.toThrow();
  });
  it("same creation identity stays stable across versions; wrong predecessor and skipped versions refuse", async () => {
    const { repository, manifest } = await packageFixture();
    const v1 = await repository.freezePackage(manifest);
    const v2 = await repository.freezePackage({ ...manifest, version: 2, predecessor: v1 });
    expect(v2.package_id).toBe(v1.package_id);
    expect(v2.manifest_sha256).not.toBe(v1.manifest_sha256);
    await expect(repository.freezePackage({ ...manifest, version: 4, predecessor: v1 })).rejects.toThrow();
    await expect(repository.readPackage({ ...v1, manifest_sha256: "0".repeat(64) })).rejects.toThrow("package_manifest_binding");
  });
});
