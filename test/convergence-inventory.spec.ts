import { describe, expect, it } from "vitest";
import {
  auditIntegrityInventory,
  type IntegrityInventoryReader,
  type IntegrityInventorySurface
} from "../src/convergence/inventory";

const surfaces: readonly IntegrityInventorySurface[] = [
  "commit",
  "transaction_committed",
  "event",
  "receipt",
  "generation",
  "head"
];

describe("convergence integrity inventory", () => {
  it("keeps an unreadable surface as unknown and exposes the coalesced 263 event and receipt gap", async () => {
    const reads: Array<{ projectId: string; surface: IntegrityInventorySurface }> = [];
    const reader: IntegrityInventoryReader = {
      async listProjects(cursor) {
        return cursor === null
          ? { projectIds: ["PRJ-0001", "PRJ-0003"], cursor: "page-2" }
          : { projectIds: ["PRJ-0007"], cursor: null };
      },
      async read(projectId, surface) {
        reads.push({ projectId, surface });
        if (projectId === "PRJ-0001" && surface === "head") {
          throw new Error("provider_read_timeout");
        }
        if (projectId !== "PRJ-0003") return { state: "current" as const, identity: `${projectId}:${surface}` };
        if (surface === "event" || surface === "receipt") {
          return { state: "missing" as const, identity: `REV-000263:${surface}` };
        }
        if (surface === "generation") {
          return { state: "intentionally_unchanged" as const, identity: "REV-000264:coalesced:263" };
        }
        return { state: "current" as const, identity: `REV-000263:${surface}` };
      }
    };

    const report = await auditIntegrityInventory(reader, { surfaces, pageLimit: 2 });

    expect(report.projects.map((project) => project.project_id)).toEqual(["PRJ-0001", "PRJ-0003", "PRJ-0007"]);
    expect(report.projects.find((project) => project.project_id === "PRJ-0001")?.surfaces.head).toMatchObject({
      state: "unknown",
      code: "provider_read_timeout"
    });
    expect(report.projects.find((project) => project.project_id === "PRJ-0003")?.anomalies).toEqual([
      "missing_event:REV-000263",
      "missing_receipt:REV-000263"
    ]);
    expect(report.projects.find((project) => project.project_id === "PRJ-0003")?.surfaces.generation?.state)
      .toBe("intentionally_unchanged");
    expect(reads).toHaveLength(18);
  });

  it("returns the provider cursor when a bounded audit must resume", async () => {
    const reader: IntegrityInventoryReader = {
      async listProjects() { return { projectIds: ["PRJ-0003"], cursor: "resume-2" }; },
      async read() { return { state: "current" as const, identity: "REV-000263" }; }
    };
    await expect(auditIntegrityInventory(reader, { surfaces: ["event"], pageLimit: 1 }))
      .resolves.toMatchObject({ complete: false, next_cursor: "resume-2" });
  });

  it("starts from a persisted cursor instead of restarting the audit", async () => {
    const seen: Array<string | null> = [];
    const reader: IntegrityInventoryReader = {
      async listProjects(cursor) { seen.push(cursor); return { projectIds: [], cursor: null }; },
      async read() { return { state: "current" as const, identity: "x" }; }
    };
    await auditIntegrityInventory(reader, { surfaces: [], pageLimit: 1, startCursor: "resume-2" });
    expect(seen).toEqual(["resume-2"]);
  });
});
