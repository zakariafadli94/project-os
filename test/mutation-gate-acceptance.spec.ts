import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { documentIdFor } from "../src/domain/managed-document";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;
const at = "2026-08-25T18:20:00+01:00";

interface CreatedProject {
  projectId: string;
  slug: string;
}

interface CandidateStatus {
  candidate_id: string;
  provider_path: string;
  detection_source: "incremental" | "baseline" | "cursor_reset";
  resolution_state: "unresolved" | "resolved";
}

describe("IMP-MUTATIONGATE001 acceptance matrix", () => {
  afterEach(() => vi.restoreAllMocks());

  it("captures the exact PRJ-0003-shaped direct outputs without changing canonical revision", async () => {
    const dropbox = installDropboxMock();
    const project = await createProject("TXN-MUTACCEPT-PROJECT-0001", "mutation-acceptance");
    const guard = testEnv.PROJECT_GUARD.getByName(project.projectId);
    const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${project.projectId}-${project.slug}`;
    const directRelativePaths = [
      "DELIVERABLES/REVENUE-OS/04-playbooks-sectoriels/04b-pest-control/08-recurrence-reactivation-recommandation-support/01a-kit-execution-avis-temoignages.md",
      "DELIVERABLES/REVENUE-OS/04-playbooks-sectoriels/04b-pest-control/08-recurrence-reactivation-recommandation-support/02a-kit-execution-referral-recommandation.md",
      "ARTIFACTS/plan-action-executabilite-revenue-os-2026-08-25.md"
    ];
    const revisionBefore = await canonicalRevision(guard);

    for (const relative of directRelativePaths) {
      await dropbox.writeExternal(`${root}/${relative}`, `# direct ${relative}`);
    }

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      baseline: true,
      candidates: 3,
      bootstrapped: 0,
      mutation_gate_mode: "observe",
      last_candidate_detection_source: "baseline"
    });
    expect(await canonicalRevision(guard)).toBe(revisionBefore);

    const candidates = await listCandidates(guard);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((item) => item.provider_path).sort()).toEqual(
      directRelativePaths.map((relative) => `${root}/${relative}`).sort()
    );
    expect(candidates.every((item) => item.resolution_state === "unresolved")).toBe(true);

    for (const relative of directRelativePaths.filter((value) => value.startsWith("DELIVERABLES/"))) {
      const logicalPath = relative.slice("DELIVERABLES/".length);
      const documentId = await documentIdFor(project.projectId, logicalPath);
      const status = await guard.fetch(
        `https://project-guard.internal/document-status?document_id=${encodeURIComponent(documentId)}`,
        { method: "GET" }
      );
      expect(status.status).toBe(404);
    }

    expect([...dropbox.files.keys()].filter((path) => path.includes("/.project-os/artifacts/receipts/"))).toHaveLength(0);
  }, 15_000);

  it("never bootstraps an unknown deliverable on baseline and records baseline provenance", async () => {
    const dropbox = installDropboxMock();
    const project = await createProject("TXN-MUTACCEPT-PROJECT-0002", "mutation-baseline");
    const guard = testEnv.PROJECT_GUARD.getByName(project.projectId);
    const logicalPath = "strategy/baseline-direct.md";
    const visiblePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${project.projectId}-${project.slug}/DELIVERABLES/${logicalPath}`;
    await dropbox.writeExternal(visiblePath, "# baseline bypass");

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(await response.json()).toMatchObject({
      baseline: true,
      candidates: 1,
      bootstrapped: 0,
      last_candidate_detection_source: "baseline"
    });
    const candidates = await listCandidates(guard);
    expect(candidates).toMatchObject([{ provider_path: visiblePath, detection_source: "baseline" }]);

    const documentId = await documentIdFor(project.projectId, logicalPath);
    expect((await guard.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(documentId)}`,
      { method: "GET" }
    )).status).toBe(404);
  });

  it("never bootstraps an unknown deliverable after cursor reset and records reset provenance", async () => {
    const dropbox = installDropboxMock({
      faults: [{
        endpoint: "/2/files/list_folder/continue",
        occurrence: 1,
        status: 409,
        error_summary: "reset/..."
      }]
    });
    const project = await createProject("TXN-MUTACCEPT-PROJECT-0003", "mutation-reset");
    const guard = testEnv.PROJECT_GUARD.getByName(project.projectId);
    await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });

    const logicalPath = "strategy/reset-direct.md";
    const visiblePath = `/PROJECT_OS/WORKSPACE/PROJECTS/${project.projectId}-${project.slug}/DELIVERABLES/${logicalPath}`;
    await dropbox.writeExternal(visiblePath, "# reset bypass");

    const response = await guard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(await response.json()).toMatchObject({
      cursor_reset: true,
      baseline: true,
      candidates: 1,
      bootstrapped: 0,
      last_candidate_detection_source: "cursor_reset"
    });
    const candidates = await listCandidates(guard);
    expect(candidates).toMatchObject([{ provider_path: visiblePath, detection_source: "cursor_reset" }]);

    const documentId = await documentIdFor(project.projectId, logicalPath);
    expect((await guard.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(documentId)}`,
      { method: "GET" }
    )).status).toBe(404);
  });

  it("keeps fifty governed/external operations isolated across two projects", async () => {
    const dropbox = installDropboxMock();
    const governed = await createProject("TXN-MUTACCEPT-PROJECT-0004", "mutation-governed");
    const external = await createProject("TXN-MUTACCEPT-PROJECT-0005", "mutation-external");
    const governedGuard = testEnv.PROJECT_GUARD.getByName(governed.projectId);
    const externalGuard = testEnv.PROJECT_GUARD.getByName(external.projectId);
    await Promise.all([
      governedGuard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" }),
      externalGuard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" })
    ]);
    const governedRevision = await canonicalRevision(governedGuard);
    const externalRevision = await canonicalRevision(externalGuard);

    const governedWrites = Array.from({ length: 25 }, async (_, index) => {
      const content = `# governed ${index}`;
      const requestId = `ART-STRESS-GOVERNED-${String(index).padStart(6, "0")}`;
      const response = await governedGuard.fetch("https://project-guard.internal/artifact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: requestId,
          project_id: governed.projectId,
          relative_path: `stress/${String(index).padStart(2, "0")}.md`,
          content,
          content_sha256: await sha256Text(content),
          mode: "create"
        })
      });
      expect(await response.json()).toMatchObject({ status: "committed", request_id: requestId });
    });
    const externalWrites = Array.from({ length: 25 }, (_, index) =>
      dropbox.writeExternal(
        `/PROJECT_OS/WORKSPACE/PROJECTS/${external.projectId}-${external.slug}/ARTIFACTS/stress/${String(index).padStart(2, "0")}.md`,
        `# external ${index}`
      )
    );
    await Promise.all([...governedWrites, ...externalWrites]);

    const reconciliation = await externalGuard.fetch("https://project-guard.internal/reconcile-documents", { method: "POST" });
    expect(await reconciliation.json()).toMatchObject({ candidates: 25, baseline: false });
    expect(await listCandidates(governedGuard)).toHaveLength(0);
    expect(await listCandidates(externalGuard)).toHaveLength(25);
    expect(await canonicalRevision(governedGuard)).toBe(governedRevision);
    expect(await canonicalRevision(externalGuard)).toBe(externalRevision);

    const paths = [...dropbox.files.keys()];
    expect(paths.filter((path) => path.includes(`/projects/${governed.projectId}/mutation-gate/intents/artifacts/`))).toHaveLength(25);
    expect(paths.filter((path) => path.includes(`/projects/${governed.projectId}/mutation-gate/candidates/`))).toHaveLength(0);
    expect(paths.filter((path) => path.includes(`/projects/${external.projectId}/mutation-gate/intents/artifacts/`))).toHaveLength(0);
    expect(paths.filter((path) => path.includes(`/projects/${external.projectId}/mutation-gate/candidates/`))).toHaveLength(25);
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
      payload: { name: slug, slug, aliases: [], objective: "Mutation gate acceptance" }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return { projectId: receipt.project_id, slug };
}

async function canonicalRevision(guard: DurableObjectStub): Promise<number> {
  const response = await guard.fetch("https://project-guard.internal/materialization-status", { method: "GET" });
  expect(response.status).toBe(200);
  return (await response.json<{ canonical_revision: number }>()).canonical_revision;
}

async function listCandidates(guard: DurableObjectStub): Promise<CandidateStatus[]> {
  const response = await guard.fetch("https://project-guard.internal/mutation-candidates", { method: "GET" });
  expect(response.status).toBe(200);
  return (await response.json<{ candidates: CandidateStatus[] }>()).candidates;
}
