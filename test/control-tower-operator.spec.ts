import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudflarePorts, runOperatorSubmission } from "../scripts/control-tower-operator.mjs";

const baseVersionId = "11111111-2222-4333-8444-555555555555";
const operatorVersionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const requestText = JSON.stringify({
  request_id: "working-20260910-0001",
  project_id: "PRJ-0007",
  operation: "working.write"
});

describe("Control Tower single-request operator bridge", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["context", "submit"]) ("times out a hanging %s call, aborts its shared signal, and still restores", async (boundary) => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const signals: AbortSignal[] = [];
    let restored = false;
    const pending = runOperatorSubmission({ kind: "document", project_id: "PRJ-0007", request: requestText }, {
      generateToken: () => "ephemeral-test-token",
      captureBaseDeployment: async () => ({ version_id: baseVersionId, percentage: 100 }),
      createOperatorVersion: async () => operatorVersionId,
      attachZeroTrafficVersion: async () => { calls.push("attach"); },
      health: async ({ overrideVersionId }) => ({ status: "ok", worker_version_id: restored ? baseVersionId : (overrideVersionId ?? baseVersionId) }),
      fetchContext: async ({ signal }) => {
        calls.push("context"); signals.push(signal);
        if (boundary === "context") return await new Promise(() => {});
        return { project_id: "PRJ-0007", signed: "context" };
      },
      submit: async ({ signal }) => {
        calls.push("submit"); signals.push(signal);
        return await new Promise(() => {});
      },
      restoreBaseDeployment: async () => { calls.push("restore"); restored = true; },
      tokenStatusOnBase: async () => 401
    });
    await vi.advanceTimersByTimeAsync(10_001);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    const result = await Promise.race([pending, Promise.resolve(null)]);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      status: boundary === "context" ? "not_submitted" : "unknown", project_id: "PRJ-0007", request_id: "working-20260910-0001",
      failed_boundary: boundary === "context" ? "context" : "submission",
      recovery: { preserve_request_id: true, check_status_before_retry: boundary === "submit" }
    });
    expect(signals.length).toBe(boundary === "context" ? 1 : 2);
    expect(signals.every((signal) => signal === signals[0])).toBe(true);
    expect(signals[0]!.aborted).toBe(true);
    expect(restored).toBe(true);
    expect(calls).toEqual(boundary === "context" ? ["attach", "context", "restore"] : ["attach", "context", "submit", "restore"]);
  }, 2000);

  it.each(["context", "submit"]) ("returns a recoverable identity-preserving outcome after %s failure and restores the base", async (boundary) => {
    const calls: string[] = [];
    let restored = false;
    const result = await runOperatorSubmission({ kind: "document", project_id: "PRJ-0007", request: requestText }, {
      generateToken: () => "ephemeral-test-token",
      captureBaseDeployment: async () => ({ version_id: baseVersionId, percentage: 100 }),
      createOperatorVersion: async () => operatorVersionId,
      attachZeroTrafficVersion: async () => { calls.push("attach"); },
      health: async ({ overrideVersionId }) => ({ status: "ok", worker_version_id: restored ? baseVersionId : (overrideVersionId ?? baseVersionId) }),
      fetchContext: async () => {
        calls.push("context");
        if (boundary === "context") throw new Error("provider secret context diagnostic");
        return { project_id: "PRJ-0007", signed: "context" };
      },
      submit: async () => {
        calls.push("submit");
        throw new Error("provider secret submit diagnostic");
      },
      restoreBaseDeployment: async () => { calls.push("restore"); restored = true; },
      tokenStatusOnBase: async () => 401
    });
    expect(result).toMatchObject({
      status: boundary === "context" ? "not_submitted" : "unknown", project_id: "PRJ-0007", request_id: "working-20260910-0001",
      failed_boundary: boundary === "context" ? "context" : "submission", recovery: { preserve_request_id: true, check_status_before_retry: boundary === "submit" }
    });
    expect(JSON.stringify(result)).not.toContain("provider secret");
    expect(calls).toEqual(boundary === "context" ? ["attach", "context", "restore"] : ["attach", "context", "submit", "restore"]);
  });

  it("submits through a zero-traffic version then restores the exact base deployment", async () => {
    const calls: string[] = [];
    let capturedToken = "";
    let restored = false;

    const result = await runOperatorSubmission(
      {
        kind: "document",
        project_id: "PRJ-0007",
        request: requestText
      },
      {
        generateToken: () => "ephemeral-test-token",
        captureBaseDeployment: async () => ({ version_id: baseVersionId, percentage: 100 }),
        createOperatorVersion: async ({ token }) => {
          capturedToken = token;
          calls.push("create");
          return operatorVersionId;
        },
        attachZeroTrafficVersion: async ({ baseVersionId: base, operatorVersionId: operator }) => {
          calls.push(`attach:${base}:${operator}`);
        },
        health: async ({ overrideVersionId }) => {
          calls.push(`health:${overrideVersionId ?? "base"}`);
          return {
            status: "ok",
            worker_version_id: restored ? baseVersionId : (overrideVersionId ?? baseVersionId)
          };
        },
        fetchContext: async ({ projectId, token, operatorVersionId: operator }) => {
          calls.push(`context:${projectId}:${operator}`);
          expect(token).toBe("ephemeral-test-token");
          return { project_id: projectId, signed: "fresh-context" };
        },
        submit: async ({ request, context, token, operatorVersionId: operator }) => {
          calls.push(`submit:${operator}`);
          expect(request).toBe(requestText);
          expect(context).toEqual({ project_id: "PRJ-0007", signed: "fresh-context" });
          expect(token).toBe("ephemeral-test-token");
          return { status: "committed", project_id: "PRJ-0007", request_id: "working-20260910-0001" };
        },
        restoreBaseDeployment: async ({ versionId }) => {
          calls.push(`restore:${versionId}`);
          restored = true;
        },
        tokenStatusOnBase: async ({ token }) => {
          expect(token).toBe("ephemeral-test-token");
          return 401;
        }
      }
    );

    expect(capturedToken).toBe("ephemeral-test-token");
    expect(calls).toEqual([
      "create",
      `attach:${baseVersionId}:${operatorVersionId}`,
      "health:base",
      `health:${operatorVersionId}`,
      "context:PRJ-0007:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "submit:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      `restore:${baseVersionId}`,
      "health:base",
      `health:${operatorVersionId}`
    ]);
    expect(result).toEqual({
      status: "committed",
      project_id: "PRJ-0007",
      request_id: "working-20260910-0001",
      base_version_id: baseVersionId
    });
  });

  it("rejects an input with unknown fields before creating an operator version", async () => {
    let captured = false;

    await expect(runOperatorSubmission(
      {
        kind: "document",
        project_id: "PRJ-0007",
        request: requestText,
        untrusted: true
      } as unknown as Parameters<typeof runOperatorSubmission>[0],
      {
        captureBaseDeployment: async () => {
          captured = true;
          return { version_id: baseVersionId, percentage: 100 };
        }
      }
    )).rejects.toThrow("operator input contains unknown fields");

    expect(captured).toBe(false);
  });

  it("restores production through the base-only Cloudflare deployment API", async () => {
    const requests: Request[] = [];
    const ports = createCloudflarePorts({
      accountId: "account-123",
      apiToken: "test-api-token",
      workerName: "project-os-guard",
      projectOsUrl: "https://project-os.example",
      fetch: async (request) => {
        requests.push(request);
        return Response.json({ success: true });
      },
      runCommand: async () => ""
    });

    await ports.restoreBaseDeployment({ versionId: baseVersionId });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/account-123/workers/scripts/project-os-guard/deployments?force=true");
    expect(requests[0].headers.get("authorization")).toBe("Bearer test-api-token");
    expect(await requests[0].json()).toEqual({
      strategy: "percentage",
      versions: [{ version_id: baseVersionId, percentage: 100 }],
      annotations: { "workers/message": "Restore sole base after governed operator submission" }
    });
  });

  it("captures only a single 100% base version from Cloudflare", async () => {
    const ports = createCloudflarePorts({
      accountId: "account-123", apiToken: "test-api-token", workerName: "project-os-guard", projectOsUrl: "https://project-os.example",
      fetch: async () => Response.json({ result: { deployments: [{ versions: [{ version_id: baseVersionId, percentage: 100 }] }] } }),
      runCommand: async () => ""
    });
    await expect(ports.captureBaseDeployment()).resolves.toEqual({ version_id: baseVersionId, percentage: 100 });
  });
});
