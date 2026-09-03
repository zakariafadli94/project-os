import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/domain/project-state";
import type { Env } from "../src/env";
import worker from "../src/index";
import { buildCanonicalSearchRecords } from "../src/search/canonical-records";
import { parseSearchQuery, type ManagedDocumentSearchRecord } from "../src/search/contract";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const authHeaders = {
  authorization: `Bearer ${testEnv.INGRESS_TOKEN}`,
  "content-type": "application/json"
};

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
  afterEach(() => vi.restoreAllMocks());

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

  it("fails closed when SearchIndexGuard is unavailable and never falls back to Dropbox listing", async () => {
    const dropbox = installDropboxMock();
    const create = await worker.fetch(new Request("https://project-os.test/v1/transactions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        schema_version: "1.0",
        transaction_id: "TXN-SEARCH-PROVIDER-NEUTRAL-CREATE-0001",
        project_id: "PRJ-AUTO",
        base_revision: 0,
        operation: "project.create",
        created_at: "2026-09-03T09:00:00+01:00",
        payload: {
          name: "Search Provider Neutral Fixture",
          slug: "search-provider-neutral-fixture",
          aliases: [],
          objective: "Prove fail-closed search outage semantics"
        }
      })
    }), testEnv, createExecutionContext());
    expect(create.status).toBe(200);
    const receipt = await create.json<{ project_id: string; status: string }>();
    expect(receipt.status).toBe("committed");

    dropbox.calls.length = 0;
    vi.spyOn(testEnv.SEARCH_INDEX_GUARD, "getByName").mockReturnValue({
      fetch: vi.fn(async () => Response.json({ error: "search_index_unavailable" }, { status: 503 }))
    } as never);

    const response = await worker.fetch(new Request("https://project-os.test/v1/search", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ project_ids: [receipt.project_id], text: "authority" })
    }), testEnv, createExecutionContext());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "search_unavailable", status: 503 });
    expect(dropbox.calls.some((call) => call.includes("/2/files/list_folder"))).toBe(false);
  });
});
