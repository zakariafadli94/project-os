import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseMutationCandidateResolutionRequest
} from "../src/domain/mutation-candidate-resolution";
import type { Env } from "../src/env";
import worker from "../src/index-mutation-gate";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-25T17:30:00+01:00";

interface CreatedProject {
  projectId: string;
  slug: string;
}

interface CandidateStatus {
  candidate_id: string;
  project_id: string;
  provider_path: string;
  resolution_state: "unresolved" | "resolved";
  resolution_action?: "adopt_as_artifact" | "adopt_as_working" | "reject";
}

describe("mutation candidate resolution request", () => {
  it.each([
    {
      operation: "candidate.reject",
      resolution_id: "MUTRES-111111111111111111111111",
      project_id: "PRJ-0002",
      candidate_id: "MUTCAND-111111111111111111111111"
    },
    {
      operation: "candidate.adopt_artifact",
      resolution_id: "MUTRES-222222222222222222222222",
      project_id: "PRJ-0002",
      candidate_id: "MUTCAND-111111111111111111111111",
      artifact_request: {
        request_id: "ART-CANDIDATE-ADOPT-0001",
        project_id: "PRJ-0002",
        relative_path: "REVENUE-OS/direct.md",
        content: "# candidate",
        content_sha256: "a".repeat(64),
        mode: "create"
      }
    }
  ])("parses $operation", (request) => {
    expect(parseMutationCandidateResolutionRequest(request)).toMatchObject({ operation: request.operation });
  });

  it("rejects adopt_working when the nested document operation is not working.write", () => {
    expect(() => parseMutationCandidateResolutionRequest({
      operation: "candidate.adopt_working",
      resolution_id: "MUTRES-333333333333333333333333",
      project_id: "PRJ-0002",
      candidate_id: "MUTCAND-111111111111111111111111",
      document_request: {
        operation: "publish",
        request_id: "DOCREQ-CANDIDATE-0001",
        project_id: "PRJ-0002",
        document_id: "DOC-111111111111111111111111",
        created_at: at
      }
    })).toThrow(/working\.write/i);
  });
});

