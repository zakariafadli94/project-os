import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { ProjectState } from "../src/domain/project-state";
import type { Receipt } from "../src/domain/receipt";
import { machineCommitRecordPath, machineStatePath } from "../src/persistence/layout";
import { commitFixture } from "./helpers/convergence-fixture";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";

afterEach(() => vi.restoreAllMocks());

function partitionProviderCallsByProject<T extends { endpoint: string; paths: string[] }>(calls: T[], projectId: string): [T[], T[]] {
  const scoped: T[] = [];
  const foreign: T[] = [];
  for (const call of calls) {
    const projectIds = [...new Set(call.paths.flatMap((path) => path.match(/PRJ-[0-9]{4}/g) ?? []))];
    if (projectIds.length > 0 && projectIds.every((id) => id !== projectId)) foreign.push(call);
    else scoped.push(call);
  }
  return [scoped, foreign];
}

it("keeps same-project and unscoped calls while reporting other-project provider calls separately", () => {
  const same = { endpoint: "POST /2/files/download", paths: ["/PROJECT_OS/.project-os/projects/PRJ-8451/materialization-head.json"] };
  const foreign = { endpoint: "POST /2/files/download", paths: ["/PROJECT_OS/.project-os/projects/PRJ-8450/materialization-head.json"] };
  const unscoped = { endpoint: "POST /2/files/list_folder", paths: [] };
  expect(partitionProviderCallsByProject([same, foreign, unscoped], "PRJ-8451")).toEqual([[same, unscoped], [foreign]]);
});

