import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { renderConstraint } from "../src/render/constraint";
import { renderDeliverable } from "../src/render/deliverable";
import { renderResearch } from "../src/render/research";
import { renderTask } from "../src/render/task";

function state() {
  const project = emptyProjectState("PRJ-0002", "Project OS", "project-os", "Control plane");
  project.revision = 19;
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

  it("renders deliverable status and outcome", () => {
    const markdown = renderDeliverable(state(), {
      deliverable_id: "DEL-PORT0001",
      title: "Portability pack",
      description: "Reconstruction dossier.",
      reference: "GitHub",
      outcome: "Validated",
      status: "completed",
      created_at: "2026-08-21T00:00:00+01:00",
      updated_at: "2026-08-21T00:10:00+01:00"
    });

    expect(markdown).toContain("note_id: DEL-PORT0001");
    expect(markdown).toContain("note_type: deliverable");
    expect(markdown).toContain("Status: completed");
    expect(markdown).toContain("Validated");
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
