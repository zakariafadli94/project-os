import { describe, expect, it } from "vitest";
import { parseTransaction } from "../src/domain/transaction";
import { parseProjectKind } from "../src/domain/project-governance";
import { parseProjectGovernanceProfile } from "../src/schema/project-governance";

const at = "2026-08-30T07:45:00+01:00";

describe("project governance domain", () => {
  it("accepts exactly the three new project kinds", () => {
    expect(parseProjectKind("real")).toBe("real");
    expect(parseProjectKind("synthetic_probe")).toBe("synthetic_probe");
    expect(parseProjectKind("synthetic_stress_test")).toBe("synthetic_stress_test");
    expect(() => parseProjectKind("production_probe")).toThrow();
  });

  it("requires an explicit parent or improvement package for synthetic governance profiles", () => {
    expect(() => parseProjectGovernanceProfile({
      schema_version: "1.0",
      project_id: "PRJ-9001",
      project_kind: "synthetic_probe",
      authorization_id: "PCAUTH-AAAAAAAAAAAAAAAAAAAAAAAA",
      created_at: at
    })).toThrow(/parent|package/i);

    expect(parseProjectGovernanceProfile({
      schema_version: "1.0",
      project_id: "PRJ-9001",
      project_kind: "synthetic_probe",
      authorization_id: "PCAUTH-AAAAAAAAAAAAAAAAAAAAAAAA",
      improvement_package_id: "IMP-GOV001",
      created_at: at
    })).toMatchObject({ project_kind: "synthetic_probe", improvement_package_id: "IMP-GOV001" });
  });

  it("keeps historical project.create parseable while accepting optional governance fields", () => {
    expect(parseTransaction({
      schema_version: "1.0",
      transaction_id: "TXN-GOV-LEGACY-0001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name: "Legacy", slug: "legacy", aliases: [], objective: "Historical replay" }
    }).operation).toBe("project.create");

    const governed = parseTransaction({
      schema_version: "1.0",
      transaction_id: "TXN-GOV-CREATE-0001",
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Governed",
        slug: "governed",
        aliases: [],
        objective: "Authorized project",
        authorization_id: "PCAUTH-BBBBBBBBBBBBBBBBBBBBBBBB",
        project_kind: "real"
      }
    });
    expect(governed.payload).toMatchObject({
      authorization_id: "PCAUTH-BBBBBBBBBBBBBBBBBBBBBBBB",
      project_kind: "real"
    });
  });
});
