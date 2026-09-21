import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { DiagnosticProjectGuard } from "../src/durable/project-guard-diagnostics";
import { SearchSyncProjectGuard } from "../src/durable/project-guard-search-sync";
import { ProjectGuard } from "../src/durable/project-guard-neutral";
import { ExecutionJournal } from "../src/execution/journal";
import { machineCommitRecordPath, machineStatePath } from "../src/persistence/layout";
import type { ProviderRequestScope } from "../src/persistence/provider/contract";
import { ProjectRepository } from "../src/persistence/repository";
import { commitFixture } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";

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

it("fails closed instead of issuing a stale context when the snapshot reader stalls", async () => {
  const projectId = "PRJ-8399";
  const mock = installDropboxMock();
  const record = commitFixture(projectId, 1)[0]!;
  mock.files.set(machineCommitRecordPath(projectId, 1), JSON.stringify(record));
  mock.files.set(machineStatePath(projectId), JSON.stringify(record.state));
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
  let release!: () => void;
  const stalledSnapshot = new Promise<never>((resolve) => { release = resolve as unknown as () => void; });
  await runInDurableObject(guard, async (instance) => {
    const subject = instance as unknown as {
      env: Env;
      repository: ProjectRepository;
      loadOrRecoverState(): Promise<unknown>;
      canonicalContextReadDeadlineMs(): number;
      canonicalContextRepository(projectId: string, scope: ProviderRequestScope): ProjectRepository;
    };
    subject.env.MUTATION_CONTEXT_SIGNING_KEY = "read-trace-context";
    await subject.loadOrRecoverState();
    vi.spyOn(subject, "canonicalContextReadDeadlineMs").mockReturnValue(20);
    vi.spyOn(subject, "canonicalContextRepository").mockReturnValue(subject.repository);
    vi.spyOn(subject.repository, "readProjectState").mockImplementation(() => stalledSnapshot);
  });
  let finished = false;
  const response = guard.fetch("https://project-guard.internal/mutation-context")
    .then((value) => { finished = true; return value; });
  try {
    await vi.waitFor(() => expect(finished).toBe(true), { timeout: 2_500 });
    expect((await response).status).toBe(503);
    await expect((await response).json()).resolves.toMatchObject({ error: "canonical_unavailable" });
  } finally {
    release();
  }
});

it("bounds a cold context read when the canonical snapshot reader stalls", async () => {
  const projectId = "PRJ-8400";
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
  let release!: () => void;
  const stalledSnapshot = new Promise<never>((resolve) => { release = resolve as unknown as () => void; });
  let readSnapshot!: ReturnType<typeof vi.spyOn>;
  await runInDurableObject(guard, (instance) => {
    const subject = instance as unknown as {
      env: Env;
      repository: ProjectRepository;
      canonicalContextReadDeadlineMs(): number;
      canonicalContextRepository(projectId: string, scope: ProviderRequestScope): ProjectRepository;
    };
    subject.env.MUTATION_CONTEXT_SIGNING_KEY = "read-trace-context";
    vi.spyOn(subject, "canonicalContextReadDeadlineMs").mockReturnValue(20);
    vi.spyOn(subject, "canonicalContextRepository").mockReturnValue(subject.repository);
    readSnapshot = vi.spyOn(subject.repository, "readProjectState").mockImplementation(() => stalledSnapshot);
  });
  let finished = false;
  const response = guard.fetch("https://project-guard.internal/mutation-context")
    .then((value) => { finished = true; return value; });
  try {
    await vi.waitFor(() => expect(readSnapshot).toHaveBeenCalledOnce());
    const concurrent = await guard.fetch("https://project-guard.internal/mutation-context");
    expect(concurrent.status).toBe(503);
    await expect(concurrent.json()).resolves.toMatchObject({ error: "canonical_read_busy" });
    expect(readSnapshot).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(finished).toBe(true), { timeout: 2_500 });
    expect((await response).status).toBe(503);
  } finally {
    release();
  }
});

