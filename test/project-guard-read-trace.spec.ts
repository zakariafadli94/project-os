import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { DiagnosticProjectGuard } from "../src/durable/project-guard-diagnostics";
import { SearchSyncProjectGuard } from "../src/durable/project-guard-search-sync";
import { SubrequestResilientProjectGuard } from "../src/durable/project-guard-subrequest-resilient";
import { ProjectGuard } from "../src/durable/project-guard-neutral";
import { ExecutionJournal, executionHash } from "../src/execution/journal";
import type { ExecutionAdmission } from "../src/execution/contract";
import type { ProjectState } from "../src/domain/project-state";
import { machineArtifactReceiptPath, machineCommitRecordPath, machineDocumentRoot, machineMaterializationHeadPath, machineMaterializationRecordPath, machineMutationIntentPath, machineReceiptPath, machineStatePath } from "../src/persistence/layout";
import { receiptPath } from "../src/persistence/paths";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { ManagedDocumentRequestLedger } from "../src/documents/request-ledger";
import { sha256Text } from "../src/documents/hash";
import { canonicalJson } from "../src/rules/contract";
import type { ProviderRequestScope } from "../src/persistence/provider/contract";
import { ProjectRepository } from "../src/persistence/repository";
import { MutationGateRepository } from "../src/mutation-gate/repository";
import { commitFixture } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";

afterEach(() => vi.restoreAllMocks());

async function seedFinalizedTransactionStatus(projectId: string, requestId: string, revision: number) {
  const mock = installDropboxMock();
  const hash = "a".repeat(64);
  const admission: ExecutionAdmission = {
    project_id: projectId, operation: "research.add", request_id: requestId, kind: "transaction",
    request_hash: hash, actor: { actor_id: "qualification-fixture", authority: "test" },
    global_revision: 1, project_revision: revision - 1,
    ruleset: { digest: hash, rules: [], global_revision: 1, project_revision: revision - 1 },
    verdict: "allow", results: [], gaps: [], deferred_rules: [],
    resources: [{ resource_id: "research", resource_type: "research", zone: "RESEARCH", version: hash }]
  };
  const journal = new ExecutionJournal(createProductionPersistence(env as unknown as Env, projectId), projectId, "transaction", requestId);
  await journal.commit(admission, null);
  const receipt = {
    schema_version: "1.0", transaction_id: requestId, project_id: projectId,
    status: "committed", previous_revision: revision - 1, new_revision: revision,
    event_id: `EVT-${String(revision).padStart(6, "0")}`, committed_at: "2026-09-25T00:00:00.000Z"
  };
  mock.files.set(machineReceiptPath(requestId), JSON.stringify(receipt));
  const receiptRef = `${machineCommitRecordPath(projectId, revision)}#receipt`;
  await journal.recordReceipt("committed", receiptRef);
  await journal.finalizeMaterializedTransaction({
    canonical_commit_ref: machineCommitRecordPath(projectId, revision), receipt_ref: receiptRef,
    materialization_head_ref: machineMaterializationHeadPath(projectId),
    materialization_record_ref: machineMaterializationRecordPath(projectId, revision, 1),
    target_revision: revision, source_event_id: receipt.event_id, result_root_hash: "b".repeat(64)
  });
  return { mock, receipt, uploadCountAfterSeed: mock.uploadCalls.length };
}

async function seedFinalizedDocumentOrArtifactStatus(kind: "document" | "artifact", projectId: string, requestId: string) {
  const mock = installDropboxMock();
  const runtime = createProductionPersistence(env as unknown as Env, projectId);
  const requestHash = await sha256Text("{}");
  const contentHash = "c".repeat(64);
  const admission: ExecutionAdmission = {
    project_id: projectId, operation: kind === "document" ? "document.write_working" : "artifact.write",
    request_id: requestId, kind, request_hash: requestHash,
    actor: { actor_id: "qualification-fixture", authority: "test" },
    global_revision: 1, project_revision: 2,
    ruleset: { digest: "a".repeat(64), rules: [], global_revision: 1, project_revision: 2 },
    verdict: "allow", results: [], gaps: [], deferred_rules: [],
    resources: [{ resource_id: kind === "document" ? "DOC-8428" : requestId, resource_type: kind, zone: "WORKING", version: contentHash }]
  };
  const journal = new ExecutionJournal(runtime, projectId, kind, requestId);
  await journal.commit(admission, null);
  let receipt: Record<string, any>;
  let receiptRef: string;
  if (kind === "document") {
    const documentRequest = "{}";
    receipt = {
      request_id: requestId, project_id: projectId, document_id: "DOC-8428", version_id: "v1",
      stage: "working", logical_path: "WORKING/QUALIFICATION.md", status: "committed", provider_rev: "rev-doc-1"
    };
    const ledger = new ManagedDocumentRequestLedger(runtime.objects);
    await ledger.ensureIntent(projectId, requestId, documentRequest);
    await ledger.writeReceipt(projectId, requestId, documentRequest, JSON.stringify(receipt));
    receiptRef = `${machineDocumentRoot(projectId)}/requests/${requestId}/receipt.json`;
    await journal.recordReceipt("committed", receiptRef);
    await journal.finalizeVerifiedDocument({
      receipt_ref: receiptRef, document_id: receipt.document_id, version_id: receipt.version_id,
      stage: receipt.stage, logical_path: receipt.logical_path, provider_rev: receipt.provider_rev
    });
  } else {
    receipt = {
      request_id: requestId, project_id: projectId, relative_path: "QUALIFICATION.md",
      content_sha256: contentHash, status: "committed"
    };
    mock.files.set(machineArtifactReceiptPath(requestId), JSON.stringify(receipt));
    receiptRef = machineArtifactReceiptPath(requestId);
    await journal.recordReceipt("committed", receiptRef);
    await journal.finalizeVerifiedArtifact({
      receipt_ref: receiptRef, mutation_intent_ref: machineMutationIntentPath(projectId, requestId),
      destination_path: `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-qualification/WORKING/QUALIFICATION.md`, content_sha256: contentHash
    });
  }
  return { mock, receipt, uploadCountAfterSeed: mock.uploadCalls.length };
}