describe("mutation candidate resolution service", () => {
  let dropbox: ReturnType<typeof installDropboxMock>;

  beforeEach(() => { dropbox = installDropboxMock(); });
  afterEach(() => vi.restoreAllMocks());

  it("records adopt-as-artifact only after a committed governed artifact receipt", async () => {
    const project = await createProject("TXN-CANDRES-PROJECT-0001", "candidate-artifact");
    const guard = testEnv.PROJECT_GUARD.getByName(project.projectId);
    const content = "# candidate artifact";
    const path = workspacePath(project, "ARTIFACTS/playbooks/direct.md");
    const candidate = await captureCandidate(guard, path, content);
    const artifactRequest = {
      request_id: "ART-CANDIDATE-ADOPT-1001",
      project_id: project.projectId,
      relative_path: "playbooks/direct.md",
      content,
      content_sha256: await sha256Text(content),
      mode: "create" as const
    };
    const request = {
      operation: "candidate.adopt_artifact",
      resolution_id: "MUTRES-AAAAAAAAAAAAAAAAAAAAAAAA",
      project_id: project.projectId,
      candidate_id: candidate.candidate_id,
      artifact_request: artifactRequest
    };

    const response = await guard.fetch("https://project-guard.internal/mutation-candidate-resolution", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "committed",
      action: "adopt_as_artifact",
      candidate_id: candidate.candidate_id,
      downstream_request_id: artifactRequest.request_id
    });
    expect(JSON.parse(dropbox.files.get(`/PROJECT_OS/.project-os/artifacts/receipts/${artifactRequest.request_id}.json`) ?? "null"))
      .toMatchObject({ status: "committed", request_id: artifactRequest.request_id });
    expect(dropbox.files.get(path)).toBe(content);

    const status = await candidateStatus(guard, candidate.candidate_id);
    expect(status).toMatchObject({ resolution_state: "resolved", resolution_action: "adopt_as_artifact" });
  });

  it("adopt-as-working creates only a working pointer and never publishes", async () => {
    const project = await createProject("TXN-CANDRES-PROJECT-0002", "candidate-working");
    const guard = testEnv.PROJECT_GUARD.getByName(project.projectId);
    const content = "# candidate working";
    const path = workspacePath(project, "DELIVERABLES/direct.md");
    const candidate = await captureCandidate(guard, path, content);
    const documentRequest = {
      operation: "working.write" as const,
      request_id: "DOCREQ-CANDIDATE-WORK-0002",
      project_id: project.projectId,
      logical_path: "recovered/direct.md",
      content,
      content_sha256: await sha256Text(content),
      created_at: at
    };

    const response = await guard.fetch("https://project-guard.internal/mutation-candidate-resolution", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "candidate.adopt_working",
        resolution_id: "MUTRES-BBBBBBBBBBBBBBBBBBBBBBBB",
        project_id: project.projectId,
        candidate_id: candidate.candidate_id,
        document_request: documentRequest
      })
    });
    const receipt = await response.json<{ status: string; action: string; document_id: string }>();
    expect(receipt).toMatchObject({ status: "committed", action: "adopt_as_working" });

    const documentStatus = await guard.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(receipt.document_id)}`,
      { method: "GET" }
    );
    const logical = await documentStatus.json<Record<string, unknown>>();
    expect(logical.working_version_id).toBeDefined();
    expect(logical.published_version_id).toBeUndefined();
    expect(dropbox.files.get(path)).toBe(content);
  });

  it("reject is idempotent and blocks a later conflicting adoption", async () => {
    const project = await createProject("TXN-CANDRES-PROJECT-0003", "candidate-reject");
    const guard = testEnv.PROJECT_GUARD.getByName(project.projectId);
    const content = "# rejected";
    const path = workspacePath(project, "ARTIFACTS/reject.md");
    const candidate = await captureCandidate(guard, path, content);
    const reject = {
      operation: "candidate.reject",
      resolution_id: "MUTRES-CCCCCCCCCCCCCCCCCCCCCCCC",
      project_id: project.projectId,
      candidate_id: candidate.candidate_id
    };

    const first = await postResolution(guard, reject);
    expect(first).toMatchObject({ status: "committed", action: "reject" });
    expect(await postResolution(guard, reject)).toEqual(first);

    const conflicting = await postResolution(guard, {
      operation: "candidate.adopt_artifact",
      resolution_id: "MUTRES-DDDDDDDDDDDDDDDDDDDDDDDD",
      project_id: project.projectId,
      candidate_id: candidate.candidate_id,
      artifact_request: {
        request_id: "ART-CANDIDATE-ADOPT-1003",
        project_id: project.projectId,
        relative_path: "reject.md",
        content,
        content_sha256: await sha256Text(content),
        mode: "create"
      }
    });
    expect(conflicting).toMatchObject({ status: "conflict", code: "CANDIDATE_ALREADY_RESOLVED" });
    expect(dropbox.files.get(path)).toBe(content);
  });

  it("exposes the resolution route only through authenticated public ingress", async () => {
    const project = await createProject("TXN-CANDRES-PROJECT-0004", "candidate-public");
    const guard = testEnv.PROJECT_GUARD.getByName(project.projectId);
    const candidate = await captureCandidate(guard, workspacePath(project, "ARTIFACTS/public.md"), "public candidate");
    const body = JSON.stringify({
      operation: "candidate.reject",
      resolution_id: "MUTRES-EEEEEEEEEEEEEEEEEEEEEEEE",
      project_id: project.projectId,
      candidate_id: candidate.candidate_id
    });

    const unauthenticated = await worker.fetch(new Request("https://example.com/v1/mutation-candidates/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    }), testEnv, createExecutionContext());
    expect(unauthenticated.status).toBe(401);

    const authenticated = await worker.fetch(new Request("https://example.com/v1/mutation-candidates/resolve", {
      method: "POST",
      headers: {
        authorization: `Bearer ${testEnv.INGRESS_TOKEN}`,
        "content-type": "application/json"
      },
      body
    }), testEnv, createExecutionContext());
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toMatchObject({ status: "committed", action: "reject" });
  });
});

async function createProject(transactionId: string, slug: string): Promise<CreatedProject> {
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
      payload: { name: slug, slug, aliases: [], objective: "Mutation candidate resolution" }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return { projectId: receipt.project_id, slug };
}

function workspacePath(project: CreatedProject, relative: string): string {
  return `/PROJECT_OS/WORKSPACE/PROJECTS/${project.projectId}-${project.slug}/${relative}`;
}

async function captureCandidate(
  guard: DurableObjectStub,
  path: string,
  content: string
): Promise<CandidateStatus> {
  const mock = installDropboxMock();
  await mock.writeExternal(path, content);
  const reconcile = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
  expect(reconcile.status).toBe(200);
  const list = await guard.fetch("https://project-guard.internal/mutation-candidates", { method: "GET" });
  const body = await list.json<{ candidates: CandidateStatus[] }>();
  const candidate = body.candidates.find((item) => item.provider_path === path);
  expect(candidate).toBeDefined();
  return candidate!;
}

async function candidateStatus(guard: DurableObjectStub, candidateId: string): Promise<CandidateStatus> {
  const response = await guard.fetch(
    `https://project-guard.internal/mutation-candidate-status?candidate_id=${encodeURIComponent(candidateId)}`,
    { method: "GET" }
  );
  expect(response.status).toBe(200);
  return response.json<CandidateStatus>();
}

async function postResolution(guard: DurableObjectStub, body: unknown): Promise<Record<string, unknown>> {
  const response = await guard.fetch("https://project-guard.internal/mutation-candidate-resolution", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  expect(response.status).toBe(200);
  return response.json<Record<string, unknown>>();
}
