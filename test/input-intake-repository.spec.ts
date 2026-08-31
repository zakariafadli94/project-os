import { describe, expect, it } from "vitest";
import {
  inputIntakeIdFor,
  parseInputIntakeRecord,
  nextInputIntakeRecord,
  type InputIntakeRecord
} from "../src/documents/input-intake";
import { InputIntakeRepository } from "../src/documents/input-intake-repository";
import type {
  ObjectPersistence,
  ProviderEntry,
  ProviderObjectMetadata
} from "../src/persistence/provider/contract";
import { ProviderConflictError } from "../src/persistence/provider/errors";

class MemoryObjects implements ObjectPersistence {
  readonly files = new Map<string, string>();

  async readText(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async createText(path: string, content: string): Promise<void> {
    if (this.files.has(path)) throw new ProviderConflictError(`exists: ${path}`);
    this.files.set(path, content);
  }
  async upsertText(path: string, content: string): Promise<void> { this.files.set(path, content); }
  async getMetadata(_path: string): Promise<ProviderObjectMetadata | null> { return null; }
  async listChildren(_path: string): Promise<ProviderEntry[]> { return []; }
  async move(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`missing: ${from}`);
    if (this.files.has(to)) throw new ProviderConflictError(`exists: ${to}`);
    this.files.delete(from);
    this.files.set(to, content);
  }
  async delete(path: string): Promise<void> { this.files.delete(path); }
}

const detectedRecord = (overrides: Partial<InputIntakeRecord> = {}): InputIntakeRecord => ({
  schema_version: "1.0",
  intake_id: "INTAKE-111111111111111111111111",
  project_id: "PRJ-0002",
  phase: "DETECTED",
  source: {
    provider_id: "dropbox",
    object_id: "id:source-1",
    revision_token: "rev-001",
    integrity_hash: { algorithm: "dropbox-content-hash", value: "a".repeat(64) },
    size: 12,
    provider_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/INPUTS/report.pdf",
    relative_input_path: "report.pdf"
  },
  detected_at: "2026-08-31T11:55:00+01:00",
  updated_at: "2026-08-31T11:55:00+01:00",
  ...overrides
});

describe("durable input intake domain", () => {
  it("derives a stable intake id from project + provider object + provider revision", async () => {
    const first = await inputIntakeIdFor({
      projectId: "PRJ-0002",
      providerId: "dropbox",
      objectId: "id:source-1",
      revisionToken: "rev-001"
    });
    const replay = await inputIntakeIdFor({
      projectId: "PRJ-0002",
      providerId: "dropbox",
      objectId: "id:source-1",
      revisionToken: "rev-001"
    });
    const newerRevision = await inputIntakeIdFor({
      projectId: "PRJ-0002",
      providerId: "dropbox",
      objectId: "id:source-1",
      revisionToken: "rev-002"
    });

    expect(first).toMatch(/^INTAKE-[A-F0-9]{24}$/);
    expect(replay).toBe(first);
    expect(newerRevision).not.toBe(first);
  });

  it("validates portable DETECTED evidence and legal lifecycle transitions", () => {
    const detected = detectedRecord();
    expect(parseInputIntakeRecord(detected)).toEqual(detected);
    const snapshotted = nextInputIntakeRecord(detected, "SNAPSHOTTED", "2026-08-31T11:56:00+01:00");
    expect(snapshotted.phase).toBe("SNAPSHOTTED");
    expect(() => nextInputIntakeRecord(snapshotted, "DETECTED", "2026-08-31T11:57:00+01:00"))
      .toThrow(/transition/i);
  });

  it("treats COMPLETE, DUPLICATE_CLEANED, WITHDRAWN and CONFLICT as terminal", () => {
    const base = detectedRecord({ phase: "SOURCE_REMOVED", updated_at: "2026-08-31T11:56:00+01:00" });
    for (const terminal of ["COMPLETE", "DUPLICATE_CLEANED", "WITHDRAWN", "CONFLICT"] as const) {
      const terminalRecord = nextInputIntakeRecord(base, terminal, "2026-08-31T11:57:00+01:00");
      expect(() => nextInputIntakeRecord(terminalRecord, "COMPLETE", "2026-08-31T11:58:00+01:00"))
        .toThrow(/terminal/i);
    }
  });
});

describe("durable input intake repository", () => {
  it("creates an intake idempotently and rejects incompatible reuse of the same intake id", async () => {
    const objects = new MemoryObjects();
    const repository = new InputIntakeRepository(objects);
    const record = detectedRecord();

    await expect(repository.create(record)).resolves.toEqual(record);
    await expect(repository.create(record)).resolves.toEqual(record);
    await expect(repository.read(record.project_id, record.intake_id)).resolves.toEqual(record);

    const incompatible = detectedRecord({
      source: { ...record.source, size: record.source.size + 1 }
    });
    await expect(repository.create(incompatible)).rejects.toThrow(/conflict|different/i);
  });

  it("advances durable phase idempotently while rejecting invalid durable transitions", async () => {
    const objects = new MemoryObjects();
    const repository = new InputIntakeRepository(objects);
    const record = detectedRecord();
    await repository.create(record);

    const advanced = await repository.advance(
      record.project_id,
      record.intake_id,
      "SNAPSHOTTED",
      "2026-08-31T11:56:00+01:00"
    );
    expect(advanced.phase).toBe("SNAPSHOTTED");
    await expect(repository.advance(
      record.project_id,
      record.intake_id,
      "SNAPSHOTTED",
      "2026-08-31T11:56:00+01:00"
    )).resolves.toEqual(advanced);
    await expect(repository.advance(
      record.project_id,
      record.intake_id,
      "DETECTED",
      "2026-08-31T11:57:00+01:00"
    )).rejects.toThrow(/transition|downgrade/i);
  });

  it("binds a source path to the latest intake with compare-and-swap semantics", async () => {
    const objects = new MemoryObjects();
    const repository = new InputIntakeRepository(objects);
    const first = detectedRecord();
    await repository.create(first);
    const initialBinding = await repository.bindSourcePath(first);
    expect(initialBinding).toMatchObject({
      project_id: first.project_id,
      provider_id: first.source.provider_id,
      source_path: first.source.provider_path,
      intake_id: first.intake_id,
      revision_token: first.source.revision_token
    });
    await expect(repository.bindSourcePath(first)).resolves.toEqual(initialBinding);

    const second: InputIntakeRecord = detectedRecord({
      intake_id: "INTAKE-222222222222222222222222",
      source: {
        ...first.source,
        revision_token: "rev-002",
        integrity_hash: { ...first.source.integrity_hash, value: "b".repeat(64) }
      },
      detected_at: "2026-08-31T11:57:00+01:00",
      updated_at: "2026-08-31T11:57:00+01:00"
    });
    await repository.create(second);

    await expect(repository.bindSourcePath(second)).rejects.toThrow(/binding|conflict/i);
    await expect(repository.bindSourcePath(second, { expectedIntakeId: first.intake_id })).resolves.toMatchObject({
      intake_id: second.intake_id,
      revision_token: second.source.revision_token
    });
    await expect(repository.readSourcePathBinding(
      second.project_id,
      second.source.provider_id,
      second.source.provider_path
    )).resolves.toMatchObject({ intake_id: second.intake_id });
  });
});