it.each(["project_queue", "search_queue"] as const)(
  "returns an identity-bound finalized status while %s is occupied when all evidence is durable",
  async (queue) => {
    const projectId = queue === "project_queue" ? "PRJ-8422" : "PRJ-8423";
    const requestId = `TXN-${projectId}-FINALIZED`;
    const revision = 121;
    const { mock, receipt, uploadCountAfterSeed } = await seedFinalizedTransactionStatus(projectId, requestId, revision);
    const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      const state = instance as unknown as { queueDepth: number; searchQueueDepth: number };
      if (queue === "project_queue") state.queueDepth = 1;
      else state.searchQueueDepth = 1;
    });

    const response = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${requestId}`);
    const body = await response.json<Record<string, any>>();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      project_id: projectId, kind: "transaction", request_id: requestId, status: "finalized",
      receipt: { ...receipt },
      execution: {
        project_id: projectId, kind: "transaction", request_id: requestId,
        status: "finalized", terminal: true, finalization_ref: expect.stringContaining(`/executions/`)
      },
      observation: {
        project_id: projectId, kind: "transaction", request_id: requestId,
        status: "finalized", receipt_status: "committed", execution_status: "finalized", terminal: true
      }
    });
    expect(mock.uploadCalls).toHaveLength(uploadCountAfterSeed);
  }
);

it.each(["project_queue", "search_queue"] as const)(
  "keeps an absent request unknown while %s is occupied",
  async (queue) => {
    const projectId = queue === "project_queue" ? "PRJ-8424" : "PRJ-8425";
    const requestId = `TXN-${projectId}-ABSENT`;
    const mock = installDropboxMock();
    const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      const state = instance as unknown as { queueDepth: number; searchQueueDepth: number };
      if (queue === "project_queue") state.queueDepth = 1;
      else state.searchQueueDepth = 1;
    });

    const response = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${requestId}`);
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      project_id: projectId, kind: "transaction", request_id: requestId,
      status: "unknown", code: "PROJECT_OS_READ_BUSY",
      observation: { status: "unknown", code: "PROJECT_OS_READ_BUSY" }
    });
    expect(mock.uploadCalls).toHaveLength(0);
  }
);

it.each(["project_binding_mismatch", "receipt_revision_mismatch", "provider_unavailable"] as const)(
  "keeps a busy status unknown when bounded evidence has %s",
  async (caseName) => {
    const projectId = caseName === "project_binding_mismatch" ? "PRJ-8426"
      : caseName === "receipt_revision_mismatch" ? "PRJ-8427" : "PRJ-8428";
    const requestId = `TXN-${projectId}-FINALIZED`;
    const revision = 122;
    const { mock, uploadCountAfterSeed } = await seedFinalizedTransactionStatus(projectId, requestId, revision);
    const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
    const initial = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${requestId}`);
    const evidence = await initial.json<Record<string, any>>();
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { queueDepth: number }).queueDepth = 1;
    });
    if (caseName === "project_binding_mismatch") {
      evidence.project_id = "PRJ-9999";
      vi.spyOn(ProjectGuard.prototype as any, "readBoundedRequestStatus").mockResolvedValue(Response.json(evidence));
    } else if (caseName === "receipt_revision_mismatch") {
      evidence.receipt.new_revision++;
      vi.spyOn(ProjectGuard.prototype as any, "readBoundedRequestStatus").mockResolvedValue(Response.json(evidence));
    } else {
      vi.spyOn(ProjectGuard.prototype as any, "readBoundedRequestStatus").mockResolvedValue(
        Response.json({ status: "unknown", code: "request_status_unavailable" }, { status: 503 })
      );
    }

    const response = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${requestId}`);
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ project_id: projectId, kind: "transaction", request_id: requestId,
      status: "unknown", code: "PROJECT_OS_READ_BUSY" });
    expect(mock.uploadCalls).toHaveLength(uploadCountAfterSeed);
  }
);

