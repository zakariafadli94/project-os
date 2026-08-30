import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { intakeIdFor } from "../src/domain/intake";
import { documentIdForProviderFile, externalVersionIdFor } from "../src/domain/managed-document";
import { requireDropboxV1Evidence } from "../src/persistence/compatibility/dropbox-v1-evidence";
import {
  machineDocumentHeadPath,
  machineDocumentProviderPayloadPath,
  machineDocumentVersionPath
} from "../src/persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { IntakeRepository, legacyReferralIdFor } from "../src/documents/intake-repository";
import { IntakeService } from "../src/documents/intake-service";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

const at = "2026-08-30T10:30:00.000Z";

function fixture() {
  const mock = installDropboxMock();
  const runtime = persistenceFromDropbox(new DropboxClient({
    appKey: "key",
    appSecret: "secret",
    refreshToken: "refresh"
  }));
  const state = emptyProjectState("PRJ-9007", "Intake", "intake", "Crash-safe intake");
  return { mock, runtime, state };
}

function inputPath(name: string): string {
  return `/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9007-intake/INPUTS/${name}`;
}

function referencePath(name: string): string {
  return `/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9007-intake/REFERENCES/UNCLASSIFIED/${name}`;
}

describe("IntakeService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("durably journals intent before snapshot and deletes source only after governed reference proof", async () => {
    const { mock, runtime, state } = fixture();
    const source = inputPath("market-report.pdf");
    await mock.writeExternal(source, "%PDF governed intake");
    const metadata = await runtime.objects.getMetadata(source);
    if (!metadata) throw new Error("fixture metadata missing");

    const result = await new IntakeService(runtime).process(state, {
      logicalPath: "market-report.pdf",
      inputPath: source,
      metadata,
      detectedAt: at
    });

    expect(result).toBe("ingested");
    expect(mock.files.has(source)).toBe(false);
    expect(mock.files.get(referencePath("market-report.pdf"))).toBe("%PDF governed intake");

    const evidence = requireDropboxV1Evidence(metadata);
    const documentId = await documentIdForProviderFile(state.project_id, evidence.file_id);
    const versionId = await externalVersionIdFor(evidence.rev);
    expect(mock.files.has(machineDocumentProviderPayloadPath(state.project_id, documentId, versionId))).toBe(true);
    expect(mock.files.has(machineDocumentVersionPath(state.project_id, documentId, versionId))).toBe(true);
    expect(mock.files.has(machineDocumentHeadPath(state.project_id, documentId))).toBe(true);

    const intakeId = await intakeIdFor(state.project_id, runtime.providerId, evidence.file_id, evidence.rev);
    expect(await new IntakeRepository(runtime).read(state.project_id, intakeId)).toMatchObject({
      state: "ingested",
      document_id: documentId,
      version_id: versionId,
      reference_path: "UNCLASSIFIED/market-report.pdf"
    });

    expect(mock.calls.indexOf("POST /2/files/upload")).toBeLessThan(mock.calls.indexOf("POST /2/files/copy_v2"));
  });

  it("deletes a duplicate only after proving the existing governed reference is current", async () => {
    const { mock, runtime, state } = fixture();
    const first = inputPath("first.pdf");
    await mock.writeExternal(first, "same evidence");
    const firstMetadata = await runtime.objects.getMetadata(first);
    if (!firstMetadata) throw new Error("first metadata missing");
    expect(await new IntakeService(runtime).process(state, {
      logicalPath: "first.pdf", inputPath: first, metadata: firstMetadata, detectedAt: at
    })).toBe("ingested");

    const duplicate = inputPath("duplicate.pdf");
    await mock.writeExternal(duplicate, "same evidence");
    const duplicateMetadata = await runtime.objects.getMetadata(duplicate);
    if (!duplicateMetadata) throw new Error("duplicate metadata missing");
    const result = await new IntakeService(runtime).process(state, {
      logicalPath: "duplicate.pdf", inputPath: duplicate, metadata: duplicateMetadata, detectedAt: at
    });

    expect(result).toBe("duplicate");
    expect(mock.files.has(duplicate)).toBe(false);
    expect(mock.files.has(referencePath("duplicate.pdf"))).toBe(false);
  });

  it("never deletes a newer source revision that appears while the older revision is being ingested", async () => {
    const { mock, runtime, state } = fixture();
    const source = inputPath("changing.pdf");
    await mock.writeExternal(source, "old revision");
    const initial = await runtime.objects.getMetadata(source);
    if (!initial) throw new Error("initial metadata missing");

    let mutated = false;
    const wrapped: ProjectOsPersistenceRuntime = {
      ...runtime,
      objects: {
        ...runtime.objects,
        getMetadata: async (path) => {
          if (path === source && !mutated) {
            mutated = true;
            await mock.writeExternal(source, "new revision");
          }
          return runtime.objects.getMetadata(path);
        }
      }
    };

    const result = await new IntakeService(wrapped).process(state, {
      logicalPath: "changing.pdf",
      inputPath: source,
      metadata: initial,
      detectedAt: at
    });

    expect(result).toBe("ingested");
    expect(mock.files.get(source)).toBe("new revision");
    expect(mock.files.get(referencePath("changing.pdf"))).toBe("old revision");

    const evidence = requireDropboxV1Evidence(initial);
    const intakeId = await intakeIdFor(state.project_id, wrapped.providerId, evidence.file_id, evidence.rev);
    const record = await new IntakeRepository(wrapped).read(state.project_id, intakeId);
    expect(record?.step_evidence).toMatchObject({ source_cleanup: "skipped_revision_mismatch" });
  });

  it("creates immutable provenance for a legacy referral without rewriting its source markdown", async () => {
    const { mock, runtime, state } = fixture();
    const source = inputPath("REFERRAL-legacy.md");
    const legacyBytes = "---\ninput_type: cross_project_referral\nreferral_status: incoming\n---\n# Legacy referral\n";
    await mock.writeExternal(source, legacyBytes);
    const metadata = await runtime.objects.getMetadata(source);
    if (!metadata) throw new Error("legacy metadata missing");
    const evidence = requireDropboxV1Evidence(metadata);

    expect(await new IntakeService(runtime).process(state, {
      logicalPath: "REFERRAL-legacy.md",
      inputPath: source,
      metadata,
      detectedAt: at
    })).toBe("ingested");

    const referralId = await legacyReferralIdFor(state.project_id, runtime.providerId, evidence.file_id);
    const provenance = await new IntakeRepository(runtime).readReferralProvenance(state.project_id, referralId);
    expect(provenance).toMatchObject({
      referral_id: referralId,
      legacy_derived: true,
      source_object_id: evidence.file_id,
      source_revision_token: evidence.rev
    });
    expect(mock.files.get(referencePath("REFERRAL-legacy.md"))).toBe(legacyBytes);
  });
});
