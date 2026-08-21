import { describe, expect, it } from "vitest";
import { normalizeProjectState } from "../src/domain/project-state-normalizer";

const at = "2026-08-20T18:00:00.000Z";

function legacyState() {
  return {
    schema_version: "1.0",
    project_id: "PRJ-3001",
    name: "Legacy",
    slug: "legacy",
    aliases: [],
    objective: "Legacy project",
    status: "active",
    revision: 7,
    current_phase_id: null,
    constraints: {},
    tasks: {},
    plan_phases: {},
    decisions: {},
    research: {},
    deliverables: {
      "DEL-3001": {
        deliverable_id: "DEL-3001",
        title: "Pending report",
        status: "pending",
        created_at: at,
        updated_at: at
      },
      "DEL-3002": {
        deliverable_id: "DEL-3002",
        title: "Old final",
        status: "completed",
        created_at: at,
        updated_at: at
      }
    },
    last_event_id: "EVT-000007",
    created_at: at,
    updated_at: at
  };
}

describe("project state normalization", () => {
  it("adds empty framing and discovery without changing business revision", () => {
    const normalized = normalizeProjectState(legacyState());

    expect(normalized.revision).toBe(7);
    expect(normalized.last_event_id).toBe("EVT-000007");
    expect(normalized.framing).toEqual({
      scope: [],
      out_of_scope: [],
      success_criteria: [],
      stakeholders: [],
      open_questions: []
    });
    expect(normalized.discovery).toEqual({
      confirmed_findings: [],
      provisional_findings: [],
      unresolved_questions: [],
      next_exploration: []
    });
  });

  it("maps legacy deliverables without inventing acceptance", () => {
    const normalized = normalizeProjectState(legacyState());

    expect(normalized.deliverables["DEL-3001"].status).toBe("planned");
    expect(normalized.deliverables["DEL-3001"].decision_ids).toEqual([]);
    expect(normalized.deliverables["DEL-3002"].status).toBe("legacy_completed");
    expect(normalized.deliverables["DEL-3002"].acceptance_note).toBeUndefined();
    expect(normalized.deliverables["DEL-3002"].accepted_at).toBeUndefined();
  });

  it("is idempotent", () => {
    const once = normalizeProjectState(legacyState());
    const twice = normalizeProjectState(once);
    expect(twice).toEqual(once);
  });

  it("rejects malformed state rather than permissively casting it", () => {
    expect(() => normalizeProjectState({ schema_version: "1.0", project_id: "PRJ-3001" })).toThrow();
  });
});