it.each(["certificate_missing", "certificate_hash_mismatch", "certificate_cross_binding"] as const)(
  "does not trust a finalized status when its durable certificate is %s",
  async (caseName) => {
    const projectId = caseName === "certificate_missing" ? "PRJ-8429"
      : caseName === "certificate_hash_mismatch" ? "PRJ-8430" : "PRJ-8433";
    const requestId = `TXN-${projectId}-FINALIZED`;
    const revision = 123;
    const { mock } = await seedFinalizedTransactionStatus(projectId, requestId, revision);
    const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
    const initial = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${requestId}`);
    const initialBody = await initial.json<Record<string, any>>();
    const finalizationRef = initialBody.execution.finalization_ref as string;
    if (caseName === "certificate_missing") mock.files.delete(finalizationRef);
    else if (caseName === "certificate_hash_mismatch") {
      mock.files.set(finalizationRef, JSON.stringify({ project_id: projectId, request_id: requestId }));
    } else {
      const journal = new ExecutionJournal(createProductionPersistence(env as unknown as Env, projectId), projectId, "transaction", requestId);
      const saved = await journal.load();
      const raw = mock.files.get(finalizationRef);
      expect(saved).not.toBeNull();
      expect(raw).toBeDefined();
      const certificate = JSON.parse(raw!) as Record<string, unknown>;
      certificate.project_id = "PRJ-9999";
      const crossBoundRef = `${await journal.root()}/finalizations/${await sha256Text(canonicalJson(certificate))}.json`;
      mock.files.set(crossBoundRef, canonicalJson(certificate));
      saved!.progress.finalization_ref = crossBoundRef;
      saved!.progress.sequence++;
      await journal.save(saved!.progress, saved!.token);
    }
    const uploadCountAfterTamper = mock.uploadCalls.length;
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { queueDepth: number }).queueDepth = 1;
    });

    const response = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${requestId}`);
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ status: "unknown", code: "PROJECT_OS_READ_BUSY" });
    expect(mock.uploadCalls).toHaveLength(uploadCountAfterTamper);
  }
);

it.each([
  ["document", "PRJ-8431", "DOCREQ-PROOF-8431"],
  ["artifact", "PRJ-8432", "ART-PROOF-8432"]
] as const)(
  "verifies the family-specific receipt reference in a %s finalization certificate",
  async (kind, projectId, requestId) => {
    const { mock, receipt, uploadCountAfterSeed } = await seedFinalizedDocumentOrArtifactStatus(kind, projectId, requestId);
    const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { queueDepth: number; searchQueueDepth: number }).searchQueueDepth = 1;
    });

    const response = await guard.fetch(`https://project-guard.internal/request-status?kind=${kind}&request_id=${requestId}`);
    const body = await response.json<Record<string, any>>();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ project_id: projectId, kind, request_id: requestId, status: "finalized", receipt });
    expect(body.execution.receipt_ref).toBe(kind === "document"
      ? `${machineDocumentRoot(projectId)}/requests/${requestId}/receipt.json`
      : machineArtifactReceiptPath(requestId));
    expect(mock.uploadCalls).toHaveLength(uploadCountAfterSeed);
  }
);

