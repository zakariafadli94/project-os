import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { renderConstraint } from "../src/render/constraint";
import { renderDeliverable } from "../src/render/deliverable";
import { renderResearch } from "../src/render/research";
import { renderTask } from "../src/render/task";

function state() {
  const project = emptyProjectState("PRJ-0002", "Project OS", "project-os", "Control plane");
  project.revision = 19;
  project.plan_phases["PHASE-PORT0001"] = {
    phase_id: "PHASE-PORT0001",
    title: "Portability",
    next_actions: [],
    status: "active",
    created_at: "2026-08-21T00:00:00+01:00",
    updated_at: "2026-08-21T00:00:00+01:00"
  };
  project.decisions["DEC-PORT0001"] = {
    decision_id: "DEC-PORT0001",
    title: "Portable method",
    decision: "Keep Markdown portable.",
    reason: "Continuity",
    impacts: [],
    status: "accepted",
    created_at: "2026-08-21T00:00:00+01:00",
    updated_at: "2026-08-21T00:00:00+01:00"
  };
  return project;
}

describe("rich project renderers", () => {
  it("renders research as a project-scoped canonical note", () => {
    const markdown = renderResearch(state(), {
      research_id: "RES-CODE0001",
      title: "Code map",
      body: "Source responsibilities.",
      source: "GitHub main",
      created_at: "2026-08-21T00:00:00+01:00"
    });

    expect(markdown).toContain("note_id: RES-CODE0001");
    expect(markdown).toContain("note_type: research");
    expect(markdown).toContain("# Code map");
    expect(markdown).toContain("Source responsibilities.");
    expect(markdown).toContain("Source: GitHub main");
  });

  it("renders accepted deliverable lifecycle metadata and decision/phase links", () => {
    const markdown = renderDeliverable(state(), {
      deliverable_id: "DEL-PORT0001",
      title: "Portability pack",
      description: "Reconstruction dossier.",
      reference: "GitHub",
      outcome: "Validated",
      owner: "Project OS",
      version: "v2",
      phase_id: "PHASE-PORT0001",
      decision_ids: ["DEC-PORT0001"],
      status: "accepted",
      acceptance_note: "Explicitly accepted by user",
      accepted_at: "2026-08-21T00:09:00+01:00",
      created_at: "2026-08-21T00:00:00+01:00",
      updated_at: "2026-08-21T00:10:00+01:00"
    });

    expect(markdown).toContain("note_id: DEL-PORT0001");
    expect(markdown).toContain("note_type: deliverable");
    expect(markdown).toContain("Status: accepted");
    expect(markdown).toContain("Version: v2");
    expect(markdown).toContain("Owner: Project OS");
    expect(markdown).toContain("[[PLAN|PHASE-PORT0001]]");
    expect(markdown).toContain("[[DECISIONS/DEC-PORT0001|Portable method]]");
    expect(markdown).toContain("Explicitly accepted by user");
    expect(markdown).toContain("2026-08-21T00:09:00+01:00");
    expect(markdown).toContain("Validated");
  });

  it("renders supersession and abandonment history explicitly", () => {
    const superseded = renderDeliverable(state(), {
      deliverable_id: "DEL-PORT0002",
      title: "Old pack",
      version: "v1",
      decision_ids: [],
      status: "superseded",
      superseded_by: "DEL-PORT0003",
      superseded_reason: "New accepted version",
      created_at: "2026-08-21T00:00:00+01:00",
      updated_at: "2026-08-21T00:10:00+01:00"
    });
    expect(superseded).toContain("Superseded by: [[DELIVERABLES/DEL-PORT0003|DEL-PORT0003]]");
    expect(superseded).toContain("New accepted version");

    const abandoned = renderDeliverable(state(), {
      deliverable_id: "DEL-PORT0004",
      title: "Discarded pack",
      version: "draft-1",
      decision_ids: [],
      status: "abandoned",
      abandoned_reason: "No longer needed",
      created_at: "2026-08-21T00:00:00+01:00",
      updated_at: "2026-08-21T00:10:00+01:00"
    });
    expect(abandoned).toContain("Status: abandoned");
    expect(abandoned).toContain("No longer needed");
  });

  it("warns that legacy completed output was not implicitly accepted", () => {
    const markdown = renderDeliverable(state(), {
      deliverable_id: "DEL-LEGACY0001",
      title: "Historical final",
      decision_ids: [],
      status: "legacy_completed",
      created_at: "2026-08-21T00:00:00+01:00",
      updated_at: "2026-08-21T00:10:00+01:00"
    });

    expect(markdown).toContain("Status: legacy_completed");
    expect(markdown).toContain("Acceptance: not inferred");
    expect(markdown).not.toContain("Status: accepted");
  });

  it("renders task status, block reason and result", () => {
    const markdown = renderTask(state(), {
      task_id: "TASK-PORT0001",
      title: "Test portability",
      description: "Run from another platform.",
      status: "blocked",
      blocked_reason: "Waiting for access",
      result: "Previous run incomplete",
      created_at: "2026-08-21T00:00:00+01:00",
      updated_at: "2026-08-21T00:10:00+01:00"
    });

    expect(markdown).toContain("note_id: TASK-PORT0001");
    expect(markdown).toContain("note_type: task");
    expect(markdown).toContain("Status: blocked");
    expect(markdown).toContain("Waiting for access");
    expect(markdown).toContain("Previous run incomplete");
  });

  it("renders binding constraint description", () => {
    const markdown = renderConstraint(state(), {
      constraint_id: "CON-PORT0001",
      title: "Portable",
      description: "Must work without chat history.",
      created_at: "2026-08-21T00:00:00+01:00"
    });

    expect(markdown).toContain("note_id: CON-PORT0001");
    expect(markdown).toContain("note_type: constraint");
    expect(markdown).toContain("# Portable");
    expect(markdown).toContain("Must work without chat history.");
  });
});
