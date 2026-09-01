import { describe, expect, it } from "vitest";
import type { ProjectState } from "../src/domain/project-state";
import { buildCanonicalSearchRecords } from "../src/search/canonical-records";
import { hashSearchRecords } from "../src/search/hash";

function projectState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    schema_version: "2.0",
    project_id: "PRJ-0002",
    name: "Project OS",
    slug: "project-os",
    aliases: ["os"],
    objective: "Provide reliable project control and retrieval.",
    framing: {
      scope: ["Canonical control plane", "Fast governed retrieval"],
      out_of_scope: ["Provider-native authority"],
      success_criteria: ["Search returns authoritative references"],
      stakeholders: ["Founder"],
      open_questions: ["How far should lexical ranking scale?"]
    },
    discovery: {
      confirmed_findings: [{ summary: "Managed documents have stable identity.", research_ids: ["RES-DOC001"] }],
      provisional_findings: [{ summary: "FTS5 should fit near-term scale.", research_ids: ["RES-INDEX001"] }],
      unresolved_questions: ["When should sharding become necessary?"],
      next_exploration: ["Measure real query latency."]
    },
    status: "archived",
    revision: 42,
    current_phase_id: "PHASE-OPERATE001",
    artifact_routes: {},
    constraints: {
      "CON-INDEX001": {
        constraint_id: "CON-INDEX001",
        title: "Search stays derived",
        description: "The read model can always be rebuilt from durable truth.",
        created_at: "2026-09-01T09:00:00+01:00"
      }
    },
    tasks: {
      "TASK-INDEX001": {
        task_id: "TASK-INDEX001",
        title: "Build search model",
        description: "Implement structured and lexical retrieval.",
        phase_id: "PHASE-OPERATE001",
        status: "blocked",
        blocked_reason: "Awaiting storage proof",
        result: "No result yet",
        created_at: "2026-09-01T09:01:00+01:00",
        updated_at: "2026-09-01T09:02:00+01:00"
      }
    },
    plan_phases: {
      "PHASE-OPERATE001": {
        phase_id: "PHASE-OPERATE001",
        title: "Operate Project OS",
        objective: "Make the control plane usable for daily work.",
        next_actions: ["Implement search", "Prove rebuild"],
        status: "active",
        created_at: "2026-08-20T09:00:00+01:00",
        updated_at: "2026-09-01T09:03:00+01:00"
      }
    },
    decisions: {
      "DEC-INDEX001": {
        decision_id: "DEC-INDEX001",
        title: "Use lexical search first",
        decision: "Use SQLite FTS5 before vector search.",
        reason: "Keep the first search model reconstructible and simple.",
        impacts: ["No embeddings in INDEX001"],
        status: "superseded",
        superseded_by: "DEC-INDEX002",
        superseded_reason: "A later decision refined ranking semantics.",
        created_at: "2026-09-01T09:04:00+01:00",
        updated_at: "2026-09-01T09:05:00+01:00"
      }
    },
    research: {
      "RES-INDEX001": {
        research_id: "RES-INDEX001",
        title: "SQLite search feasibility",
        body: "FTS5 supports the lexical retrieval required by the first release.",
        source: "Cloudflare Durable Objects documentation",
        created_at: "2026-09-01T09:06:00+01:00"
      }
    },
    deliverables: {
      "DEL-INDEX001": {
        deliverable_id: "DEL-INDEX001",
        title: "Search design",
        description: "Approved search architecture.",
        reference: "docs/superpowers/specs/index.md",
        outcome: "Ready for implementation",
        owner: "Project OS",
        version: "1.0",
        phase_id: "PHASE-OPERATE001",
        decision_ids: ["DEC-INDEX001"],
        status: "accepted",
        acceptance_note: "Founder approved",
        accepted_at: "2026-09-01T09:07:00+01:00",
        created_at: "2026-09-01T09:07:00+01:00",
        updated_at: "2026-09-01T09:07:00+01:00"
      }
    },
    last_event_id: "EVT-000042",
    created_at: "2026-08-20T09:00:00+01:00",
    updated_at: "2026-09-01T09:08:00+01:00",
    ...overrides
  };
}

describe("canonical search projection", () => {
  it("creates one deterministic record per current canonical entity with exact logical IDs", async () => {
    const records = await buildCanonicalSearchRecords(projectState());

    expect(records.map((record) => record.record_id)).toEqual([
      "constraint:CON-INDEX001",
      "decision:DEC-INDEX001",
      "deliverable:DEL-INDEX001",
      "phase:PHASE-OPERATE001",
      "project:PRJ-0002",
      "research:RES-INDEX001",
      "task:TASK-INDEX001"
    ]);
    expect(records.every((record) => record.project_id === "PRJ-0002")).toBe(true);
    expect(records.every((record) => record.canonical_revision === 42)).toBe(true);
  });

  it("preserves lifecycle status and authoritative supersession text", async () => {
    const records = await buildCanonicalSearchRecords(projectState());
    const project = records.find((record) => record.record_id === "project:PRJ-0002");
    const task = records.find((record) => record.record_id === "task:TASK-INDEX001");
    const decision = records.find((record) => record.record_id === "decision:DEC-INDEX001");

    expect(project?.status).toBe("archived");
    expect(task?.status).toBe("blocked");
    expect(task?.body_text).toContain("Awaiting storage proof");
    expect(decision?.status).toBe("superseded");
    expect(decision?.body_text).toContain("DEC-INDEX002");
    expect(decision?.body_text).toContain("A later decision refined ranking semantics.");
  });

  it("indexes authoritative research and project framing without generated markdown", async () => {
    const records = await buildCanonicalSearchRecords(projectState());
    const project = records.find((record) => record.record_id === "project:PRJ-0002");
    const research = records.find((record) => record.record_id === "research:RES-INDEX001");

    expect(project?.body_text).toContain("Fast governed retrieval");
    expect(project?.body_text).toContain("Managed documents have stable identity.");
    expect(research?.body_text).toContain("FTS5 supports the lexical retrieval required by the first release.");
    expect(research?.body_text).toContain("Cloudflare Durable Objects documentation");
    expect(records.some((record) => record.body_text.includes("# Current State"))).toBe(false);
  });

  it("keeps record and snapshot hashes deterministic across input ordering", async () => {
    const first = await buildCanonicalSearchRecords(projectState());
    const reordered = projectState({
      aliases: ["os"],
      tasks: { ...projectState().tasks },
      decisions: { ...projectState().decisions }
    });
    const second = await buildCanonicalSearchRecords(reordered);

    expect(second).toEqual(first);
    expect(await hashSearchRecords([...first].reverse())).toBe(await hashSearchRecords(first));
  });

  it("changes semantic content hashes when authoritative searchable text changes", async () => {
    const before = await buildCanonicalSearchRecords(projectState());
    const changedState = projectState();
    changedState.tasks["TASK-INDEX001"] = {
      ...changedState.tasks["TASK-INDEX001"],
      description: "Implement structured, lexical, and provenance-aware retrieval."
    };
    const after = await buildCanonicalSearchRecords(changedState);

    const beforeTask = before.find((record) => record.record_id === "task:TASK-INDEX001");
    const afterTask = after.find((record) => record.record_id === "task:TASK-INDEX001");
    expect(afterTask?.content_hash).not.toBe(beforeTask?.content_hash);
    expect(await hashSearchRecords(after)).not.toBe(await hashSearchRecords(before));
  });
});