it.each(["/mutation-context", "/request-status", "/receipt", "/execution-status"])(
  "does not queue %s behind a slow finalization in the search boundary",
  async (path) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.spyOn(SubrequestResilientProjectGuard.prototype, "fetch")
      .mockImplementationOnce(async () => { await pending; return Response.json({ status: "done" }); })
      .mockResolvedValueOnce(Response.json({ status: "observed" }));
    const guard = Object.assign(Object.create(SearchSyncProjectGuard.prototype), {
      ctx: { id: { name: "PRJ-0007" } },
      searchQueue: Promise.resolve(),
      searchQueueDepth: 0,
      handleReceiptRead: vi.fn().mockResolvedValue(Response.json({ error: "receipt_not_found" }, { status: 404 })),
      readBoundedRequestStatusReceipt: vi.fn().mockResolvedValue(null)
    }) as SearchSyncProjectGuard;
    const finalization = guard.fetch(new Request("https://guard.internal/finalize-materialization", { method: "POST" }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    let readFinished = false;
    const readPath = path === "/mutation-context" ? path : `${path}?kind=transaction&request_id=TXN-QUEUED`;
    const read = guard.fetch(new Request(`https://guard.internal${readPath}`))
      .then((response) => { readFinished = true; return response; });
    try {
      await vi.waitFor(() => expect(readFinished).toBe(true), { timeout: 150 });
      await expect(read).resolves.toMatchObject({ status: path === "/mutation-context" ? 200 : 503 });
    } finally {
      release();
      await Promise.all([finalization, read]);
    }
  }
);

it("does not report false absence for a transaction waiting at the search boundary", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const fetch = vi.spyOn(SubrequestResilientProjectGuard.prototype, "fetch")
    .mockImplementationOnce(async () => { await pending; return Response.json({ status: "committed" }); })
    .mockResolvedValueOnce(Response.json({ status: "not_received" }));
  const guard = Object.assign(Object.create(SearchSyncProjectGuard.prototype), {
    ctx: { id: { name: "PRJ-0007" } },
    searchQueue: Promise.resolve(),
    searchQueueDepth: 0
  }) as SearchSyncProjectGuard;
  const submitted = guard.fetch(new Request("https://guard.internal/transaction", { method: "POST" }));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  try {
    const status = await guard.fetch(new Request(
      "https://guard.internal/request-status?kind=transaction&request_id=TXN-QUEUED",
      { headers: { "x-project-os-correlation-id": "corr-queued" } }
    ));
    expect(status.status).toBe(503);
    await expect(status.json()).resolves.toMatchObject({
      project_id: "PRJ-0007", request_id: "TXN-QUEUED", status: "unknown", code: "PROJECT_OS_READ_BUSY"
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await submitted;
  }
});

it("serves an exact locally committed receipt while unrelated search work is queued", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const fetch = vi.spyOn(SubrequestResilientProjectGuard.prototype, "fetch")
    .mockImplementationOnce(async () => { await pending; return Response.json({ status: "done" }); });
  const receipt = { status: "committed", project_id: "PRJ-0007", transaction_id: "TXN-KNOWN" };
  const guard = Object.assign(Object.create(SearchSyncProjectGuard.prototype), {
    ctx: { id: { name: "PRJ-0007" } },
    searchQueue: Promise.resolve(),
    searchQueueDepth: 0,
    handleReceiptRead: vi.fn().mockResolvedValue(Response.json(receipt))
  }) as SearchSyncProjectGuard;
  const finalization = guard.fetch(new Request("https://guard.internal/finalize-materialization", { method: "POST" }));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  try {
    const response = await guard.fetch(new Request(
      "https://guard.internal/receipt?kind=transaction&request_id=TXN-KNOWN"
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(receipt);
  } finally {
    release();
    await finalization;
  }
});

it("checks a canonical receipt under outer queue pressure but preserves project binding", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(SubrequestResilientProjectGuard.prototype, "fetch")
    .mockImplementationOnce(async () => { await pending; return Response.json({ status: "done" }); });
  const receipt = { status: "committed", project_id: "PRJ-0007", transaction_id: "TXN-CANONICAL" };
  const canonical = vi.fn().mockResolvedValue(receipt);
  const guard = Object.assign(Object.create(SearchSyncProjectGuard.prototype), {
    ctx: { id: { name: "PRJ-0007" } },
    searchQueue: Promise.resolve(),
    searchQueueDepth: 0,
    handleReceiptRead: vi.fn().mockResolvedValue(Response.json({ error: "receipt_not_found" }, { status: 404 })),
    readBoundedRequestStatusReceipt: canonical
  }) as SearchSyncProjectGuard;
  const finalization = guard.fetch(new Request("https://guard.internal/finalize-materialization", { method: "POST" }));
  try {
    await vi.waitFor(() => expect((guard as unknown as { searchQueueDepth: number }).searchQueueDepth).toBe(1));
    const wrongProject = await guard.fetch(new Request(
      "https://guard.internal/receipt?kind=transaction&request_id=TXN-CANONICAL&project_id=PRJ-9999"
    ));
    expect(wrongProject.status).toBe(404);
    expect(canonical).not.toHaveBeenCalled();
    const response = await guard.fetch(new Request(
      "https://guard.internal/receipt?kind=transaction&request_id=TXN-CANONICAL"
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(receipt);
    expect(canonical).toHaveBeenCalledWith("PRJ-0007", "transaction", "TXN-CANONICAL");
  } finally {
    release();
    await finalization;
  }
});

it("rejects an unsupported execution kind before reading its journal while idle", async () => {
  const status = vi.spyOn(ExecutionJournal.prototype, "status").mockResolvedValue(null);
  const guard = Object.assign(Object.create(ProjectGuard.prototype), {
    ctx: { id: { name: "PRJ-8420" } },
    persistence: {},
    queue: Promise.resolve(),
    queueDepth: 0
  }) as ProjectGuard;

  const response = await guard.fetch(new Request(
    "https://guard.internal/execution-status?kind=not-real&request_id=REQ-8420"
  ));

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ error: "execution_kind_invalid" });
  expect(status).not.toHaveBeenCalled();
});

it("reports artifact intent consistently in additive and legacy recovery views", async () => {
  vi.spyOn(ExecutionJournal.prototype, "status").mockResolvedValue(null);
  vi.spyOn(MutationGateRepository.prototype, "readArtifactIntent").mockResolvedValue({} as never);
  const guard = Object.assign(Object.create(ProjectGuard.prototype), {
    ctx: {
      id: { name: "PRJ-8421" },
      storage: { sql: { exec: vi.fn(() => ({ toArray: () => [] })) }, getAlarm: vi.fn().mockResolvedValue(null) }
    },
    readRequestStatusReceipt: vi.fn().mockResolvedValue(null)
  }) as ProjectGuard;
  const read = guard as unknown as {
    handleRequestStatus(url: URL, correlationId: string, runtime: unknown, repository: unknown): Promise<Response>;
  };

  const response = await read.handleRequestStatus(
    new URL("https://guard.internal/request-status?kind=artifact&request_id=ART-8421"),
    "corr-8421",
    { objects: {} },
    {}
  );

  expect(await response.json()).toMatchObject({
    status: "recovery_unavailable",
    observation: { recovery: { durable_intent: true } },
    recovery: { durable_intent: true }
  });
});

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
  const handleRequestStatus = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ status: "committed" })));
  const handleReceiptRead = vi.fn()
    .mockResolvedValueOnce(Response.json({ error: "receipt_not_found" }, { status: 404 }))
    .mockResolvedValue(Response.json({ status: "committed" }));
  const guard = Object.assign(Object.create(ProjectGuard.prototype), {
    ctx: { id: { name: "PRJ-0007" } },
    persistence: {},
    queue: Promise.resolve(),
    queueDepth: 0,
    handleRequestStatus,
    readBoundedRequestStatus: vi.fn(() => handleRequestStatus(new URL("https://guard.internal/request-status"))),
    handleReceiptRead
  }) as ProjectGuard;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const serialized = (guard as unknown as { serialize<T>(operation: () => Promise<T>): Promise<T> }).serialize(async () => {
    await pending;
    return "written";
  });
  try {
    for (const [path, expectedStatusReads] of [
      ["/request-status?kind=transaction&request_id=TXN-1", 1],
      ["/receipt?kind=transaction&request_id=TXN-1", 1],
      ["/execution-status?kind=transaction&request_id=TXN-1", 2]
    ] as const) {
      const response = await guard.fetch(new Request(`https://guard.internal${path}`));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ code: "PROJECT_OS_READ_BUSY" });
      expect(handleRequestStatus).toHaveBeenCalledTimes(expectedStatusReads);
    }
    expect(handleReceiptRead).toHaveBeenCalledOnce();
  } finally {
    release();
    await serialized;
  }
  const after = await guard.fetch(new Request("https://guard.internal/request-status?kind=transaction&request_id=TXN-1"));
  await expect(after.json()).resolves.toMatchObject({ status: "committed" });
});

