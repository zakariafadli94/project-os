import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { intakeIdFor } from "../src/domain/intake";
import { documentIdForProviderFile, externalVersionIdFor } from "../src/domain/managed-document";
import { requireDropboxV1Evidence } from "../src/persistence/compatibility/dropbox-v1-evidence";
import {
  machineDocumentHeadPath,
  machineDocumentProviderPayloadPath,
  machineDocumentVersionPath,
  machineIntakeRecordPath,
  workspaceManagedDocumentPath
} from "../src/persistence/layout";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { IntakeRepository } from "../src/documents/intake-repository";
import { IntakeService } from "../src/documents/intake-service";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

const at = "2026-08-30T11:30:00.000Z";

async function fixture(faults: DropboxMockFault[]) {
  const mock = installDropboxMock({ faults });
  const runtime = persistenceFromDropbox(new DropboxClient({
    appKey: "key",
    appSecret: "secret",
    refreshToken: "refresh"
  }), {
    sleep: async () => undefined,
    random: () => 0
  });
  const state = emptyProjectState("PRJ-9011", "Intake faults", "intake-faults", "Recover intake crashes");
  const source = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9011-intake-faults/INPUTS/report.pdf";
  await mock.writeExternal(source, "%PDF fault recovery");
  const metadata = await runtime.objects.getMetadata(source);
  if (!metadata) throw new Error("fixture metadata missing");
  const evidence = requireDropboxV1Evidence(metadata);
  const documentId = await documentIdForProviderFile(state.project_id, evidence.file_id);
  const versionId = await externalVersionIdFor(evidence.rev);
  const intakeId = await intakeIdFor(state.project_id, runtime.providerId, evidence.file_id, evidence.rev);
  const target = workspaceManagedDocumentPath(state.project_id, state.slug, "references", "UNCLASSIFIED/report.pdf");
  return {
    mock, runtime, state, source, metadata, evidence, documentId, versionId, intakeId, target,
    snapshot: machineDocumentProviderPayloadPath(state.project_id, documentId, versionId),
    version: machineDocumentVersionPath(state.project_id, documentId, versionId),
    head: machineDocumentHeadPath(state.project_id, documentId),
    journal: machineIntakeRecordPath(state.project_id, intakeId)
  };
}

describe("IntakeService crash recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["snapshot", (f: Awaited<ReturnType<typeof fixture>>) => ({ endpoint: "/2/files/copy_v2", path: f.snapshot })],
    ["destination copy", (f: Awaited<ReturnType<typeof fixture>>) => ({ endpoint: "/2/files/copy_v2", path: f.target })],
    ["version write", (f: Awaited<ReturnType<typeof fixture>>) => ({ endpoint: "/2/files/upload", path: f.version })],
    ["head write", (f: Awaited<ReturnType<typeof fixture>>) => ({ endpoint: "/2/files/upload", path: f.head })],
    ["source delete", (f: Awaited<ReturnType<typeof fixture>>) => ({ endpoint: "/2/files/delete_v2", path: f.source })]
  ])("resumes after a non-retryable provider failure at %s", async (_label, faultFor) => {
    const faults: DropboxMockFault[] = [];
    const f = await fixture(faults);
    const fault = faultFor(f);
    faults.push({ ...fault, occurrence: 1, status: 409, error_summary: "path/conflict/injected_intake_boundary" });

    await expect(new IntakeService(f.runtime).process(f.state, {
      logicalPath: "report.pdf", inputPath: f.source, metadata: f.metadata, detectedAt: at
    })).rejects.toBeDefined();

    const replay = await new IntakeService(f.runtime).process(f.state, {
      logicalPath: "report.pdf", inputPath: f.source, metadata: f.metadata, detectedAt: at
    });
    expect(replay).toBe("ingested");
    expect(f.mock.files.has(f.source)).toBe(false);
    expect(f.mock.files.get(f.target)).toBe("%PDF fault recovery");
    expect(await new IntakeRepository(f.runtime).read(f.state.project_id, f.intakeId)).toMatchObject({ state: "ingested" });
  });

  it("recovers as ingested when source deletion succeeded but terminal journal publication crashed", async () => {
    const faults: DropboxMockFault[] = [];
    const f = await fixture(faults);
    faults.push({
      endpoint: "/2/files/upload",
      path: f.journal,
      occurrence: 6,
      status: 409,
      error_summary: "path/conflict/injected_terminal_journal"
    });

    await expect(new IntakeService(f.runtime).process(f.state, {
      logicalPath: "report.pdf", inputPath: f.source, metadata: f.metadata, detectedAt: at
    })).rejects.toBeDefined();
    expect(f.mock.files.has(f.source)).toBe(false);

    const replay = await new IntakeService(f.runtime).process(f.state, {
      logicalPath: "report.pdf", inputPath: f.source, metadata: f.metadata, detectedAt: at
    });
    expect(replay).toBe("ingested");
    expect(await new IntakeRepository(f.runtime).read(f.state.project_id, f.intakeId)).toMatchObject({ state: "ingested" });
  });

  it("marks an exhausted retryable provider failure retryable and preserves the source", async () => {
    const faults: DropboxMockFault[] = [];
    const f = await fixture(faults);
    for (let index = 0; index < 5; index += 1) {
      faults.push({
        endpoint: "/2/files/copy_v2",
        path: f.snapshot,
        occurrence: 1,
        status: 503,
        error_summary: `server_error/injected_retryable_${index}`
      });
    }

    await expect(new IntakeService(f.runtime).process(f.state, {
      logicalPath: "report.pdf", inputPath: f.source, metadata: f.metadata, detectedAt: at
    })).rejects.toBeDefined();
    expect(f.mock.files.has(f.source)).toBe(true);
    expect(await new IntakeRepository(f.runtime).read(f.state.project_id, f.intakeId)).toMatchObject({
      state: "failed",
      retryable: true
    });
  });

  it("fails closed on contradictory destination evidence and never deletes source", async () => {
    const faults: DropboxMockFault[] = [];
    const f = await fixture(faults);
    await f.mock.writeExternal(f.target, "contradictory destination");

    await expect(new IntakeService(f.runtime).process(f.state, {
      logicalPath: "report.pdf", inputPath: f.source, metadata: f.metadata, detectedAt: at
    })).rejects.toBeDefined();
    expect(f.mock.files.has(f.source)).toBe(true);
    expect(f.mock.files.get(f.target)).toBe("contradictory destination");
    expect(await new IntakeRepository(f.runtime).read(f.state.project_id, f.intakeId)).toMatchObject({
      state: "failed",
      retryable: false
    });
  });
});