it("measures warm reads and snapshot costs at 50 and 1000 revisions without claiming constant snapshot bytes", async () => {
  const reports: Array<Record<string, number>> = [];
  const submissionCallProfiles: Array<Record<string, number>> = [];
  for (const history of [50, 1_000]) {
    const projectId = history === 50 ? "PRJ-8450" : "PRJ-8451";
    const mock = installDropboxMock();
    const record = commitFixture(projectId, history).at(-1)!;
    // Seed only the exact immutable record and its snapshot. Any attempted
    // history scan would fail: a proven current record must be sufficient.
    mock.files.set(machineCommitRecordPath(projectId, history), JSON.stringify(record));
    mock.files.set(machineStatePath(projectId), JSON.stringify(record.state));
    const guard = (env as unknown as Env).PROJECT_GUARD.getByName(projectId);
    await bootstrapRuleAdmissionGovernance(env as unknown as Env, "cost-profile-admission", projectId);
    await runInDurableObject(guard, (instance) => {
      (instance as unknown as { env: Env }).env.MUTATION_CONTEXT_SIGNING_KEY = "cost-profile-fixture";
    });
    const { warmCalls, warmDownloads } = await runInDurableObject(guard, async (instance) => {
      const contextRequest = () => new Request("https://guard.internal/mutation-context");
      expect((await instance.fetch(contextRequest())).status).toBe(200);
      const beforeCalls = mock.providerCalls.length;
      const beforeDownloads = mock.downloadCalls.length;
      const beforeUploads = mock.uploadCalls.length;
      expect((await instance.fetch(contextRequest())).status).toBe(200);
      const warmCalls = mock.providerCalls.length - beforeCalls;
      const warmDownloads = mock.downloadCalls.slice(beforeDownloads);
      expect(mock.uploadCalls.length).toBe(beforeUploads);

      // Model a new DO activation: the SQLite snapshot/checkpoint persist, but
      // the in-memory proof marker does not. Cold reads re-prove the current
      // revision before checking its successor.
      (instance as any).contextVerifiedState = null;
      const beforeColdDownloads = mock.downloadCalls.length;
      expect((await instance.fetch(contextRequest())).status).toBe(200);
      const coldDownloads = mock.downloadCalls.slice(beforeColdDownloads);
      expect(coldDownloads).toEqual([
        machineCommitRecordPath(projectId, history),
        machineCommitRecordPath(projectId, history + 1)
      ]);
      return { warmCalls, warmDownloads };
    });
    expect(warmCalls).toBeLessThanOrEqual(2);
    expect(warmDownloads).not.toContain(machineStatePath(projectId));
    expect(warmDownloads.every((path) => path === machineCommitRecordPath(projectId, history + 1)), JSON.stringify(warmDownloads)).toBe(true);

    // Isolated local commit-cache cost, not the total admission cost. Capture
    // SQLite's actual rowsWritten counters, including indices, for this step.
    const localRows = await runInDurableObject(guard, (instance, state) => {
      const sql = state.storage.sql;
      const exec = sql.exec.bind(sql);
      let rows = 0;
      const spy = vi.spyOn(sql, "exec").mockImplementation(((query: string, ...bindings: SqlStorageValue[]) => {
        const cursor = exec(query, ...bindings);
        rows += cursor.rowsWritten;
        return cursor;
      }) as typeof sql.exec);
      try {
        (instance as unknown as { persistCommit(state: ProjectState, receipt: Receipt): void })
          .persistCommit(record.state, record.receipt);
      } finally { spy.mockRestore(); }
      return rows;
    });
    await runInDurableObject(guard, instance => {
      (instance as unknown as { env: Env }).env.PROJECT_OS_ADMISSION_PROJECT_MODES = JSON.stringify({ [projectId]: "strict" });
    });
    const fresh = await (await guard.fetch("https://guard.internal/mutation-context?include_state=false")).json<{ context: unknown }>();
    const beforeSubmitCalls = mock.providerCalls.length;
    const beforeSubmitUploads = mock.uploadCalls.length;
    const submission = await runInDurableObject(guard, async (instance, state) => {
      const sql = state.storage.sql;
      const exec = sql.exec.bind(sql);
      let rows = 0;
      const spy = vi.spyOn(sql, "exec").mockImplementation(((query: string, ...bindings: SqlStorageValue[]) => {
        const cursor = exec(query, ...bindings);
        rows += cursor.rowsWritten;
        return cursor;
      }) as typeof sql.exec);
      try {
        const response = await instance.fetch(new Request("https://guard.internal/transaction", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ admission_version: "1.0", mutation_context: fresh.context, request: {
            schema_version: "1.0", project_id: projectId, transaction_id: `TXN-COST-PROFILE-${history}`,
            base_revision: history, operation: "research.add", created_at: "2026-09-24T12:00:00Z",
            payload: { research_id: "RES-COSTPROFILE", title: "Cost probe", body: "Synthetic local cost qualification" }
          } })
        }));
        const receipt = await response.json<{ status?: string; new_revision?: number }>();
        expect(receipt).toMatchObject({ status: "committed", new_revision: history + 1 });
      } finally { spy.mockRestore(); }
      return rows;
    });
    const submissionUploads = mock.uploadCalls.slice(beforeSubmitUploads);
    const [submissionCalls, foreignProjectCalls] = partitionProviderCallsByProject(
      mock.providerCalls.slice(beforeSubmitCalls), projectId
    );
    const [projectUploads, foreignProjectUploads] = partitionProviderCallsByProject(
      submissionUploads.map((path) => ({ endpoint: "upload", paths: [path], path })), projectId
    );
    const profile: Record<string, number> = {};
    for (const call of submissionCalls) {
      const signature = `${call.endpoint} ${call.paths.join(",")}`;
      profile[signature] = (profile[signature] ?? 0) + 1;
    }
    for (const call of foreignProjectCalls) {
      const signature = `foreign project ${call.endpoint} ${call.paths.join(",")}`;
      profile[signature] = (profile[signature] ?? 0) + 1;
    }
    profile.foreign_project_calls = foreignProjectCalls.length;
    profile.foreign_project_uploads = foreignProjectUploads.length;
    submissionCallProfiles.push(profile);
    reports.push({
      history,
      warm_provider_calls: warmCalls,
      warm_downloads: warmDownloads.length,
      local_commit_cache_sql_rows_written: localRows,
      canonical_record_bytes: new TextEncoder().encode(JSON.stringify(record)).byteLength,
      state_bytes: new TextEncoder().encode(JSON.stringify(record.state)).byteLength,
      strict_submission_provider_calls: submissionCalls.length,
      foreign_project_provider_calls_during_submission: foreignProjectCalls.length,
      strict_submission_project_sql_rows_written: submission,
      strict_submission_provider_uploads: projectUploads.length,
      foreign_project_uploads_during_submission: foreignProjectUploads.length,
      strict_submission_uploaded_path_final_bytes_estimate: projectUploads.reduce((sum, call) => sum + new TextEncoder().encode(mock.files.get(call.path) ?? "").byteLength, 0)
    });
  }
  expect(reports[1]!.warm_provider_calls).toBe(reports[0]!.warm_provider_calls);
  expect(reports[1]!.local_commit_cache_sql_rows_written).toBe(reports[0]!.local_commit_cache_sql_rows_written);
  expect(reports[1]!.strict_submission_provider_calls,
    `Provider-call profiles by history: ${JSON.stringify(submissionCallProfiles)}`
  ).toBe(reports[0]!.strict_submission_provider_calls);
  expect(reports[1]!.strict_submission_project_sql_rows_written).toBe(reports[0]!.strict_submission_project_sql_rows_written);
  expect(reports[1]!.state_bytes).toBeGreaterThan(reports[0]!.state_bytes!);
  console.info("persistence_cost_profile_fixture", JSON.stringify(reports));
}, 60_000);