it("returns a locally committed receipt before waiting on an unrelated long mutation", async () => {
  const receipt = {
    schema_version: "1.0",
    transaction_id: "TXN-8405",
    project_id: "PRJ-8405",
    status: "committed",
    previous_revision: 1,
    new_revision: 2
  };
  const guard = Object.assign(Object.create(ProjectGuard.prototype), {
    ctx: {
      id: { name: "PRJ-8405" },
      storage: {
        sql: {
          exec: vi.fn(() => ({ toArray: () => [{ receipt_json: JSON.stringify(receipt) }] }))
        }
      }
    },
    queue: new Promise<void>(() => {}),
    queueDepth: 1
  }) as ProjectGuard;

  const response = await guard.fetch(new Request(
    "https://guard.internal/receipt?kind=transaction&request_id=TXN-8405"
  ));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(receipt);
});

it("returns a canonical committed receipt on cache miss while unrelated project work is busy", async () => {
  const projectId = "PRJ-8409";
  const requestId = "TXN-8409-REMOTE-RECEIPT";
  const mock = installDropboxMock();
  const receipt = {
    schema_version: "1.0", transaction_id: requestId, project_id: projectId, status: "committed",
    previous_revision: 7, new_revision: 8
  };
  mock.files.set(machineReceiptPath(requestId), JSON.stringify(receipt));
  mock.files.set(receiptPath(requestId), JSON.stringify(receipt));
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
  await runInDurableObject(guard, (instance) => {
    (instance as unknown as { queueDepth: number }).queueDepth = 1;
  });

  const response = await guard.fetch(new Request(`https://project-guard.internal/receipt?kind=transaction&request_id=${requestId}`));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(receipt);
  expect(mock.uploadCalls).toHaveLength(0);
});

it("returns an exactly bound terminal navigation conflict on a busy cold cache", async () => {
  const projectId = "PRJ-8416";
  const requestId = "DOCREQ-NAV-CONFLICT-CACHE-MISS-8416";
  const mock = installDropboxMock();
  const runtime = createProductionPersistence(env as unknown as Env, projectId);
  const request = {
    operation: "navigation.reconcile", request_id: requestId, project_id: projectId,
    zone: "WORKING", expected_project_revision: 1, expected_generation: 0,
    expected_index: null, created_at: "2026-09-25T10:00:00.000Z"
  };
  const requestJson = canonicalJson(request);
  const requestHash = await executionHash(request);
  const receiptPath = `${machineDocumentRoot(projectId)}/requests/${requestId}/receipt.json`;
  const receipt = {
    operation: "navigation.reconcile", request_id: requestId, project_id: projectId,
    status: "conflict", execution_status: "conflict", code: "navigation_snapshot_changed"
  };
  const ledger = new ManagedDocumentRequestLedger(runtime.objects);
  await ledger.ensureIntent(projectId, requestId, requestJson);
  const admission: ExecutionAdmission = {
    project_id: projectId, operation: "navigation.reconcile", request_id: requestId, kind: "document",
    request_hash: requestHash, actor: { actor_id: "qualification-fixture", authority: "test" },
    global_revision: 1, project_revision: 1,
    ruleset: { digest: "a".repeat(64), rules: [], global_revision: 1, project_revision: 1 },
    verdict: "allow", results: [], gaps: [], deferred_rules: [],
    resources: [{ resource_id: "navigation:WORKING", resource_type: "navigation", zone: "WORKING", version: "0" }]
  };
  const journal = new ExecutionJournal(runtime, projectId, "document", requestId);
  await journal.commit(admission, null);
  await ledger.writeReceipt(projectId, requestId, requestJson, canonicalJson(receipt));
  await journal.recordReceipt("conflict", receiptPath);

  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
  const previousQueueDepth = await runInDurableObject(guard, (instance) => {
    const subject = instance as unknown as { queueDepth: number };
    const previous = subject.queueDepth;
    subject.queueDepth = 1;
    return previous;
  });
  try {
    const response = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${requestId}`);
    const body = await response.json<Record<string, any>>();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "conflict", receipt, execution: { status: "conflict", terminal: true }, observation: { freshness: "verified" } });

    const mismatched = { ...body, execution: { ...body.execution, receipt_ref: `${receiptPath}.other` } };
    await runInDurableObject(guard, (instance) => {
      const subject = instance as unknown as { readBoundedRequestStatus: () => Promise<Response> };
      vi.spyOn(subject, "readBoundedRequestStatus").mockResolvedValue(Response.json(mismatched));
    });
    const uploadsBeforeRejectedLookup = mock.uploadCalls.length;
    const rejected = await guard.fetch(`https://project-guard.internal/request-status?kind=document&request_id=${requestId}`);
    expect(rejected.status).toBe(503);
    await expect(rejected.json()).resolves.toMatchObject({ status: "unknown", code: "PROJECT_OS_READ_BUSY" });
    expect(mock.uploadCalls).toHaveLength(uploadsBeforeRejectedLookup);
  } finally {
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { queueDepth: number }).queueDepth = previousQueueDepth;
    });
  }
});

