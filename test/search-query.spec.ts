import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import type {
  CanonicalSearchRecord,
  CanonicalSnapshotRequest,
  SearchHit,
  SearchQuery
} from "../src/search/contract";
import { compileLexicalQuery } from "../src/search/query-compiler";
import {
  initializeSearchIndexSchema,
  SearchIndexStore
} from "../src/search/sqlite-store";

const searchEnv = env as unknown as Env & { SEARCH_INDEX_GUARD: DurableObjectNamespace };
const searchStub = () => searchEnv.SEARCH_INDEX_GUARD.getByName("global");
const hash = (seed: string) => seed.repeat(64).slice(0, 64);

function canonicalRecord(input: {
  projectId: string;
  entityId: string;
  revision: number;
  title: string;
  body: string;
  status?: string;
  contentHash?: string;
}): CanonicalSearchRecord {
  return {
    project_id: input.projectId,
    record_id: `task:${input.entityId}`,
    record_kind: "canonical_entity",
    entity_type: "task",
    entity_id: input.entityId,
    title: input.title,
    status: input.status ?? "active",
    body_text: input.body,
    content_hash: input.contentHash ?? hash("a"),
    canonical_revision: input.revision,
    authority_ref: {
      kind: "canonical_entity",
      project_id: input.projectId,
      entity_type: "task",
      entity_id: input.entityId,
      canonical_revision: input.revision
    }
  };
}

function canonicalSnapshot(
  projectId: string,
  revision: number,
  snapshotHash: string,
  records: CanonicalSearchRecord[]
): CanonicalSnapshotRequest {
  return {
    project_id: projectId,
    canonical_revision: revision,
    snapshot_hash: snapshotHash,
    records
  };
}

async function withStore<T>(fn: (store: SearchIndexStore) => T | Promise<T>): Promise<T> {
  return runInDurableObject(searchStub(), async (_instance, state) => {
    initializeSearchIndexSchema(state.storage);
    return fn(new SearchIndexStore(state.storage));
  });
}

function query(projectIds: string[], text?: string, extra: Partial<SearchQuery> = {}): SearchQuery {
  return {
    project_ids: projectIds,
    ...(text === undefined ? {} : { text }),
    limit: 20,
    ...extra
  };
}

describe("compileLexicalQuery", () => {
  it.each([
    ["pricing", "\"pricing\""],
    ["pricing strategy", "\"pricing\" AND \"strategy\""],
    ["NEAR(foo bar)", "\"NEAR\" AND \"foo\" AND \"bar\""],
    ["a:b*", "\"a\" AND \"b\""],
    ["   ", null]
  ])("treats %j as bounded lexical data", (input, expected) => {
    expect(compileLexicalQuery(input)).toBe(expected);
  });

  it("does not preserve SQL or FTS operators from injection-shaped text", () => {
    const compiled = compileLexicalQuery("' OR 1=1 --");
    expect(compiled).toBe("\"OR\" AND \"1\" AND \"1\"");
    expect(compiled).not.toContain("'");
    expect(compiled).not.toContain("=");
    expect(compiled).not.toContain("--");
  });

  it("caps lexical terms at 32 and rejects text beyond the contract limit", () => {
    const terms = Array.from({ length: 33 }, (_, index) => `term${index + 1}`).join(" ");
    expect(compileLexicalQuery(terms)?.split(" AND ")).toHaveLength(32);
    expect(() => compileLexicalQuery("x".repeat(513))).toThrow();
  });
});

