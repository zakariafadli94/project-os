import { afterEach, expect, it, vi } from "vitest";
import { DiagnosticProjectGuard } from "../src/durable/project-guard-diagnostics";
import { SearchSyncProjectGuard } from "../src/durable/project-guard-search-sync";

afterEach(() => vi.restoreAllMocks());

it("traces arrival before the diagnostic queue, without leaking query values", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(SearchSyncProjectGuard.prototype, "fetch")
    .mockImplementationOnce(async () => { await pending; return Response.json({}); })
    .mockResolvedValueOnce(Response.json({}));
  const guard = Object.assign(Object.create(DiagnosticProjectGuard.prototype), {
    ctx: { id: { name: "PRJ-0007" } },
    persistence: { diagnostics: { beginOperation: vi.fn() } }
  }) as DiagnosticProjectGuard;
  const first = guard.fetch(new Request("https://guard.internal/receipt"));
  await Promise.resolve();
  const correlationId = "12604c59-283f-4a8e-bdaa-f46076823d45";
  const second = guard.fetch(new Request("https://guard.internal/request-status?request_id=DO_NOT_LOG", {
    headers: { "x-project-os-correlation-id": correlationId }
  }));
  expect(log).toHaveBeenCalledWith("project_os_guard_received", expect.objectContaining({ correlation_id: correlationId }));
  expect(log).not.toHaveBeenCalledWith("project_os_guard_acquired", expect.anything());
  release();
  await Promise.all([first, second]);
  expect(log).toHaveBeenCalledWith("project_os_guard_acquired", expect.objectContaining({ correlation_id: correlationId }));
  expect(log).toHaveBeenCalledWith("project_os_guard_finished", expect.objectContaining({ correlation_id: correlationId, status: 200 }));
  expect(JSON.stringify(log.mock.calls)).not.toContain("DO_NOT_LOG");
});