it("returns an identity-bound unknown observation when a busy receipt lookup cannot prove absence", async () => {
  const projectId = "PRJ-8410";
  const requestId = "TXN-8410-UNKNOWN";
  const mock = installDropboxMock({ faults: [{
    endpoint: "/2/files/download", occurrence: 1,
    status: 503, error_summary: "temporarily/unavailable"
  }] });
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
  await runInDurableObject(guard, (instance) => {
    (instance as unknown as { queueDepth: number }).queueDepth = 1;
  });

  const response = await guard.fetch(`https://project-guard.internal/receipt?kind=transaction&request_id=${requestId}`, {
    headers: { "x-project-os-correlation-id": "corr-8410" }
  });
  const body = await response.json<Record<string, unknown>>();

  expect(response.status).toBe(503);
  expect(body).toMatchObject({
    project_id: projectId, kind: "transaction", request_id: requestId, status: "unknown",
    correlation_id: "corr-8410",
    observation: { status: "unknown", recovery: { action: "check_status" } }
  });
  expect(mock.uploadCalls).toHaveLength(0);
  expect(mock.downloadCalls.length).toBeGreaterThan(0);
});

it("bounds a stalled canonical receipt read and still returns unknown, never absence", async () => {
  const projectId = "PRJ-8413";
  const requestId = "TXN-8413-SLOW";
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const mock = installDropboxMock({ faults: [{ endpoint: "/2/files/download", occurrence: 1, status: 503, error_summary: "slow/provider", pause: pending }] });
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
  await runInDurableObject(guard, (instance) => {
    const subject = instance as unknown as { queueDepth: number; observationReadDeadlineMs(): number };
    subject.queueDepth = 1;
    vi.spyOn(subject, "observationReadDeadlineMs").mockReturnValue(20);
  });
  let finished = false;
  const response = guard.fetch(`https://project-guard.internal/receipt?kind=transaction&request_id=${requestId}`)
    .then((value) => { finished = true; return value; });
  try {
    await vi.waitFor(() => expect(finished).toBe(true), { timeout: 2_500 });
    expect((await response).status).toBe(503);
    await expect((await response).json()).resolves.toMatchObject({ status: "unknown", request_id: requestId });
    expect(mock.uploadCalls).toHaveLength(0);
  } finally {
    release();
  }
});

it("adds a correlated observation without changing legacy request-status fields or writing", async () => {
  const projectId = "PRJ-8411";
  const requestId = "TXN-8411-ABSENT";
  const mock = installDropboxMock();
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);

  const response = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${requestId}`, {
    headers: { "x-project-os-correlation-id": "corr-8411" }
  });
  const body = await response.json<Record<string, unknown>>();

  expect(response.status).toBe(200);
  expect(body).toMatchObject({
    project_id: projectId, kind: "transaction", request_id: requestId, status: "not_received",
    observation: {
      project_id: projectId, kind: "transaction", request_id: requestId,
      status: "not_received", correlation_id: "corr-8411",
      recovery: { action: "retry_same_request", owner: "client" }
    }
  });
  expect(mock.uploadCalls).toHaveLength(0);
});

it("refuses provider receipts bound to a different project or request instead of reporting absence", async () => {
  const projectId = "PRJ-8412";
  const projectMismatch = "TXN-8412-WRONG-PROJECT";
  const requestMismatch = "TXN-8412-WRONG-REQUEST";
  const mock = installDropboxMock();
  const otherProject = {
    schema_version: "1.0", transaction_id: projectMismatch, project_id: "PRJ-9999", status: "committed",
    previous_revision: 1, new_revision: 2
  };
  const otherRequest = {
    schema_version: "1.0", transaction_id: "TXN-8412-DIFFERENT", project_id: projectId, status: "committed",
    previous_revision: 1, new_revision: 2
  };
  for (const id of [projectMismatch, requestMismatch]) {
    mock.files.set(machineReceiptPath(id), JSON.stringify(id === projectMismatch ? otherProject : otherRequest));
    mock.files.set(receiptPath(id), JSON.stringify(id === projectMismatch ? otherProject : otherRequest));
  }
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);

  const mismatchedProject = await guard.fetch(
    `https://project-guard.internal/receipt?kind=transaction&request_id=${projectMismatch}&project_id=PRJ-9999`
  );
  expect(mismatchedProject.status).toBe(404);
  await expect(mismatchedProject.json()).resolves.toEqual({ error: "receipt_not_found" });
  const mismatchedStatus = await guard.fetch(
    `https://project-guard.internal/request-status?kind=transaction&request_id=${projectMismatch}&project_id=PRJ-9999`
  );
  expect(mismatchedStatus.status).toBe(404);
  await expect(mismatchedStatus.json()).resolves.toEqual({ error: "request_identity_mismatch" });

  for (const requestId of [projectMismatch, requestMismatch]) {
    const response = await guard.fetch(`https://project-guard.internal/request-status?kind=transaction&request_id=${requestId}`);
    const body = await response.json<Record<string, unknown>>();
    if (requestId === projectMismatch) {
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        project_id: projectId, request_id: requestId, status: "not_received",
        observation: { status: "not_received" }
      });
    } else {
      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        project_id: projectId, request_id: requestId, status: "unknown",
        observation: { status: "unknown", code: "request_status_unavailable" }
      });
    }
    expect(body).not.toHaveProperty("receipt");
  }
  expect(mock.uploadCalls).toHaveLength(0);
});

