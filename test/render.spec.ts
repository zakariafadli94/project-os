import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { renderBrief } from "../src/render/brief";
import { renderDecision } from "../src/render/decision";
import { renderDiscovery } from "../src/render/discovery";
import { renderHandoff } from "../src/render/handoff";
import { renderPlan } from "../src/render/plan";
import { renderProject } from "../src/render/project";
import { renderRoadmap } from "../src/render/roadmap";
import { renderState } from "../src/render/state";

function sampleState() {
  const state = emptyProjectState("PRJ-0001", "Agency", "agency", "Launch the agency", ["agence"]);
  state.revision = 7;
  state.framing = {
    scope: ["Design and validate the agency offer"],
    out_of_scope: ["Run client paid media campaigns"],
    success_criteria: ["Offer explicitly validated"],
    stakeholders: ["Owner"],
    open_questions: ["Which niche should be targeted first?"]
  };
  state.discovery = {
    confirmed_findings: [{ summary: "SMBs value execution speed", research_ids: ["RES-CUST0001"] }],
    provisional_findings: [{ summary: "A niche offer may convert better", research_ids: [] }],
    unresolved_questions: ["Preferred pricing model?"],
    next_exploration: ["Test pricing in interviews"]
  };
  state.plan_phases["PHASE-0001"] = {
    phase_id: "PHASE-0001",
    title: "Launch",
    objective: "Go live",
    next_actions: ["Publish offer"],
    status: "active",
    created_at: "2026-08-20T18:00:00.000Z",
    updated_at: "2026-08-20T18:00:00.000Z"
  };
  state.plan_phases["PHASE-0002"] = {
    phase_id: "PHASE-0002",
    title: "Scale",
    objective: "Expand repeatable acquisition",
    next_actions: [],
    status: "pending",
    created_at: "2026-08-20T18:00:00.000Z",
    updated_at: "2026-08-20T18:00:00.000Z"
  };
  state.current_phase_id = "PHASE-0001";
  state.tasks["TASK-0001"] = {
    task_id: "TASK-0001",
    title: "Publish offer",
    status: "active",
    created_at: "2026-08-20T18:00:00.000Z",
    updated_at: "2026-08-20T18:00:00.000Z"
  };
  state.tasks["TASK-0002"] = {
    task_id: "TASK-0002",
    title: "Get approval",
    status: "blocked",
    blocked_reason: "Waiting for client",
    created_at: "2026-08-20T18:00:00.000Z",
    updated_at: "2026-08-20T18:00:00.000Z"
  };
  state.decisions["DEC-ARCH0001"] = {
    decision_id: "DEC-ARCH0001",
    title: "Canonical architecture",
    decision: "Use the guarded architecture.",
    reason: "Deterministic persistence.",
    impacts: ["Project state"],
    status: "accepted",
    created_at: "2026-08-20T18:00:00.000Z",
    updated_at: "2026-08-20T18:00:00.000Z"
  };
  state.research["RES-CUST0001"] = {
    research_id: "RES-CUST0001",
    title: "Customer interviews",
    body: "Interview findings",
    created_at: "2026-08-20T18:00:00.000Z"
  };
  state.research["RES-NOISE0001"] = {
    research_id: "RES-NOISE0001",
    title: "Unpromoted research",
    body: "Useful detail that should not be dumped into Discovery.",
    created_at: "2026-08-20T18:00:00.000Z"
  };
  state.deliverables["DEL-OFFER001"] = {
    deliverable_id: "DEL-OFFER001",
    title: "Validated offer",
    version: "v1",
    decision_ids: [],
    status: "review",
    created_at: "2026-08-20T18:00:00.000Z",
    updated_at: "2026-08-20T18:00:00.000Z"
  };
  return state;
}

