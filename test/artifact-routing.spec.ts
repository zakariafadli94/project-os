import { describe, expect, it } from "vitest";
import type { ArtifactWriteRequest } from "../src/domain/artifact-write";
import { parseTransaction } from "../src/domain/transaction";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";
import type { DropboxTransport } from "../src/dropbox/client";
import { ProjectRepository } from "../src/dropbox/repository";

class FakeTransport implements DropboxTransport {
  files = new Map<string, string>();
  uploads: string[] = [];
  async upload(path: string, content: string): Promise<void> { this.files.set(path, content); this.uploads.push(path); }
  async download(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async move(): Promise<void> { throw new Error("unused"); }
}

const artifact: ArtifactWriteRequest = {
  request_id: "ART-ROUTING-000001",
  project_id: "PRJ-0003",
  relative_path: "REVENUE-OS/04-playbooks-sectoriels/foo.md",
  content: "# routed",
  content_sha256: "a".repeat(64),
  mode: "create"
};

function configuredState() {
  const state = emptyProjectState("PRJ-0003", "Growth", "growth", "Build growth agency") as any;
  state.decisions["DEC-REVENUESINGLETREE001"] = {
    decision_id: "DEC-REVENUESINGLETREE001", title: "single tree", decision: "single tree", reason: "governance", impacts: [], status: "accepted", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z"
  };
  state.decisions["DEC-REVENUEARCHIVE001"] = {
    decision_id: "DEC-REVENUEARCHIVE001", title: "archive", decision: "archive", reason: "history", impacts: [], status: "accepted", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z"
  };
  state.artifact_routes = {
    "ROUTE-REVENUE001": {
      route_id: "ROUTE-REVENUE001",
      source_prefix: "REVENUE-OS",
      target_prefix: "DELIVERABLES/REVENUE-OS",
      archive_prefix: "ARCHIVES/REVENUE-OS",
      exclusive: true,
      decision_ids: ["DEC-REVENUESINGLETREE001", "DEC-REVENUEARCHIVE001"],
      created_at: "2026-08-23T12:00:00Z",
      updated_at: "2026-08-23T12:00:00Z"
    }
  };
  return state;
}

describe("project artifact routing", () => {
  it("routes a configured domain into its governed business tree instead of ARTIFACTS", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport, "v2");
    await repository.writeArtifact(configuredState(), artifact);
    expect(transport.uploads).toEqual([
      "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/DELIVERABLES/REVENUE-OS/04-playbooks-sectoriels/foo.md"
    ]);
  });

  it("keeps the legacy ARTIFACTS root when no route matches", async () => {
    const transport = new FakeTransport();
    const repository = new ProjectRepository(transport, "v2");
    const state = emptyProjectState("PRJ-0003", "Growth", "growth", "Build growth agency");
    await repository.writeArtifact(state, { ...artifact, relative_path: "OTHER/foo.md" });
    expect(transport.uploads[0]).toBe("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-growth/ARTIFACTS/OTHER/foo.md");
  });

  it("requires accepted decisions before a route can be configured", () => {
    const state = emptyProjectState("PRJ-0003", "Growth", "growth", "Build growth agency");
    const tx = parseTransaction({
      schema_version: "1.0",
      transaction_id: "TXN-ARTROUTE-000001",
      project_id: "PRJ-0003",
      base_revision: 0,
      created_at: "2026-08-23T12:00:00Z",
      operation: "artifact.route.configure",
      payload: {
        route_id: "ROUTE-REVENUE001",
        source_prefix: "REVENUE-OS",
        target_prefix: "DELIVERABLES/REVENUE-OS",
        archive_prefix: "ARCHIVES/REVENUE-OS",
        exclusive: true,
        decision_ids: ["DEC-REVENUESINGLETREE001"]
      }
    } as any);
    const result = applyTransaction(state, tx);
    expect(result).toMatchObject({ kind: "rejected", code: "ARTIFACT_ROUTE_DECISION_NOT_ACCEPTED" });
  });

  it("commits a route only when every governing decision is accepted", () => {
    const state = configuredState();
    state.artifact_routes = {};
    const tx = parseTransaction({
      schema_version: "1.0",
      transaction_id: "TXN-ARTROUTE-000002",
      project_id: "PRJ-0003",
      base_revision: 0,
      created_at: "2026-08-23T12:00:00Z",
      operation: "artifact.route.configure",
      payload: {
        route_id: "ROUTE-REVENUE001",
        source_prefix: "REVENUE-OS",
        target_prefix: "DELIVERABLES/REVENUE-OS",
        archive_prefix: "ARCHIVES/REVENUE-OS",
        exclusive: true,
        decision_ids: ["DEC-REVENUESINGLETREE001", "DEC-REVENUEARCHIVE001"]
      }
    } as any);
    const result = applyTransaction(state, tx);
    expect(result.kind).toBe("commit");
    if (result.kind === "commit") expect((result.state as any).artifact_routes["ROUTE-REVENUE001"].target_prefix).toBe("DELIVERABLES/REVENUE-OS");
  });
});
