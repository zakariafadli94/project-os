import { afterEach, expect, it, vi } from "vitest";
import { DiagnosticProjectGuard } from "../src/durable/project-guard-diagnostics";
import { SearchSyncProjectGuard } from "../src/durable/project-guard-search-sync";
import { ProjectGuard } from "../src/durable/project-guard-neutral";
import { ExecutionJournal } from "../src/execution/journal";

afterEach(() => vi.restoreAllMocks());

it("traces a mutation waiting for the diagnostic queue, without leaking query values", async () => {
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
  const first = guard.fetch(new Request("https://guard.internal/reconcile-documents?scheduled=1"));
  await Promise.resolve();
  const correlationId = "12604c59-283f-4a8e-bdaa-f46076823d45";
  const second = guard.fetch(new Request("https://guard.internal/transaction?request_id=DO_NOT_LOG", {
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

it("serves a canonical context read while a document reconciliation is waiting on its provider", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const fetch = vi.spyOn(SearchSyncProjectGuard.prototype, "fetch")
    .mockImplementationOnce(async () => { await pending; return Response.json({}); })
    .mockResolvedValueOnce(Response.json({ context: { canonical_revision: 12 } }));
  const guard = Object.assign(Object.create(DiagnosticProjectGuard.prototype), {
    ctx: { id: { name: "PRJ-0007" } },
    persistence: { diagnostics: { beginOperation: vi.fn() } }
  }) as DiagnosticProjectGuard;
  const reconciliation = guard.fetch(new Request("https://guard.internal/reconcile-documents?scheduled=1"));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  let readFinished = false;
  const contextRead = guard.fetch(new Request("https://guard.internal/mutation-context"))
    .then((response) => { readFinished = true; return response; });
  try {
    await vi.waitFor(() => expect(readFinished).toBe(true), { timeout: 150 });
    expect((await contextRead).status).toBe(200);
  } finally {
    release();
    await reconciliation;
  }
});

it("reports a bounded unknown state instead of false receipt absence during a long mutation", async () => {
  vi.spyOn(ExecutionJournal.prototype, "status").mockResolvedValue(null);
  const handleRequestStatus = vi.fn().mockResolvedValue(Response.json({ status: "committed" }));
  const handleReceiptRead = vi.fn().mockResolvedValue(Response.json({ status: "committed" }));
  const guard = Object.assign(Object.create(ProjectGuard.prototype), {
    ctx: { id: { name: "PRJ-0007" } },
    persistence: {},
    queue: Promise.resolve(),
    queueDepth: 0,
    handleRequestStatus,
    handleReceiptRead
  }) as ProjectGuard;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const serialized = (guard as unknown as { serialize<T>(operation: () => Promise<T>): Promise<T> }).serialize(async () => {
    await pending;
    return "written";
  });
  try {
    for (const path of [
      "/request-status?kind=transaction&request_id=TXN-1",
      "/receipt?kind=transaction&request_id=TXN-1",
      "/execution-status?kind=transaction&request_id=TXN-1"
    ]) {
      const response = await guard.fetch(new Request(`https://guard.internal${path}`));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ code: "PROJECT_OS_READ_BUSY" });
    }
    expect(handleRequestStatus).not.toHaveBeenCalled();
    expect(handleReceiptRead).not.toHaveBeenCalled();
  } finally {
    release();
    await serialized;
  }
  const after = await guard.fetch(new Request("https://guard.internal/request-status?kind=transaction&request_id=TXN-1"));
  await expect(after.json()).resolves.toMatchObject({ status: "committed" });
});