describe("SearchIndexStore.search", () => {
  it("ranks exact id, exact title, title prefix, then lexical matches deterministically", async () => {
    await withStore((store) => {
      const projectId = "PRJ-7501";
      store.applyCanonical(canonicalSnapshot(projectId, 4, hash("1"), [
        canonicalRecord({
          projectId,
          entityId: "TASK-EXACT7501",
          revision: 4,
          title: "Identity record",
          body: "TASK-EXACT7501 appears in body too",
          contentHash: hash("a")
        }),
        canonicalRecord({
          projectId,
          entityId: "TASK-TITLE7501",
          revision: 4,
          title: "pricing",
          body: "exact title body",
          contentHash: hash("b")
        }),
        canonicalRecord({
          projectId,
          entityId: "TASK-PREFIX7501",
          revision: 4,
          title: "pricing strategy handbook",
          body: "prefix body",
          contentHash: hash("c")
        }),
        canonicalRecord({
          projectId,
          entityId: "TASK-LEX7501",
          revision: 4,
          title: "Operations",
          body: "deep pricing research and analysis",
          contentHash: hash("d")
        })
      ]));

      const byId = store.search(query([projectId], "TASK-EXACT7501"));
      expect(byId[0]).toMatchObject({
        project_id: projectId,
        entity_id: "TASK-EXACT7501",
        match_kind: "exact_id"
      });

      const ranked = store.search(query([projectId], "pricing"));
      expect(ranked.map((hit) => [hit.record_id, hit.match_kind])).toEqual([
        ["task:TASK-TITLE7501", "exact_title"],
        ["task:TASK-PREFIX7501", "title_prefix"],
        ["task:TASK-LEX7501", "lexical"]
      ]);
      expect(ranked.every((hit) => Number.isFinite(hit.score))).toBe(true);
    });
  });

  it("enforces project scope inside candidate selection before ranking", async () => {
    await withStore((store) => {
      const requestedProject = "PRJ-7502";
      const excludedProject = "PRJ-7503";
      store.applyCanonical(canonicalSnapshot(requestedProject, 1, hash("2"), [
        canonicalRecord({
          projectId: requestedProject,
          entityId: "TASK-LOCAL7502",
          revision: 1,
          title: "Local record",
          body: "pricing appears only lexically",
          contentHash: hash("a")
        })
      ]));
      store.applyCanonical(canonicalSnapshot(excludedProject, 1, hash("3"), [
        canonicalRecord({
          projectId: excludedProject,
          entityId: "TASK-FOREIGN7503",
          revision: 1,
          title: "pricing",
          body: "stronger exact title outside requested scope",
          contentHash: hash("b")
        })
      ]));

      const hits = store.search(query([requestedProject], "pricing"));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        project_id: requestedProject,
        record_id: "task:TASK-LOCAL7502",
        match_kind: "lexical"
      });
    });
  });

  it("supports structured filters without lexical text", async () => {
    await withStore((store) => {
      const projectId = "PRJ-7504";
      store.applyCanonical(canonicalSnapshot(projectId, 2, hash("4"), [
        canonicalRecord({
          projectId,
          entityId: "TASK-BLOCKED7504",
          revision: 2,
          title: "Blocked task",
          body: "blocked body",
          status: "blocked",
          contentHash: hash("a")
        }),
        canonicalRecord({
          projectId,
          entityId: "TASK-ACTIVE7504",
          revision: 2,
          title: "Active task",
          body: "active body",
          status: "active",
          contentHash: hash("b")
        })
      ]));

      const hits = store.search(query([projectId], undefined, {
        statuses: ["blocked"],
        entity_types: ["task"],
        record_kinds: ["canonical_entity"]
      }));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        record_id: "task:TASK-BLOCKED7504",
        match_kind: "structured"
      });
      expect(hits[0].snippet).toBeUndefined();
    });
  });

  it("returns bounded lexical snippets and authoritative references", async () => {
    await withStore((store) => {
      const projectId = "PRJ-7505";
      store.applyCanonical(canonicalSnapshot(projectId, 7, hash("5"), [
        canonicalRecord({
          projectId,
          entityId: "TASK-SNIP7505",
          revision: 7,
          title: "Long body",
          body: `${"before ".repeat(35)}pricing ${"after ".repeat(35)}`,
          contentHash: hash("c")
        })
      ]));

      const [hit] = store.search(query([projectId], "pricing"));
      expect(hit.match_kind).toBe("lexical");
      expect(hit.snippet).toContain("pricing");
      expect(hit.snippet!.length).toBeLessThanOrEqual(320);
      expect(hit.authority_ref).toMatchObject({
        kind: "canonical_entity",
        project_id: projectId,
        entity_id: "TASK-SNIP7505",
        canonical_revision: 7
      });
    });
  });
});

describe("SearchIndexGuard /search", () => {
  it("fails closed without explicit scope and returns scoped hits for a valid query", async () => {
    const projectId = "PRJ-7506";
    const apply = await searchStub().fetch("https://search-index.internal/apply-canonical", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(canonicalSnapshot(projectId, 1, hash("6"), [
        canonicalRecord({
          projectId,
          entityId: "TASK-ROUTE7506",
          revision: 1,
          title: "Pricing route",
          body: "route pricing body",
          contentHash: hash("d")
        })
      ]))
    });
    expect(apply.status).toBe(200);

    const invalid = await searchStub().fetch("https://search-index.internal/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "pricing" })
    });
    expect(invalid.status).toBe(400);

    const valid = await searchStub().fetch("https://search-index.internal/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_ids: [projectId], text: "pricing", limit: 20 })
    });
    expect(valid.status).toBe(200);
    const payload = await valid.json<{ hits: SearchHit[] }>();
    expect(payload.hits[0]).toMatchObject({
      project_id: projectId,
      record_id: "task:TASK-ROUTE7506"
    });
  });
});