describe("Markdown renderers", () => {
  it("renders state with revision, phase, active work, blockers and next actions", () => {
    const output = renderState(sampleState());
    expect(output).toContain("Revision: 7");
    expect(output).toContain("Launch");
    expect(output).toContain("Publish offer");
    expect(output).toContain("Waiting for client");
    expect(output).toContain("## Next actions");
    expect(output).toContain("MACHINE-MANAGED");
  });

  it("adds deterministic project-scoped frontmatter to root views", () => {
    const state = sampleState();
    const project = renderProject(state);
    expect(project).toContain("project_id: PRJ-0001");
    expect(project).toContain("project_slug: agency");
    expect(project).toContain("project_name: Agency");
    expect(project).toContain("note_id: PROJECT");
    expect(project).toContain("note_type: project");
    expect(project).toContain("canonical: true");
    expect(project).toContain("revision: 7");

    expect(renderState(state)).toContain("note_id: STATE");
    expect(renderPlan(state)).toContain("note_id: PLAN");
    expect(renderHandoff(state)).toContain("note_id: HANDOFF");
  });

  it("uses project-scoped decision links and decision frontmatter", () => {
    const state = sampleState();
    const handoff = renderHandoff(state);
    expect(handoff).toContain("[[DECISIONS/DEC-ARCH0001|Canonical architecture]]");
    expect(handoff).not.toContain("[[DEC-ARCH0001]]");

    const decision = renderDecision(state, state.decisions["DEC-ARCH0001"]);
    expect(decision).toContain("project_id: PRJ-0001");
    expect(decision).toContain("note_id: DEC-ARCH0001");
    expect(decision).toContain("note_type: decision");
  });

  it("renders stable project, plan and handoff documents", () => {
    const state = sampleState();
    const project = renderProject(state);
    expect(project).toContain("Launch the agency");
    expect(project).toContain("[[BRIEF|Brief]]");
    expect(project).toContain("[[DISCOVERY|Discovery]]");
    expect(project).toContain("[[ROADMAP|Roadmap]]");
    expect(renderPlan(state)).toContain("PHASE-0001");
    expect(renderHandoff(state)).toContain("PRJ-0001");
  });

  it("renders Brief from canonical framing rather than execution state", () => {
    const brief = renderBrief(sampleState());
    expect(brief).toContain("# Brief — Agency");
    expect(brief).toContain("## Purpose");
    expect(brief).toContain("Launch the agency");
    expect(brief).toContain("## Scope");
    expect(brief).toContain("Design and validate the agency offer");
    expect(brief).toContain("## Out of scope");
    expect(brief).toContain("Run client paid media campaigns");
    expect(brief).toContain("## Stakeholders");
    expect(brief).toContain("Owner");
    expect(brief).toContain("## Success criteria");
    expect(brief).toContain("Offer explicitly validated");
    expect(brief).toContain("## Open questions");
    expect(brief).toContain("Which niche should be targeted first?");
    expect(brief).not.toContain("Launch — Go live");
    expect(brief).not.toContain("[[DELIVERABLES/DEL-OFFER001");
  });

  it("renders Discovery from explicit synthesis without dumping neighboring operational data", () => {
    const discovery = renderDiscovery(sampleState());
    expect(discovery).toContain("# Discovery — Agency");
    expect(discovery).toContain("## Confirmed findings");
    expect(discovery).toContain("SMBs value execution speed");
    expect(discovery).toContain("[[RESEARCH/RES-CUST0001|Customer interviews]]");
    expect(discovery).toContain("## Provisional findings");
    expect(discovery).toContain("A niche offer may convert better");
    expect(discovery).toContain("## Unresolved questions");
    expect(discovery).toContain("Preferred pricing model?");
    expect(discovery).toContain("## Explore next");
    expect(discovery).toContain("Test pricing in interviews");
    expect(discovery).toContain("[[DECISIONS/DEC-ARCH0001|Canonical architecture]]");
    expect(discovery).not.toContain("Unpromoted research");
    expect(discovery).not.toContain("Get approval — Waiting for client");
    expect(discovery).not.toContain("Publish offer");
  });

  it("retains the SOP-aligned roadmap and renders real deliverable lifecycle status without linking registry cards", () => {
    const roadmap = renderRoadmap(sampleState());
    expect(roadmap).toContain("# Roadmap — Agency");
    expect(roadmap).toContain("## Current");
    expect(roadmap).toContain("## Next");
    expect(roadmap).toContain("## Later");
    expect(roadmap).not.toContain("## Now");
    expect(roadmap).toContain("Launch — Go live");
    expect(roadmap).toContain("Get approval — Waiting for client");
    expect(roadmap).toContain("Publish offer");
    expect(roadmap).toContain("Scale — Expand repeatable acquisition");
    expect(roadmap).toContain("Validated offer — review");
    expect(roadmap).not.toContain("[[DELIVERABLES/DEL-OFFER001");
  });

  it("keeps human views explicit for a sparse new project", () => {
    const sparse = emptyProjectState(
      "PRJ-0003",
      "Agence Growth externalisé",
      "agence-growth-externalise",
      "Étudier et valider une agence Growth externalisée"
    );

    const brief = renderBrief(sparse);
    expect(brief).toContain("Scope has not been defined yet.");
    expect(brief).toContain("Success criteria have not been formalized yet.");
    const discovery = renderDiscovery(sparse);
    expect(discovery).toContain("No confirmed findings have been synthesized yet.");
    expect(discovery).toContain("No unresolved discovery questions are currently recorded.");
    expect(renderRoadmap(sparse)).toContain("No roadmap phase has been defined yet.");
    expect(renderRoadmap(sparse)).toContain("## Current");
    expect(renderRoadmap(sparse)).toContain("## Next");
    expect(renderRoadmap(sparse)).toContain("## Later");
  });
});
