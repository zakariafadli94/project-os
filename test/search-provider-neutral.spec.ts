import { describe, expect, it } from "vitest";
import type { ProjectState } from "../src/domain/project-state";
import { buildCanonicalSearchRecords } from "../src/search/canonical-records";
import { parseSearchQuery, type ManagedDocumentSearchRecord } from "../src/search/contract";

function minimalState(): ProjectState {
  return {
    schema_version: "2.0",
    project_id: "PRJ-0002",
    name: "Project OS",
    slug: "project-os",
    aliases: [],
    objective: "Provider-neutral derived search",
    framing: { scope: [], out_of_scope: [], success_criteria: [], stakeholders: [], open_questions: [] },
    discovery: { confirmed_findings: [], provisional_findings: [], unresolved_questions: [], next_exploration: [] },
    status: "archived",
    revision: 143,
    current_phase_id: null,
    artifact_routes: {},
    constraints: {},
    tasks: {},
    plan_phases: {},
    decisions: {},
    research: {},
    deliverables: {},
    last_event_id: "EVT-000143",
    created_at: "2026-09-03T07:32:00+01:00",
    updated_at: "2026-09-03T07:32:00+01:00"
  };
}

describe("search provider neutrality and authority boundaries", () => {
  it("keeps public canonical identity logical and provider-neutral", async () => {
    const records = await buildCanonicalSearchRecords(minimalState());
    const record = records.find((candidate) => candidate.record_id === "project:PRJ-0002");
    expect(record).toBeDefined();
    expect(record?.authority_ref).toEqual({
      kind: "canonical_entity",
      project_id: "PRJ-0002",
      entity_type: "project",
      entity_id: "PRJ-0002",
      canonical_revision: 143
    });
    expect(JSON.stringify(record)).not.toMatch(/provider[_-]?id|file[_-]?id/i);
  });

  it("requires explicit project scope even for archived-project queries", () => {
    expect(() => parseSearchQuery({ text: "quota", project_ids: [] })).toThrow();
    expect(parseSearchQuery({ text: "quota", project_ids: ["PRJ-0002"] }).project_ids).toEqual(["PRJ-0002"]);
  });

  it("does not manufacture generated Markdown, INPUTS, or MutationGate candidate rows from canonical state", async () => {
    const records = await buildCanonicalSearchRecords(minimalState());
    expect(records.map((record) => record.record_id)).toEqual(["project:PRJ-0002"]);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toMatch(/STATE\.md|HANDOFF\.md|ROADMAP\.md/i);
    expect(serialized).not.toMatch(/INPUTS\//i);
    expect(serialized).not.toMatch(/MUTCAND-|mutation.?gate.?candidate/i);
  });

  it("uses document_id/version_id as managed-document result identity, never provider file ID", () => {
    const record: ManagedDocumentSearchRecord = {
      project_id: "PRJ-0002",
      record_id: "document:DOC-AAAAAAAAAAAAAAAAAAAAAAAA",
      record_kind: "managed_document",
      document_id: "DOC-AAAAAAAAAAAAAAAAAAAAAAAA",
      version_id: "VER-REQ-BBBBBBBBBBBBBBBBBBBBBBBB",
      title: "Search authority",
      logical_path: "notes/search-authority.md",
      zone: "working",
      stage_or_collection: "working",
      reconciliation_status: "clean",
      body_text: "Derived searchable content",
      media_type: "text/markdown",
      content_hash: "a".repeat(64),
      authority_ref: {
        kind: "managed_document",
        project_id: "PRJ-0002",
        document_id: "DOC-AAAAAAAAAAAAAAAAAAAAAAAA",
        version_id: "VER-REQ-BBBBBBBBBBBBBBBBBBBBBBBB",
        logical_path: "notes/search-authority.md",
        content_sha256: "a".repeat(64)
      }
    };

    expect(record.authority_ref).toMatchObject({
      document_id: record.document_id,
      version_id: record.version_id
    });
    expect(JSON.stringify(record)).not.toMatch(/provider[_-]?file[_-]?id/i);
  });
});
