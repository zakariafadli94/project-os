import { describe, expect, it } from "vitest";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import { ReferralService } from "../src/referrals/service";

const request = {
  schema_version: "1.0" as const,
  referral_id: "REF-GOV-000000000002",
  source_project_id: "PRJ-0003",
  target_project_id: "PRJ-0002",
  referral_type: "improvement_request" as const,
  title: "Governance improvement",
  created_at: "2026-08-30T10:05:00.000Z",
  source_refs: ["PRJ-0003/REVIEW/source.md"],
  body: "Observed improvement request"
};

function runtime() {
  const files = new Map<string, string>();
  const reads: string[] = [];
  const creates: string[] = [];
  const objects = {
    readText: async (path: string) => { reads.push(path); return files.get(path) ?? null; },
    createText: async (path: string, content: string) => {
      if (files.has(path)) throw new Error(`exists ${path}`);
      creates.push(path);
      files.set(path, content);
    },
    upsertText: async (path: string, content: string) => { files.set(path, content); },
    getMetadata: async () => null,
    listChildren: async () => [],
    move: async () => undefined,
    delete: async () => undefined
  };
  const value = {
    providerId: "test",
    objects,
    conditionalWrite: { writeTextConditional: async () => { throw new Error("unused"); } },
    serverSideCopy: { copyObject: async () => { throw new Error("unused"); } },
    changeFeed: { listChanges: async () => ({ entries: [], cursor: "cursor" }) },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" as const },
      revisionToken: { semantics: "opaque-object-revision" as const },
      integrityHash: { semantics: "identified-algorithm" as const }
    }
  } satisfies ProjectOsPersistenceRuntime;
  return { value, files, reads, creates };
}

describe("ReferralService", () => {
  it("resolves only target identity and delivers a non-canonical referral to target INPUTS", async () => {
    const storage = runtime();
    const resolved: string[] = [];
    const service = new ReferralService(storage.value, {
      resolveProject: async (projectId) => {
        resolved.push(projectId);
        return projectId === "PRJ-0002"
          ? { project_id: "PRJ-0002", slug: "project-os", status: "active" as const }
          : null;
      }
    });

    const receipt = await service.deliver(request);

    expect(receipt).toMatchObject({
      status: "delivered",
      referral_id: request.referral_id,
      source_project_id: "PRJ-0003",
      target_project_id: "PRJ-0002"
    });
    expect(resolved).toEqual(["PRJ-0002"]);
    expect(receipt.input_path).toBe("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/INPUTS/REFERRAL-REF-GOV-000000000002.md");
    expect(storage.files.get(receipt.input_path!)).toContain("canonical: false");
    expect(storage.reads.some((path) => /HANDOFF\.md|STATE\.md|PLAN\.md|DECISIONS|RESEARCH/.test(path))).toBe(false);
  });
});
