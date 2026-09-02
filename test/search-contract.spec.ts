import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../src/search/contract";

describe("search contract", () => {
  it("requires explicit non-empty project scope", () => {
    expect(() => parseSearchQuery({ text: "pricing", project_ids: [] })).toThrow();
    expect(() => parseSearchQuery({ text: "pricing" })).toThrow();
  });

  it("accepts explicit project scope and defaults the result limit", () => {
    expect(parseSearchQuery({ project_ids: ["PRJ-0002"], text: "pricing" })).toMatchObject({
      project_ids: ["PRJ-0002"],
      text: "pricing",
      limit: 20
    });
  });

  it("rejects duplicate, malformed, and oversized project scope", () => {
    expect(() => parseSearchQuery({ project_ids: ["PRJ-0002", "PRJ-0002"] })).toThrow();
    expect(() => parseSearchQuery({ project_ids: ["project-os"] })).toThrow();
    expect(() => parseSearchQuery({
      project_ids: Array.from({ length: 101 }, (_, index) => `PRJ-${String(index + 1).padStart(4, "0")}`)
    })).toThrow();
  });

  it("bounds normal query text and result limits", () => {
    expect(() => parseSearchQuery({ project_ids: ["PRJ-0002"], text: "x".repeat(513) })).toThrow();
    expect(() => parseSearchQuery({ project_ids: ["PRJ-0002"], limit: 0 })).toThrow();
    expect(() => parseSearchQuery({ project_ids: ["PRJ-0002"], limit: 101 })).toThrow();
  });

  it("accepts only unique supported filters", () => {
    const parsed = parseSearchQuery({
      project_ids: ["PRJ-0002"],
      record_kinds: ["canonical_entity", "managed_document"],
      entity_types: ["task", "decision"],
      zones: ["working", "deliverables"],
      statuses: ["active", "accepted"]
    });
    expect(parsed.record_kinds).toEqual(["canonical_entity", "managed_document"]);
    expect(parsed.entity_types).toEqual(["task", "decision"]);
    expect(parsed.zones).toEqual(["working", "deliverables"]);
    expect(parsed.statuses).toEqual(["active", "accepted"]);

    expect(() => parseSearchQuery({
      project_ids: ["PRJ-0002"],
      record_kinds: ["canonical_entity", "canonical_entity"]
    })).toThrow();
    expect(() => parseSearchQuery({
      project_ids: ["PRJ-0002"],
      statuses: Array.from({ length: 33 }, (_, index) => `status-${index}`)
    })).toThrow();
  });
});