it("releases a timed-out canonical read so the next fresh context can proceed", async () => {
  const projectId = "PRJ-8404";
  const mock = installDropboxMock();
  const record = commitFixture(projectId, 1)[0]!;
  mock.files.set(machineCommitRecordPath(projectId, 1), JSON.stringify(record));
  mock.files.set(machineStatePath(projectId), JSON.stringify(record.state));
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
  let scope: ProviderRequestScope | null = null;
  let wasAborted = false;

  await runInDurableObject(guard, async (instance) => {
    const subject = instance as unknown as {
      env: Env;
      repository: ProjectRepository;
      canonicalContextReadDeadlineMs(): number;
      canonicalContextRepository(projectId: string, scope: ProviderRequestScope): ProjectRepository;
    };
    subject.env.MUTATION_CONTEXT_SIGNING_KEY = "read-trace-context";
    vi.spyOn(subject, "canonicalContextReadDeadlineMs").mockReturnValue(20);
    vi.spyOn(subject, "canonicalContextRepository").mockImplementation((_projectId, nextScope) => {
      scope = nextScope;
      scope.signal.addEventListener("abort", () => { wasAborted = true; }, { once: true });
      return subject.repository;
    });
    const original = subject.repository.readProjectState.bind(subject.repository);
    let reads = 0;
    vi.spyOn(subject.repository, "readProjectState").mockImplementation((id) => {
      reads += 1;
      if (reads > 1) return original(id);
      return new Promise((_, reject) => {
        scope!.signal.addEventListener("abort", () => reject(scope!.signal.reason), { once: true });
      });
    });
  });

  const first = await guard.fetch("https://project-guard.internal/mutation-context");
  expect(first.status).toBe(503);
  expect(wasAborted).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const second = await guard.fetch("https://project-guard.internal/mutation-context");
  expect(second.status).toBe(200);
  await expect(second.json()).resolves.toMatchObject({ canonical_state: { revision: 1 } });
});

it("fails closed when it cannot verify the current snapshot against its commit suffix", async () => {
  const projectId = "PRJ-8401";
  const mock = installDropboxMock();
  const record = commitFixture(projectId, 1)[0]!;
  mock.files.set(machineCommitRecordPath(projectId, 1), JSON.stringify(record));
  mock.files.set(machineStatePath(projectId), JSON.stringify(record.state));
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
  let release!: () => void;
  const stalledRecord = new Promise<never>((resolve) => { release = resolve as unknown as () => void; });
  await runInDurableObject(guard, async (instance) => {
    const subject = instance as unknown as {
      env: Env;
      repository: ProjectRepository;
      loadOrRecoverState(): Promise<unknown>;
      canonicalContextReadDeadlineMs(): number;
      canonicalContextRepository(projectId: string, scope: ProviderRequestScope): ProjectRepository;
    };
    subject.env.MUTATION_CONTEXT_SIGNING_KEY = "read-trace-context";
    await subject.loadOrRecoverState();
    vi.spyOn(subject, "canonicalContextReadDeadlineMs").mockReturnValue(20);
    vi.spyOn(subject, "canonicalContextRepository").mockReturnValue(subject.repository);
    vi.spyOn(subject.repository, "readCommitRecord").mockImplementation(() => stalledRecord);
  });
  let finished = false;
  const response = guard.fetch("https://project-guard.internal/mutation-context")
    .then((value) => { finished = true; return value; });
  try {
    await vi.waitFor(() => expect(finished).toBe(true), { timeout: 2_500 });
    expect((await response).status).toBe(503);
  } finally {
    release();
  }
});

it("reads a short contiguous commit history when no canonical snapshot exists", async () => {
  const projectId = "PRJ-8402";
  const mock = installDropboxMock();
  const records = commitFixture(projectId, 3);
  for (const record of records) mock.files.set(machineCommitRecordPath(projectId, record.new_revision), JSON.stringify(record));
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
  await runInDurableObject(guard, (instance) => {
    (instance as unknown as { env: Env }).env.MUTATION_CONTEXT_SIGNING_KEY = "read-trace-context";
  });
  const response = await guard.fetch("https://project-guard.internal/mutation-context");
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ canonical_state: { revision: 3 } });
});

it("does not sign a partial commit suffix when the shared read deadline expires", async () => {
  const projectId = "PRJ-8403";
  const mock = installDropboxMock();
  const records = commitFixture(projectId, 129);
  mock.files.set(machineStatePath(projectId), JSON.stringify(records[0]!.state));
  for (const record of records.slice(1)) mock.files.set(machineCommitRecordPath(projectId, record.new_revision), JSON.stringify(record));
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await runInDurableObject(guard, (instance) => {
    const subject = instance as unknown as {
      env: Env;
      repository: ProjectRepository;
      canonicalContextReadDeadlineMs(): number;
      canonicalContextRepository(projectId: string, scope: ProviderRequestScope): ProjectRepository;
    };
    subject.env.MUTATION_CONTEXT_SIGNING_KEY = "read-trace-context";
    vi.spyOn(subject, "canonicalContextReadDeadlineMs").mockReturnValue(2_000);
    vi.spyOn(subject, "canonicalContextRepository").mockReturnValue(subject.repository);
    const original = subject.repository.readCommitRecord.bind(subject.repository);
    let reads = 0;
    vi.spyOn(subject.repository, "readCommitRecord").mockImplementation(async (id, revision) => {
      const result = await original(id, revision);
      reads += 1;
      if (reads === 128) now += 2_000;
      return result;
    });
  });
  const response = await guard.fetch("https://project-guard.internal/mutation-context");
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toMatchObject({ error: "canonical_unavailable" });
});
