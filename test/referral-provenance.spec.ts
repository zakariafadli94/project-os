import { describe, expect, it } from "vitest";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import { ProviderConflictError } from "../src/persistence/provider/errors";
import {
  IntakeRepository,
  legacyReferralIdFor,
  type ReferralProvenanceRecord
} from "../src/documents/intake-repository";

function runtime() {
  const files = new Map<string, string>();
  const value = {
    providerId: "test",
    objects: {
      readText: async (path: string) => files.get(path) ?? null,
      createText: async (path: string, content: string) => {
        if (files.has(path)) throw new ProviderConflictError(`exists ${path}`);
        files.set(path, content);
      },
      upsertText: async (path: string, content: string) => { files.set(path, content); },
      getMetadata: async () => null,
      listChildren: async () => [],
      move: async () => undefined,
      delete: async () => undefined
    },
    conditionalWrite: { writeTextConditional: async () => { throw new Error("unused"); } },
    serverSideCopy: { copyObject: async () => { throw new Error("unused"); } },
    changeFeed: { listChanges: async () => ({ entries: [], cursor: "cursor" }) },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" as const },
      revisionToken: { semantics: "opaque-object-revision" as const },
      integrityHash: { semantics: "identified-algorithm" as const }
    }
  } satisfies ProjectOsPersistenceRuntime;
  return { value, files };
}

const base: Omit<ReferralProvenanceRecord, "referral_id" | "legacy_derived"> = {
  schema_version: "1.0",
  project_id: "PRJ-0002",
  document_id: "DOC-AAAAAAAAAAAAAAAAAAAAAAAA",
  version_id: "VER-EXT-BBBBBBBBBBBBBBBBBBBBBBBB",
  source_input_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/INPUTS/REFERRAL-example.md",
  source_provider_id: "dropbox",
  source_object_id: "id:legacy-referral",
  source_revision_token: "rev-4"
};

describe("referral provenance", () => {
  it("persists a standard referral id as immutable governed provenance", async () => {
    const storage = runtime();
    const repo = new IntakeRepository(storage.value);
    const record: ReferralProvenanceRecord = {
      ...base,
      referral_id: "REF-GOV-000000000001",
      legacy_derived: false
    };
    await repo.writeReferralProvenance(record);
    expect(await repo.readReferralProvenance("PRJ-0002", record.referral_id)).toEqual(record);
  });

  it("derives a stable legacy referral id from provider object identity without modifying source bytes", async () => {
    const storage = runtime();
    storage.files.set(base.source_input_path, "legacy referral bytes with referral_status: incoming");
    const repo = new IntakeRepository(storage.value);
    const first = await legacyReferralIdFor(base.project_id, base.source_provider_id, base.source_object_id);
    const replay = await legacyReferralIdFor(base.project_id, base.source_provider_id, base.source_object_id);
    expect(first).toBe(replay);
    expect(first).toMatch(/^REF-LEGACY-[A-F0-9]{24}$/);

    await repo.writeReferralProvenance({ ...base, referral_id: first, legacy_derived: true });
    expect(storage.files.get(base.source_input_path)).toBe("legacy referral bytes with referral_status: incoming");
    expect(await repo.readReferralProvenance("PRJ-0002", first)).toMatchObject({
      referral_id: first,
      legacy_derived: true,
      source_object_id: base.source_object_id,
      source_revision_token: base.source_revision_token
    });
  });
});
