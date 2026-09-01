import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Receipt } from "../src/domain/receipt";
import type { Env } from "../src/env";
import {
  machineCommitRecordPath,
  machineStatePath
} from "../src/persistence/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const projectId = "PRJ-0005";
const at = "2026-09-01T17:30:00+01:00";

async function submit(transaction: unknown): Promise<Receipt> {
  const response = await testEnv.PROJECT_GUARD.getByName(projectId).fetch("https://project-guard.internal/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(transaction)
  });
  expect(response.status).toBe(200);
  return response.json<Receipt>();
}

describe("ProjectGuard alarm / fast-forward serialization", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not let a transaction perform Dropbox fast-forward I/O while materialization alarm I/O is in flight", async () => {
    const mock = installDropboxMock();
    const stub = testEnv.PROJECT_GUARD.getByName(projectId);

    const created = await submit({
      schema_version: "1.0",
      transaction_id: "TXN-ALARMSERIAL-CREATE-0001",
      project_id: projectId,
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: {
        name: "Alarm Serialization",
        slug: "alarm-serialization",
        aliases: [],
        objective: "Keep provider I/O from concurrent ProjectGuard invocations serialized"
      }
    });
    expect(created).toMatchObject({ status: "committed", new_revision: 1 });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const second = await submit({
      schema_version: "1.0",
      transaction_id: "TXN-ALARMSERIAL-TASK-0002",
      project_id: projectId,
      base_revision: 1,
      operation: "task.create",
      created_at: at,
      payload: {
        task_id: "TASK-ALARMSERIAL002",
        title: "Schedule revision two materialization"
      }
    });
    expect(second).toMatchObject({ status: "committed", new_revision: 2 });

    const originalFetch = mock.spy.getMockImplementation();
    if (!originalFetch) throw new Error("Dropbox mock implementation unavailable");

    let releaseAlarm!: () => void;
    const alarmRelease = new Promise<void>((resolve) => { releaseAlarm = resolve; });
    let alarmReadEntered!: () => void;
    const alarmReadStarted = new Promise<void>((resolve) => { alarmReadEntered = resolve; });
    let alarmReadBlocked = false;
    let overlapObserved = false;

    mock.spy.mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const apiArg = request.headers.get("Dropbox-API-Arg");
      let apiPath: string | undefined;
      if (apiArg) {
        try {
          const parsed = JSON.parse(apiArg) as { path?: unknown };
          if (typeof parsed.path === "string") apiPath = parsed.path;
        } catch {
          // The underlying Dropbox mock remains authoritative for malformed input.
        }
      }

      if (
        !alarmReadBlocked
        && url.pathname === "/2/files/download"
        && apiPath === machineCommitRecordPath(projectId, 2)
      ) {
        alarmReadBlocked = true;
        alarmReadEntered();
        await alarmRelease;
      } else if (
        alarmReadBlocked
        && url.pathname === "/2/files/download"
        && apiPath === machineStatePath(projectId)
      ) {
        overlapObserved = true;
      }

      return originalFetch(input, init);
    });

    const alarm = runDurableObjectAlarm(stub);
    await alarmReadStarted;

    const transaction = submit({
      schema_version: "1.0",
      transaction_id: "TXN-ALARMSERIAL-CONSTRAINT-0003",
      project_id: projectId,
      base_revision: 2,
      operation: "constraint.add",
      created_at: at,
      payload: {
        constraint_id: "CON-ALARMSERIAL003",
        title: "Serialized provider I/O",
        description: "ProjectGuard provider I/O must not overlap a materialization alarm."
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(overlapObserved).toBe(false);

    releaseAlarm();
    expect(await alarm).toBe(true);
    expect(await transaction).toMatchObject({ status: "committed", previous_revision: 2, new_revision: 3 });
  });
});
