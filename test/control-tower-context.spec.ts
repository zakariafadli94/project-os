import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createControlTowerServer } from "../src/control-tower/mcp";
import { summarizeCanonicalContext } from "../src/control-tower/context";

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };
type RegisteredServer = { _registeredTools: Record<string, { handler: (input: unknown) => Promise<ToolResult> }> };

function contextServer(state: Record<string, unknown>) {
  const stub = { fetch: async () => Response.json({
    context: { project_id: "PRJ-0007", canonical_revision: 76, token: "signed" },
    canonical_state: state
  }) };
  return createControlTowerServer({
    PROJECT_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace,
    REGISTRY_GUARD: { getByName: () => stub } as unknown as DurableObjectNamespace
  }) as unknown as RegisteredServer;
}

function parse(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content[0]!.text);
}

function mutateCursor(token: string, update: Record<string, unknown>): string {
  const padded = token.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(token.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  const cursor = { ...JSON.parse(new TextDecoder().decode(bytes)), ...update };
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(cursor))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

describe("Control Tower canonical context", () => {
  beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(() => vi.restoreAllMocks());

  it("keeps the UTF-8 summary bounded and exposes reversible detail references", async () => {
    const state = {
      project_id: "PRJ-0007", name: "Projet été 🧭", slug: "ete", status: "active", revision: 76,
      objective: "objectif é🧭".repeat(100), current_phase_id: "PHASE-CURRENT",
      plan_phases: { "PHASE-CURRENT": {
        phase_id: "PHASE-CURRENT", title: "Étape 🧭".repeat(2_000), status: "active",
        objective: "phase 🧭é".repeat(1_000), next_actions: ["action 🧭é".repeat(100)]
      } },
      tasks: Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => {
        const taskId = `TASK-${String(index + 1).padStart(4, "0")}`;
        return [taskId, { task_id: taskId, title: index === 0 ? `Tâche 🧭 ${index} `.repeat(2_000) : `Tâche ${index}`, status: "in_progress" }];
      }))
    };
    const input = { context: { project_id: "PRJ-0007", canonical_revision: 76, token: "signed" }, canonical_state: state };
    const result = summarizeCanonicalContext(input, "PRJ-0007");
    const body = result.value! as Record<string, any>;
    const serialized = JSON.stringify(body);

    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(24 * 1024);
    expect(body.serialized_bytes).toBe(new TextEncoder().encode(serialized).byteLength);
    expect(body).toMatchObject({ status: "ok", revision: 76, active_tasks_total: 1_000 });
    expect(body.active_tasks.length).toBeLessThan(1_000);
    expect(body.returned_count).toBe(body.active_tasks.length);
    expect(body.truncated_fields.length).toBeGreaterThan(0);
    expect(body.current_phase.title).toEqual(expect.any(String));
    expect(body.current_phase.detail_refs.title).toMatchObject({ entity_type: "phase", entity_id: "PHASE-CURRENT", field: "title", revision: 76 });
    expect(body.project.detail_refs.objective).toBeDefined();
    expect(body.current_phase.detail_refs.objective).toBeDefined();
    expect(body.active_tasks[0].detail_refs.title).toBeDefined();
    expect(body.next_cursor).toEqual(expect.any(String));
    const ids = [...body.active_tasks.map((task: Record<string, unknown>) => task.task_id)];
    let cursor = body.next_cursor as string | null;
    let pageCount = 1;
    while (cursor) {
      expect(pageCount).toBeLessThan(30);
      const pageResult = summarizeCanonicalContext(input, "PRJ-0007", cursor);
      expect(pageResult.error).toBeUndefined();
      const page = pageResult.value!;
      const pageText = JSON.stringify(page);
      expect(new TextEncoder().encode(pageText).byteLength).toBeLessThanOrEqual(24 * 1024);
      expect(page.serialized_bytes).toBe(new TextEncoder().encode(pageText).byteLength);
      ids.push(...(page.active_tasks as Array<Record<string, unknown>>).map((task) => task.task_id));
      cursor = page.next_cursor as string | null;
      pageCount++;
    }
    expect(pageCount).toBe(20);
    expect(ids).toEqual(Object.keys(state.tasks));
  });

  it("retrieves complete long fields in UTF-8 chunks no larger than 4 KiB", async () => {
    const objective = "مرحبا-é🧭".repeat(30_000);
    const taskTitle = "titre 🧭é".repeat(3_000);
    const blockedReason = "bloqué 🧭é".repeat(3_000);
    const state = {
      project_id: "PRJ-0007", revision: 76, current_phase_id: "PHASE-CURRENT",
      plan_phases: { "PHASE-CURRENT": { phase_id: "PHASE-CURRENT", title: "Current", objective, next_actions: [] } },
      tasks: { "TASK-A": { task_id: "TASK-A", title: taskTitle, blocked_reason: blockedReason } }
    };
    const server = contextServer(state);
    const detail = server._registeredTools.project_os_get_context_detail;
    expect(detail).toBeDefined();
    let cursor: string | undefined;
    let rebuilt = "";
    do {
      const result = await detail!.handler({
        project_id: "PRJ-0007", revision: 76, entity_type: "phase", entity_id: "PHASE-CURRENT", field: "objective", cursor
      });
      const body = parse(result);
      const bytes = new TextEncoder().encode(result.content[0]!.text).byteLength;
      expect(bytes).toBeLessThanOrEqual(16 * 1024);
      expect(new TextEncoder().encode(body.chunk).byteLength).toBeLessThanOrEqual(4 * 1024);
      rebuilt += body.chunk;
      cursor = body.next_cursor ?? undefined;
    } while (cursor);
    expect(rebuilt).toBe(objective);

    for (const [field, expected] of [["title", taskTitle], ["blocked_reason", blockedReason]] as const) {
      cursor = undefined;
      let value = "";
      do {
        const result = await detail!.handler({ project_id: "PRJ-0007", revision: 76, entity_type: "task", entity_id: "TASK-A", field, cursor });
        const body = parse(result);
        expect(new TextEncoder().encode(body.chunk).byteLength).toBeLessThanOrEqual(4 * 1024);
        value += body.chunk;
        cursor = body.next_cursor ?? undefined;
      } while (cursor);
      expect(value).toBe(expected);
    }
  });

  it("paginates next actions by item and then UTF-8 text offset without reordering", async () => {
    const actions = ["première étape 🧭é".repeat(2_000), "deuxième étape 🧭é".repeat(2_000)];
    const server = contextServer({
      project_id: "PRJ-0007", revision: 76, current_phase_id: "PHASE-CURRENT",
      plan_phases: { "PHASE-CURRENT": { phase_id: "PHASE-CURRENT", title: "Current", objective: "", next_actions: actions } }, tasks: {}
    });
    const detail = server._registeredTools.project_os_get_context_detail!;
    const rebuilt = ["", ""];
    let cursor: string | undefined;
    do {
      const body = parse(await detail.handler({ project_id: "PRJ-0007", revision: 76, entity_type: "phase", entity_id: "PHASE-CURRENT", field: "next_actions", cursor }));
      for (const item of body.items) rebuilt[item.index] += item.chunk;
      cursor = body.next_cursor ?? undefined;
    } while (cursor);
    expect(rebuilt).toEqual(actions);
  });

  it("rejects forged, oversized, out-of-range, and stale cursors without mixing revisions", async () => {
    const server = contextServer({
      project_id: "PRJ-0007", revision: 76, current_phase_id: null, plan_phases: {},
      tasks: Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`TASK-${i}`, { task_id: `TASK-${i}`, title: "task", status: "in_progress" }]))
    });
    const context = server._registeredTools.project_os_get_context;
    const malformed = await context.handler({ project_id: "PRJ-0007", cursor: "!".repeat(1_100) });
    expect(parse(malformed).code).toBe("CONTEXT_CURSOR_INVALID");

    const first = parse(await context.handler({ project_id: "PRJ-0007" }));
    const forged = await context.handler({ project_id: "PRJ-0007", cursor: first.next_cursor.slice(0, -1) + "A" });
    expect(parse(forged).code).toBe("CONTEXT_CURSOR_INVALID");

    const staleServer = contextServer({
      project_id: "PRJ-0007", revision: 77, current_phase_id: null, plan_phases: {}, tasks: {}
    });
    const stale = await staleServer._registeredTools.project_os_get_context.handler({ project_id: "PRJ-0007", cursor: first.next_cursor });
    expect(parse(stale).code).toBe("CONTEXT_CURSOR_STALE");

    const outOfRange = await context.handler({ project_id: "PRJ-0007", cursor: mutateCursor(first.next_cursor, { task_offset: 10_000 }) });
    expect(parse(outOfRange).code).toBe("CONTEXT_CURSOR_INVALID");
  });

  it("rejects offsets that split surrogate pairs and reports stale detail cursors as stale", async () => {
    const body = {
      context: { canonical_revision: 76 },
      canonical_state: { project_id: "PRJ-0007", revision: 76, current_phase_id: "PHASE-CURRENT",
        plan_phases: { "PHASE-CURRENT": { phase_id: "PHASE-CURRENT", title: "Current", objective: "🧭x".repeat(8_000), next_actions: [] } }, tasks: {} }
    };
    const summary = summarizeCanonicalContext(body, "PRJ-0007").value!;
    const splitSummary = summarizeCanonicalContext(body, "PRJ-0007", mutateCursor(summary.next_cursor as string, { objective_offset: 1 }));
    expect(splitSummary.error?.code).toBe("CONTEXT_CURSOR_INVALID");

    const oldServer = contextServer(body.canonical_state);
    const oldPage = parse(await oldServer._registeredTools.project_os_get_context_detail!.handler({
      project_id: "PRJ-0007", revision: 76, entity_type: "phase", entity_id: "PHASE-CURRENT", field: "objective"
    }));
    const splitDetailCursor = mutateCursor(oldPage.next_cursor, { text_offset: 1 });
    const splitDetail = await oldServer._registeredTools.project_os_get_context_detail!.handler({
      project_id: "PRJ-0007", revision: 76, entity_type: "phase", entity_id: "PHASE-CURRENT", field: "objective", cursor: splitDetailCursor
    });
    expect(parse(splitDetail).code).toBe("CONTEXT_CURSOR_INVALID");

    const freshServer = contextServer({ ...body.canonical_state, revision: 77 });
    const staleDetail = await freshServer._registeredTools.project_os_get_context_detail!.handler({
      project_id: "PRJ-0007", revision: 77, entity_type: "phase", entity_id: "PHASE-CURRENT", field: "objective", cursor: oldPage.next_cursor
    });
    expect(parse(staleDetail)).toMatchObject({ code: "CONTEXT_CURSOR_STALE", current_revision: 77 });
  });

  it("uses the exact field whitelist and returns null for absent optional fields", async () => {
    const server = contextServer({
      project_id: "PRJ-0007", name: "Project", revision: 76, current_phase_id: "PHASE-CURRENT",
      plan_phases: { "PHASE-CURRENT": { phase_id: "PHASE-CURRENT", title: "Current", next_actions: [] } }, tasks: {}
    });
    const detail = server._registeredTools.project_os_get_context_detail!;
    const absent = parse(await detail.handler({ project_id: "PRJ-0007", revision: 76, entity_type: "phase", entity_id: "PHASE-CURRENT", field: "objective" }));
    expect(absent.value).toBeNull();
    const forbidden = await detail.handler({ project_id: "PRJ-0007", revision: 76, entity_type: "project", entity_id: "PRJ-0007", field: "canonical_state" });
    expect(forbidden.isError).toBe(true);
  });
});