it("does not return local receipts missing project or request identity bindings", async () => {
  const projectId = "PRJ-8414";
  const requestId = "TXN-8414-MISSING-IDENTITY";
  const receiptWithoutProject = {
    transaction_id: requestId, status: "committed", previous_revision: 1, new_revision: 2
  };
  const guard = Object.assign(Object.create(ProjectGuard.prototype), {
    ctx: {
      id: { name: projectId },
      storage: {
        sql: {
          exec: vi.fn(() => ({ toArray: () => [{ receipt_json: JSON.stringify(receiptWithoutProject) }] }))
        }
      }
    },
    queueDepth: 0
  }) as ProjectGuard;

  const response = await guard.fetch(new Request(`https://project-guard.internal/receipt?kind=transaction&request_id=${requestId}`));

  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({ error: "receipt_identity_conflict" });
});

it("keeps canonical receipts with missing identity fields unknown rather than absent", async () => {
  const projectId = "PRJ-8415";
  const transactionId = "TXN-8415-MISSING-PROJECT";
  const artifactId = "ART-8415-MISSING-PROJECT";
  const mock = installDropboxMock();
  mock.files.set(machineReceiptPath(transactionId), JSON.stringify({
    transaction_id: transactionId, status: "committed", previous_revision: 1, new_revision: 2
  }));
  mock.files.set(receiptPath(transactionId), JSON.stringify({
    transaction_id: transactionId, status: "committed", previous_revision: 1, new_revision: 2
  }));
  mock.files.set(machineArtifactReceiptPath(artifactId), JSON.stringify({
    request_id: artifactId, status: "committed"
  }));
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);

  for (const [kind, requestId] of [["transaction", transactionId], ["artifact", artifactId]] as const) {
    const response = await guard.fetch(
      `https://project-guard.internal/request-status?kind=${kind}&request_id=${requestId}`
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      project_id: projectId, kind, request_id: requestId, status: "unknown",
      observation: { status: "unknown", code: "request_status_unavailable" }
    });
  }
  expect(mock.uploadCalls).toHaveLength(0);
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

