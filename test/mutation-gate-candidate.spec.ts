import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactWriteReceipt } from "../src/domain/artifact-write";
import type { Receipt } from "../src/domain/receipt";
import { emptyProjectState } from "../src/domain/transitions";
import type { Env } from "../src/env";
import { DropboxClient } from "../src/dropbox/client";
import { MutationGateRepository } from "../src/mutation-gate/repository";
import { MutationGateService, parseMutationGateMode } from "../src/mutation-gate/service";
import { sha256Text } from "../src/documents/hash";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

const testEnv = env as unknown as Env;
const at = "2026-08-25T16:45:00+01:00";

async function createProject(transactionId: string, slug: string): Promise<Receipt> {
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name: `Gate ${slug}`, slug, aliases: [], objective: "Mutation gate candidate test" }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

describe("MutationGate candidates", () => {
  let mock: ReturnType<typeof installDropboxMock>;

  beforeEach(() => { mock = installDropboxMock(); });
  afterEach(() => vi.restoreAllMocks());

  it("parses observe/enforce and defaults to observe", () => {
    expect(parseMutationGateMode(undefined)).toBe("observe");
    expect(parseMutationGateMode("observe")).toBe("observe");
    expect(parseMutationGateMode("enforce")).toBe("enforce");
    expect(() => parseMutationGateMode("off")).toThrow(/PROJECT_OS_MUTATION_GATE_MODE/);
  });

  it("captures an external DELIVERABLE non-destructively before cursor advancement", async () => {
    const created = await createProject("TXN-MUTCAND-PROJECT-0001", "mutcand-one");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);

    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    const path = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-mutcand-one/DELIVERABLES/strategy/direct.md`;
    await mock.writeExternal(path, "# preserve me");

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      baseline: false,
      candidates: 1,
      mutation_gate_mode: "enforce",
      policy_violations: 1,
      last_candidate_detection_source: "incremental"
    });
    expect(mock.files.get(path)).toBe("# preserve me");
    expect([...mock.files.keys()].some((candidate) => candidate.includes(`/.project-os/projects/${created.project_id}/mutation-gate/payloads/candidates/`))).toBe(true);

    const list = await guard.fetch("https://project-guard.internal/mutation-candidates", { method: "GET" });
    const listed = await list.json<{ candidates: Array<{ candidate_id: string; provider_path: string; resolution_state: string; gate_mode: string }> }>();
    expect(listed.candidates).toHaveLength(1);
    expect(listed.candidates[0]).toMatchObject({
      provider_path: path,
      resolution_state: "unresolved",
      gate_mode: "enforce"
    });
    expect(JSON.stringify(listed)).not.toContain("preserve me");

    const replay = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(await replay.json()).toMatchObject({ candidates: 0, mutation_gate_mode: "enforce" });
    const listReplay = await guard.fetch("https://project-guard.internal/mutation-candidates", { method: "GET" });
    expect((await listReplay.json<{ candidates: unknown[] }>()).candidates).toHaveLength(1);
  });

  it("reconstructs candidate identity and payload from Dropbox evidence after service recreation", async () => {
    const created = await createProject("TXN-MUTCAND-PROJECT-0003", "mutcand-recreate");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });

    const path = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-mutcand-recreate/ARTIFACTS/recovered.md`;
    const content = "# durable candidate identity";
    await mock.writeExternal(path, content);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });

    const firstList = await guard.fetch("https://project-guard.internal/mutation-candidates", { method: "GET" });
    const first = (await firstList.json<{ candidates: Array<{ candidate_id: string }> }>()).candidates;
    expect(first).toHaveLength(1);
    const candidateId = first[0]!.candidate_id;
    const candidateFilesBefore = [...mock.files.keys()].filter((candidate) =>
      candidate.includes(`/.project-os/projects/${created.project_id}/mutation-gate/candidates/`)
      || candidate.includes(`/.project-os/projects/${created.project_id}/mutation-gate/payloads/candidates/`)
    ).sort();

    const client = new DropboxClient({
      appKey: testEnv.DROPBOX_APP_KEY,
      appSecret: testEnv.DROPBOX_APP_SECRET,
      refreshToken: testEnv.DROPBOX_REFRESH_TOKEN
    });
    const runtime = persistenceFromDropbox(client);
    const freshService = new MutationGateService(runtime, "observe");
    const freshRepository = new MutationGateRepository(runtime);
    const rebuilt = await freshService.list(created.project_id);

    expect(rebuilt).toEqual([
      expect.objectContaining({ candidate_id: candidateId, provider_path: path, resolution_state: "unresolved" })
    ]);
    expect(await freshRepository.readCandidatePayload(created.project_id, candidateId)).toBe(content);

    const metadata = await client.getMetadata(path);
    expect(metadata).not.toBeNull();
    await freshService.processChanges(createdState(created.project_id, "mutcand-recreate"), [{
      tag: "file",
      name: "recovered.md",
      path,
      id: metadata!.id,
      rev: metadata!.rev,
      content_hash: metadata!.content_hash,
      size: metadata!.size,
      ...(metadata!.server_modified ? { server_modified: metadata!.server_modified } : {})
    }], "incremental");

    const candidateFilesAfter = [...mock.files.keys()].filter((candidate) =>
      candidate.includes(`/.project-os/projects/${created.project_id}/mutation-gate/candidates/`)
      || candidate.includes(`/.project-os/projects/${created.project_id}/mutation-gate/payloads/candidates/`)
    ).sort();
    expect(candidateFilesAfter).toEqual(candidateFilesBefore);
    expect((await freshService.list(created.project_id))[0]?.candidate_id).toBe(candidateId);
  });

  it("blocks a new artifact request from retroactively sanitizing a pre-existing raw file", async () => {
    const created = await createProject("TXN-MUTCAND-PROJECT-0002", "mutcand-two");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const path = `/PROJECT_OS/WORKSPACE/PROJECTS/${created.project_id}-mutcand-two/ARTIFACTS/playbooks/raw.md`;
    const content = "# raw before intent";
    await mock.writeExternal(path, content);

    const response = await guard.fetch("https://project-guard.internal/artifact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "ART-MUTCAND-LATE-INTENT-0001",
        project_id: created.project_id,
        relative_path: "playbooks/raw.md",
        content,
        content_sha256: await sha256Text(content),
        mode: "replace"
      })
    });
    const receipt = await response.json<ArtifactWriteReceipt & { code?: string }>();
    expect(receipt).toMatchObject({ status: "conflict", code: "UNRESOLVED_EXTERNAL_CANDIDATE" });
    expect(mock.files.get(path)).toBe(content);

    const list = await guard.fetch("https://project-guard.internal/mutation-candidates", { method: "GET" });
    const body = await list.json<{ candidates: Array<{ provider_path: string; resolution_state: string }> }>();
    expect(body.candidates).toEqual([
      expect.objectContaining({ provider_path: path, resolution_state: "unresolved" })
    ]);
  });
});

function createdState(projectId: string, slug: string) {
  return {
    ...emptyProjectState(projectId, slug, slug, "Mutation gate candidate test"),
    revision: 1,
    created_at: at,
    updated_at: at
  };
}
