import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { machineCommitRecordPath, machineDocumentRoot, machineStatePath } from "../src/persistence/layout";
import { commitFixture } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import { encodeAdmission } from "../src/admission/transport";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { ExecutionJournal } from "../src/execution/journal";
import { ZoneNavigationSources } from "../src/documents/zone-navigation-sources";

const testEnv = env as unknown as Env;

afterEach(() => vi.restoreAllMocks());

async function setup(projectId: string) {
  const mock = installDropboxMock();
  const record = commitFixture(projectId, 1)[0]!;
  mock.files.set(machineCommitRecordPath(projectId, 1), JSON.stringify(record));
  mock.files.set(machineStatePath(projectId), JSON.stringify(record.state));
  const guard = testEnv.PROJECT_GUARD.getByName(projectId);
  await runInDurableObject(guard, (instance) => Object.assign((instance as unknown as { env: Env }).env, {
    PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectId]: "strict" }),
    MUTATION_CONTEXT_SIGNING_KEY: "refresh-currentness-context",
    RULE_ADMISSION_SIGNING_KEY: "refresh-currentness-admission"
  }));
  await bootstrapRuleAdmissionGovernance(testEnv, "refresh-currentness-admission", projectId);
  return { guard, mock };
}

async function publishInitialNavigation(guard: ReturnType<typeof testEnv.PROJECT_GUARD.getByName>, projectId: string, requestId: string) {
  const request = {
    operation: "navigation.reconcile" as const, request_id: requestId, project_id: projectId,
    zone: "WORKING" as const, expected_project_revision: 1, expected_generation: 0,
    expected_index: null, created_at: "2026-10-02T10:00:00.000Z"
  };
  const context = await (await guard.fetch("https://project-guard.internal/mutation-context")).json<{ context: never }>();
  expect((await guard.fetch("https://project-guard.internal/document", {
    method: "POST", body: JSON.stringify(encodeAdmission(request, context.context))
  })).status).toBe(202);

  const materialization = testEnv.MATERIALIZATION_GUARD.getByName(projectId);
  let prepared: any;
  for (let attempt = 0; attempt < 16; attempt++) {
    prepared = await runInDurableObject(materialization, (instance) =>
      (instance as any).serialize(() => (instance as any).runNavigationWorkSlice())
    );
    if (prepared?.publish) break;
  }
  expect(prepared?.publish).toBe(true);

  let response: Response | undefined;
  for (let attempt = 0; attempt < 16; attempt++) {
    response = await guard.fetch("https://project-guard.internal/navigation-publish", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(prepared.ref)
    });
    if (response.status !== 503) break;
  }
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({ status: "committed" });
  return { request, ref: prepared.ref };
}

async function consumeOneCleanSourceGeneration(projectId: string) {
  const sources = new ZoneNavigationSources(createProductionPersistence(testEnv, projectId));
  expect(await sources.markCatalogReady(projectId, "WORKING", 0)).toBe(true);
  const resourceId = "head:DOC-7123456789ABCDEF01234567";
  const ticket = await sources.beginHeadWrite(projectId, "WORKING", resourceId);
  expect(ticket?.generation).toBe(1);
  await sources.completeHeadWrite(ticket, null);
  expect(await sources.finishDirty(projectId, "WORKING", resourceId, null)).toBe(true);
  expect(await sources.readState(projectId, "WORKING")).toMatchObject({ generation: 1, adopted: true, in_flight_resource_ids: [] });
  expect((await sources.listDirtyPage(projectId, "WORKING", null, 1)).resource_ids).toEqual([]);
  expect((await sources.compactCatalogManifest(projectId, "WORKING"))?.ready_generation).toBe(1);
  return sources;
}

async function insertRefreshRow(guard: ReturnType<typeof testEnv.PROJECT_GUARD.getByName>, zone: "WORKING", generation: number) {
  await runInDurableObject(guard, (_instance, storage) => {
    storage.storage.sql.exec(
      "INSERT INTO navigation_refresh_outbox (zone, source_generation, request_json) VALUES (?, ?, NULL)", zone, generation
    );
  });
}

async function refreshRowCount(guard: ReturnType<typeof testEnv.PROJECT_GUARD.getByName>, zone: "WORKING") {
  return runInDurableObject(guard, (_instance, storage) => Number(storage.storage.sql.exec<{ count: number }>(
    "SELECT COUNT(*) AS count FROM navigation_refresh_outbox WHERE zone = ?", zone
  ).toArray()[0]?.count ?? 0));
}

