import { describe, expect, it } from "vitest";
import {
  encodeProjectState,
  migrateProjectStateV1ToCurrent,
  readProjectState
} from "../../src/schema/project-state";

const at = "2026-08-28T17:00:00.000Z";

function modernV1() {
  return {
    schema_version: "1.0" as const,
    project_id: "PRJ-9001",
    name: "Schema fixture",
    slug: "schema-fixture",
    aliases: ["schema"],
    objective: "Preserve business truth across schema generations",
    framing: {
      scope: ["compatibility"],
      out_of_scope: ["bulk rewrite"],
      success_criteria: ["same meaning"],
      stakeholders: ["operator"],
      open_questions: []
    },
    discovery: {
      confirmed_findings: [{ summary: "V1 exists", research_ids: ["RES-9001"] }],
      provisional_findings: [],
      unresolved_questions: [],
      next_exploration: []
    },
    status: "active" as const,
    revision: 4,
    current_phase_id: "PHASE-9001",
    artifact_routes: {
      "ROUTE-9001": {
        route_id: "ROUTE-9001",
        source_prefix: "WORKING",
        target_prefix: "DELIVERABLES",
        exclusive: true,
        decision_ids: ["DEC-9001"],
        created_at: at,
        updated_at: at
      }
    },
    constraints: {
      "CON-9001": {
        constraint_id: "CON-9001",
        title: "No rewrite",
        description: "Do not rewrite immutable history",
        created_at: at
      }
    },
    tasks: {
      "TASK-9001": {
        task_id: "TASK-9001",
        title: "Migrate safely",
        phase_id: "PHASE-9001",
        status: "active" as const,
        created_at: at,
        updated_at: at
      }
    },
    plan_phases: {
      "PHASE-9001": {
        phase_id: "PHASE-9001",
        title: "Compatibility",
        objective: "Preserve semantics",
        next_actions: ["verify"],
        status: "active" as const,
        created_at: at,
        updated_at: at
      }
    },
    decisions: {
      "DEC-9001": {
        decision_id: "DEC-9001",
        title: "Use A2",
        decision: "Use selective family evolution",
        reason: "Compatibility",
        impacts: ["mixed generations"],
        status: "accepted" as const,
        created_at: at,
        updated_at: at
      }
    },
    research: {
      "RES-9001": {
        research_id: "RES-9001",
        title: "Compatibility evidence",
        body: "Evidence",
        source: "fixture",
        created_at: at
      }
    },
    deliverables: {
      "DEL-9001": {
        deliverable_id: "DEL-9001",
        title: "Schema plan",
        decision_ids: ["DEC-9001"],
        status: "review" as const,
        created_at: at,
        updated_at: at
      }
    },
    last_event_id: "EVT-000004",
    created_at: at,
    updated_at: at
  };
}

function sparseHistoricalV1() {
  const base = modernV1();
  const first = {
    ...base.deliverables["DEL-9001"],
    status: "pending"
  };
  const second = {
    deliverable_id: "DEL-9002",
    title: "Legacy output",
    status: "completed",
    created_at: at,
    updated_at: at
  };
  const { framing: _framing, discovery: _discovery, artifact_routes: _routes, ...sparse } = base;
  return {
    ...sparse,
    deliverables: {
      "DEL-9001": first,
      "DEL-9002": second
    }
  };
}

describe("ProjectState schema codec", () => {
  it("upcasts sparse historical V1 deterministically without inventing business truth", () => {
    const source = sparseHistoricalV1();
    const first = readProjectState(source);
    const second = migrateProjectStateV1ToCurrent(source);

    expect(first.sourceVersion).toBe("1.0");
    expect(first.state).toEqual(second);
    expect(first.state.framing).toEqual({
      scope: [],
      out_of_scope: [],
      success_criteria: [],
      stakeholders: [],
      open_questions: []
    });
    expect(first.state.discovery.confirmed_findings).toEqual([]);
    expect(first.state.artifact_routes).toEqual({});
    expect(first.state.deliverables["DEL-9001"].status).toBe("planned");
    expect(first.state.deliverables["DEL-9002"].status).toBe("legacy_completed");
    expect(first.state.deliverables["DEL-9002"].decision_ids).toEqual([]);
    expect(first.state.revision).toBe(4);
    expect(first.state.last_event_id).toBe("EVT-000004");
    expect(first.state.created_at).toBe(at);
    expect(first.state.updated_at).toBe(at);
  });

  it("preserves all modern V1 semantic fields exactly", () => {
    const source = modernV1();
    const result = readProjectState(source);
    expect(result.sourceVersion).toBe("1.0");
    expect(result.state).toEqual(source);
  });

  it("reads strict V2 and rejects unknown extra or legacy-only V2 fields", () => {
    const source = modernV1();
    const encoded = encodeProjectState(source, "core_v2") as Record<string, unknown>;
    expect(encoded.schema_version).toBe("2.0");

    const read = readProjectState(encoded);
    expect(read.sourceVersion).toBe("2.0");
    expect(read.state.project_id).toBe(source.project_id);
    expect(read.state.revision).toBe(source.revision);
    expect(read.state.created_at).toBe(source.created_at);

    expect(() => readProjectState({ ...encoded, unexpected: true })).toThrow();
    expect(() =>
      readProjectState({
        ...encoded,
        deliverables: {
          ...(encoded.deliverables as Record<string, unknown>),
          "DEL-9001": {
            ...((encoded.deliverables as Record<string, Record<string, unknown>>)["DEL-9001"]),
            status: "pending"
          }
        }
      })
    ).toThrow();
  });

  it("fails closed for malformed known versions and unknown future versions", () => {
    expect(() => readProjectState({ ...modernV1(), revision: -1 })).toThrow();
    expect(() => readProjectState({ ...modernV1(), schema_version: "3.0" })).toThrow(
      /ProjectState.*3\.0/
    );
    expect(() => readProjectState({ ...modernV1(), schema_version: undefined })).toThrow();
  });

  it("keeps V1 writes at v1_only, emits V2 at core_v2, and forbids down-encoding V2", () => {
    const v1 = readProjectState(modernV1()).state;
    expect((encodeProjectState(v1, "v1_only") as { schema_version: string }).schema_version).toBe("1.0");

    const v2 = encodeProjectState(v1, "core_v2");
    expect((v2 as { schema_version: string }).schema_version).toBe("2.0");

    const currentV2 = readProjectState(v2).state;
    expect(() => encodeProjectState(currentV2, "v1_only")).toThrow(/regression|V2/i);
  });
});
