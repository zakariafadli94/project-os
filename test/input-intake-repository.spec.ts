import { describe, expect, it } from "vitest";
import {
  inputIntakeIdFor,
  parseInputIntakeRecord,
  nextInputIntakeRecord,
  type InputIntakeRecord
} from "../src/documents/input-intake";

describe("durable input intake domain", () => {
  it("derives a stable intake id from project + provider object + provider revision", async () => {
    const first = await inputIntakeIdFor({
      projectId: "PRJ-0002",
      providerId: "dropbox",
      objectId: "id:source-1",
      revisionToken: "rev-001"
    });
    const replay = await inputIntakeIdFor({
      projectId: "PRJ-0002",
      providerId: "dropbox",
      objectId: "id:source-1",
      revisionToken: "rev-001"
    });
    const newerRevision = await inputIntakeIdFor({
      projectId: "PRJ-0002",
      providerId: "dropbox",
      objectId: "id:source-1",
      revisionToken: "rev-002"
    });

    expect(first).toMatch(/^INTAKE-[A-F0-9]{24}$/);
    expect(replay).toBe(first);
    expect(newerRevision).not.toBe(first);
  });

  it("validates portable DETECTED evidence and legal lifecycle transitions", () => {
    const detected: InputIntakeRecord = {
      schema_version: "1.0",
      intake_id: "INTAKE-111111111111111111111111",
      project_id: "PRJ-0002",
      phase: "DETECTED",
      source: {
        provider_id: "dropbox",
        object_id: "id:source-1",
        revision_token: "rev-001",
        integrity_hash: { algorithm: "dropbox-content-hash", value: "a".repeat(64) },
        size: 12,
        provider_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/INPUTS/report.pdf",
        relative_input_path: "report.pdf"
      },
      detected_at: "2026-08-31T11:55:00+01:00",
      updated_at: "2026-08-31T11:55:00+01:00"
    };

    expect(parseInputIntakeRecord(detected)).toEqual(detected);
    const snapshotted = nextInputIntakeRecord(detected, "SNAPSHOTTED", "2026-08-31T11:56:00+01:00");
    expect(snapshotted.phase).toBe("SNAPSHOTTED");
    expect(() => nextInputIntakeRecord(snapshotted, "DETECTED", "2026-08-31T11:57:00+01:00"))
      .toThrow(/transition/i);
  });

  it("treats COMPLETE, DUPLICATE_CLEANED, WITHDRAWN and CONFLICT as terminal", () => {
    const base: InputIntakeRecord = {
      schema_version: "1.0",
      intake_id: "INTAKE-222222222222222222222222",
      project_id: "PRJ-0002",
      phase: "SOURCE_REMOVED",
      source: {
        provider_id: "dropbox",
        object_id: "id:source-2",
        revision_token: "rev-002",
        integrity_hash: { algorithm: "dropbox-content-hash", value: "b".repeat(64) },
        size: 4,
        provider_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/INPUTS/x.txt",
        relative_input_path: "x.txt"
      },
      detected_at: "2026-08-31T11:55:00+01:00",
      updated_at: "2026-08-31T11:56:00+01:00"
    };

    for (const terminal of ["COMPLETE", "DUPLICATE_CLEANED", "WITHDRAWN", "CONFLICT"] as const) {
      const terminalRecord = nextInputIntakeRecord(base, terminal, "2026-08-31T11:57:00+01:00");
      expect(() => nextInputIntakeRecord(terminalRecord, "COMPLETE", "2026-08-31T11:58:00+01:00"))
        .toThrow(/terminal/i);
    }
  });
});