describe("navigation refresh outbox currentness", () => {
  it("starts a governed refresh when adopted compact readiness is current but the published head is stale", async () => {
    const projectId = "PRJ-8490";
    const { guard, mock } = await setup(projectId);
    await publishInitialNavigation(guard, projectId, "DOCREQ-NAV-CURRENTNESS-BASELINE-8490");
    const sources = await consumeOneCleanSourceGeneration(projectId);
    const beforeHead = mock.files.get(`${machineDocumentRoot(projectId)}/navigation/WORKING/head.json`);
    expect(beforeHead).toBeDefined();
    expect(JSON.parse(beforeHead!).source_snapshot_id).toBe("source:0");

    await insertRefreshRow(guard, "WORKING", 1);
    await runInDurableObject(guard, (instance) => (instance as any).resumePendingNavigationRefreshes());

    const autoRequestId = "DOCREQ-NAV-AUTO-WORKING-S1-R1-G1";
    expect(mock.files.has(`${machineDocumentRoot(projectId)}/requests/${autoRequestId}/intent.json`)).toBe(true);
    expect(JSON.parse(mock.files.get(`${machineDocumentRoot(projectId)}/navigation/WORKING/head.json`)!).source_snapshot_id).toBe("source:0");
    expect(await sources.readState(projectId, "WORKING")).toMatchObject({ generation: 1, adopted: true });
    expect(await refreshRowCount(guard, "WORKING")).toBe(0);
  });

  it("clears an adopted clean row only after the current head and physical publication verify", async () => {
    const projectId = "PRJ-8491";
    const { guard } = await setup(projectId);
    const { request } = await publishInitialNavigation(guard, projectId, "DOCREQ-NAV-CURRENTNESS-CURRENT-8491");
    const sources = new ZoneNavigationSources(createProductionPersistence(testEnv, projectId));
    await insertRefreshRow(guard, "WORKING", 0);

    await runInDurableObject(guard, (instance) => (instance as any).resumePendingNavigationRefreshes());

    expect(await refreshRowCount(guard, "WORKING")).toBe(0);
    expect(await sources.readState(projectId, "WORKING")).toMatchObject({ generation: 0, adopted: true });
    expect(await new ExecutionJournal(createProductionPersistence(testEnv, projectId), projectId, "document", request.request_id).readAdmission()).not.toBeNull();
  });

  it("retains and retries a current-source row when publication proof is missing", async () => {
    const projectId = "PRJ-8492";
    const { guard, mock } = await setup(projectId);
    const { request } = await publishInitialNavigation(guard, projectId, "DOCREQ-NAV-CURRENTNESS-MISSING-8492");
    const journal = new ExecutionJournal(createProductionPersistence(testEnv, projectId), projectId, "document", request.request_id);
    mock.files.delete(`${await journal.root()}/navigation-progress.json`);
    await insertRefreshRow(guard, "WORKING", 0);

    await runInDurableObject(guard, (instance) => (instance as any).resumePendingNavigationRefreshes());

    expect(await refreshRowCount(guard, "WORKING")).toBe(1);
    expect(await runInDurableObject(guard, (_instance, storage) => storage.storage.getAlarm())).not.toBeNull();
    expect(mock.files.has(`${machineDocumentRoot(projectId)}/requests/DOCREQ-NAV-AUTO-WORKING-S0-R1-G1/intent.json`)).toBe(false);
  });

  it("retains and retries when the head request binding is wrong", async () => {
    const projectId = "PRJ-8496";
    const { guard, mock } = await setup(projectId);
    await publishInitialNavigation(guard, projectId, "DOCREQ-NAV-CURRENTNESS-WRONG-8496");
    const headPath = `${machineDocumentRoot(projectId)}/navigation/WORKING/head.json`;
    const head = JSON.parse(mock.files.get(headPath)!) as Record<string, unknown>;
    head.source_request_id = "DOCREQ-NAV-OTHER-PROJECT-8496";
    mock.files.set(headPath, JSON.stringify(head));
    await insertRefreshRow(guard, "WORKING", 0);

    await runInDurableObject(guard, (instance) => (instance as any).resumePendingNavigationRefreshes());

    expect(await refreshRowCount(guard, "WORKING")).toBe(1);
    expect(await runInDurableObject(guard, (_instance, storage) => storage.storage.getAlarm())).not.toBeNull();
    expect(mock.files.has(`${machineDocumentRoot(projectId)}/requests/DOCREQ-NAV-AUTO-WORKING-S0-R1-G1/intent.json`)).toBe(false);
  });

  it("retains the row without downloading an oversized publication head", async () => {
    const projectId = "PRJ-8497";
    const { guard, mock } = await setup(projectId);
    await publishInitialNavigation(guard, projectId, "DOCREQ-NAV-CURRENTNESS-OVERSIZE-8497");
    const headPath = `${machineDocumentRoot(projectId)}/navigation/WORKING/head.json`;
    const head = mock.files.get(headPath)!;
    mock.files.set(headPath, `${head}${" ".repeat(128_001)}`);
    await insertRefreshRow(guard, "WORKING", 0);
    const downloadsBefore = mock.downloadCalls.length;

    await runInDurableObject(guard, (instance) => (instance as any).resumePendingNavigationRefreshes());

    expect(await refreshRowCount(guard, "WORKING")).toBe(1);
    expect(await runInDurableObject(guard, (_instance, storage) => storage.storage.getAlarm())).not.toBeNull();
    expect(mock.downloadCalls.slice(downloadsBefore)).not.toContain(headPath);
  });

  it("waits for an in-flight writer without clearing the refresh row", async () => {
    const projectId = "PRJ-8493";
    const { guard } = await setup(projectId);
    await publishInitialNavigation(guard, projectId, "DOCREQ-NAV-CURRENTNESS-FLIGHT-8493");
    const sources = new ZoneNavigationSources(createProductionPersistence(testEnv, projectId));
    const resourceId = "head:DOC-8123456789ABCDEF01234567";
    const ticket = await sources.beginHeadWrite(projectId, "WORKING", resourceId);
    expect(ticket?.generation).toBe(1);
    await insertRefreshRow(guard, "WORKING", 1);

    await runInDurableObject(guard, (instance) => (instance as any).resumePendingNavigationRefreshes());

    expect(await refreshRowCount(guard, "WORKING")).toBe(1);
    expect(await runInDurableObject(guard, (_instance, storage) => storage.storage.getAlarm())).not.toBeNull();
    expect(await sources.readState(projectId, "WORKING")).toMatchObject({ generation: 1, in_flight_resource_ids: [resourceId] });
  });

  it("keeps stale-head refresh work isolated by project", async () => {
    const projectA = "PRJ-8494";
    const { guard: guardA, mock } = await setup(projectA);
    await publishInitialNavigation(guardA, projectA, "DOCREQ-NAV-CURRENTNESS-A-8494");
    await consumeOneCleanSourceGeneration(projectA);
    await insertRefreshRow(guardA, "WORKING", 1);

    const projectB = "PRJ-8495";
    const recordB = commitFixture(projectB, 1)[0]!;
    mock.files.set(machineCommitRecordPath(projectB, 1), JSON.stringify(recordB));
    mock.files.set(machineStatePath(projectB), JSON.stringify(recordB.state));
    const guardB = testEnv.PROJECT_GUARD.getByName(projectB);
    await runInDurableObject(guardB, (instance) => Object.assign((instance as unknown as { env: Env }).env, {
      PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [projectB]: "strict" }),
      MUTATION_CONTEXT_SIGNING_KEY: "refresh-currentness-context",
      RULE_ADMISSION_SIGNING_KEY: "refresh-currentness-admission"
    }));
    await bootstrapRuleAdmissionGovernance(testEnv, "refresh-currentness-admission", projectB);
    await publishInitialNavigation(guardB, projectB, "DOCREQ-NAV-CURRENTNESS-B-8495");
    await insertRefreshRow(guardB, "WORKING", 0);

    await runInDurableObject(guardA, (instance) => (instance as any).resumePendingNavigationRefreshes());
    await runInDurableObject(guardB, (instance) => (instance as any).resumePendingNavigationRefreshes());

    expect(mock.files.has(`${machineDocumentRoot(projectA)}/requests/DOCREQ-NAV-AUTO-WORKING-S1-R1-G1/intent.json`)).toBe(true);
    expect(await refreshRowCount(guardA, "WORKING")).toBe(0);
    expect(await refreshRowCount(guardB, "WORKING")).toBe(0);
    expect(mock.files.has(`${machineDocumentRoot(projectB)}/requests/DOCREQ-NAV-AUTO-WORKING-S0-R1-G1/intent.json`)).toBe(false);
  });
});