it("coalesces concurrent context reads instead of rejecting a fresh read already in progress", async () => {
  const projectId = "PRJ-8400";
  const mock = installDropboxMock();
  const record = commitFixture(projectId, 1)[0]!;
  mock.files.set(machineCommitRecordPath(projectId, 1), JSON.stringify(record));
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
  let release!: (state: ProjectState) => void;
  const delayedSnapshot = new Promise<ProjectState>((resolve) => { release = resolve; });
  let readSnapshot!: ReturnType<typeof vi.spyOn>;
  await runInDurableObject(guard, (instance) => {
    const subject = instance as unknown as {
      env: Env;
      repository: ProjectRepository;
      canonicalContextReadDeadlineMs(): number;
      canonicalContextRepository(projectId: string, scope: ProviderRequestScope): ProjectRepository;
    };
    subject.env.MUTATION_CONTEXT_SIGNING_KEY = "read-trace-context";
    vi.spyOn(subject, "canonicalContextReadDeadlineMs").mockReturnValue(100);
    vi.spyOn(subject, "canonicalContextRepository").mockReturnValue(subject.repository);
    readSnapshot = vi.spyOn(subject.repository, "readProjectState").mockImplementation(() => delayedSnapshot);
  });
  const first = guard.fetch("https://project-guard.internal/mutation-context");
  try {
    await vi.waitFor(() => expect(readSnapshot).toHaveBeenCalledOnce());
    const second = guard.fetch("https://project-guard.internal/mutation-context");
    expect(readSnapshot).toHaveBeenCalledOnce();
    release(record.state);
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  } finally {
    release(record.state);
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
  let deadlineMs = 20;

  await runInDurableObject(guard, async (instance) => {
    const subject = instance as unknown as {
      env: Env;
      repository: ProjectRepository;
      canonicalContextReadDeadlineMs(): number;
      canonicalContextRepository(projectId: string, scope: ProviderRequestScope): ProjectRepository;
    };
    subject.env.MUTATION_CONTEXT_SIGNING_KEY = "read-trace-context";
    vi.spyOn(subject, "canonicalContextReadDeadlineMs").mockImplementation(() => deadlineMs);
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

  deadlineMs = 5_000;
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

it("does not sign a partial commit suffix after the shared provider call budget is exhausted", async () => {
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
  expect(mock.downloadCalls.filter((path) => path === machineStatePath(projectId)
    || path.startsWith(machineCommitRecordPath(projectId, 1).replace(/1\.json$/, ""))).length).toBeLessThanOrEqual(32);
  await expect(response.json()).resolves.toMatchObject({ error: "canonical_unavailable" });
});

it("resumes bounded canonical suffix reads from a proven technical checkpoint", async () => {
  const projectId = "PRJ-8408";
  const records = commitFixture(projectId, 129);
  let checkpoint: unknown;
  let providerCalls = 0;
  let snapshotReads = 0;
  const localBaseline = records[0]!.state;
  const budget = { calls: 0, maxCalls: 32 };
  const putCheckpoint = vi.fn(async (_key: string, value: unknown) => { checkpoint = value; });
  const repository = {
    readProjectState: vi.fn(async () => {
      providerCalls += 1;
      budget.calls += 1;
      snapshotReads += 1;
      return records[0]!.state;
    }),
    readCommitRecord: vi.fn(async (_id: string, revision: number) => {
      providerCalls += 1;
      budget.calls += 1;
      return records[revision - 1] ?? null;
    })
  } as unknown as ProjectRepository;
  const subject = Object.assign(Object.create(ProjectGuard.prototype), {
    layoutMode: "v2",
    contextVerifiedState: localBaseline,
    contextCheckpointWriteQueue: Promise.resolve(),
    loadState: () => localBaseline,
    ctx: { storage: {
      get: vi.fn(async () => checkpoint),
      put: putCheckpoint
    } }
  }) as unknown as {
    readCanonicalState(repository: ProjectRepository, projectId: string, deadline: number, budget: { calls: number; maxCalls: number }): Promise<ProjectState | null>;
  };

  const reached: number[] = [];
  let result: ProjectState | null = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    budget.calls = 0;
    try {
      result = await subject.readCanonicalState(repository, projectId, Date.now() + 10_000, budget);
    } catch (error) {
      expect(error).toMatchObject({ message: "canonical_context_budget_exhausted" });
    }
    expect(budget.calls).toBeLessThanOrEqual(32);
    if (checkpoint && typeof checkpoint === "object") {
      reached.push((checkpoint as { revision: number }).revision);
    }
    if (result) break;
  }

  expect(result?.revision).toBe(129);
  expect(reached).toEqual([33, 64, 95, 126, 129]);
  expect(snapshotReads).toBe(0);
  expect(providerCalls).toBeLessThanOrEqual(32 * 5);

  const writesAfterCompletion = putCheckpoint.mock.calls.length;
  budget.calls = 0;
  await expect(subject.readCanonicalState(repository, projectId, Date.now() + 10_000, budget))
    .resolves.toMatchObject({ revision: 129 });
  expect(putCheckpoint).toHaveBeenCalledTimes(writesAfterCompletion);
});

it("reuses a locally proven context baseline on unchanged reads without downloading state again", async () => {
  const projectId = "PRJ-8406";
  const mock = installDropboxMock();
  const record = commitFixture(projectId, 1)[0]!;
  mock.files.set(machineCommitRecordPath(projectId, 1), JSON.stringify(record));
  mock.files.set(machineStatePath(projectId), JSON.stringify(record.state));
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);

  await runInDurableObject(guard, (instance) => {
    (instance as unknown as { env: Env }).env.MUTATION_CONTEXT_SIGNING_KEY = "read-trace-context";
  });

  const first = await guard.fetch("https://project-guard.internal/mutation-context");
  const second = await guard.fetch("https://project-guard.internal/mutation-context");

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(mock.downloadCalls.filter((path) => path === machineStatePath(projectId))).toHaveLength(1);

  await runInDurableObject(guard, (instance) => {
    (instance as unknown as { contextVerifiedState: ProjectState | null }).contextVerifiedState = null;
  });
  const afterEviction = await guard.fetch("https://project-guard.internal/mutation-context");
  expect(afterEviction.status).toBe(200);
  expect(mock.downloadCalls.filter((path) => path === machineStatePath(projectId))).toHaveLength(1);
  expect(mock.downloadCalls.filter((path) => path === machineCommitRecordPath(projectId, 1))).toHaveLength(2);
});

it("uses the exact commit record instead of signing an altered canonical snapshot", async () => {
  const projectId = "PRJ-8408";
  const mock = installDropboxMock();
  const record = commitFixture(projectId, 1)[0]!;
  mock.files.set(machineCommitRecordPath(projectId, 1), JSON.stringify(record));
  mock.files.set(machineStatePath(projectId), JSON.stringify({ ...record.state, name: "Altered snapshot" }));
  const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
  await runInDurableObject(guard, (instance) => {
    (instance as unknown as { env: Env }).env.MUTATION_CONTEXT_SIGNING_KEY = "read-trace-context";
  });

  const response = await guard.fetch("https://project-guard.internal/mutation-context");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ canonical_state: record.state });
});

it("does not return an older context when a newer local commit lands during suffix verification", async () => {
  const projectId = "PRJ-8407";
  const records = commitFixture(projectId, 2);
  let localState = records[0]!.state;
  let release!: () => void;
  let markReadStarted!: () => void;
  const pendingRead = new Promise<void>((resolve) => { release = resolve; });
  const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
  const repository = {
    readProjectState: vi.fn().mockResolvedValue(records[0]!.state),
    readCommitRecord: vi.fn(async (_id: string, revision: number) => {
      if (revision === 2) {
        markReadStarted();
        await pendingRead;
      }
      return null;
    })
  } as unknown as ProjectRepository;
  const subject = Object.assign(Object.create(ProjectGuard.prototype), {
    layoutMode: "v2",
    contextVerifiedState: records[0]!.state,
    contextCheckpointWriteQueue: Promise.resolve(),
    persistence: {},
    loadState: () => localState,
    ctx: { storage: {
      transactionSync: (operation: () => void) => operation(),
      sql: { exec: vi.fn() },
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined)
    } }
  }) as unknown as {
    readCanonicalState(repository: ProjectRepository, projectId: string, deadline: number, budget: { calls: number; maxCalls: number }): Promise<ProjectState | null>;
    persistCommit(state: ProjectState, receipt: (typeof records)[number]["receipt"]): void;
  };

  const read = subject.readCanonicalState(repository, projectId, Date.now() + 2_000, { calls: 0, maxCalls: 32 });
  try {
    await readStarted;
    localState = records[1]!.state;
    subject.persistCommit(records[1]!.state, records[1]!.receipt);
    release();
    await expect(read).resolves.toMatchObject({ revision: 2, last_event_id: records[1]!.state.last_event_id });
  } finally {
    release();
  }
});
