import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { intakeIdFor } from "../src/domain/intake";
import { requireDropboxV1Evidence } from "../src/persistence/compatibility/dropbox-v1-evidence";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import {
  ManagedDocumentChangeCoordinator,
  type ManagedDocumentCursorStore
} from "../src/documents/change-coordinator";
import { IntakeRepository } from "../src/documents/intake-repository";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class CursorStore implements ManagedDocumentCursorStore {
  private readonly values = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
}

describe("managed document coordinator INPUT routing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("routes incremental INPUT discovery through the durable IntakeService journal", async () => {
    const mock = installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({
      appKey: "key",
      appSecret: "secret",
      refreshToken: "refresh"
    }));
    const state = emptyProjectState("PRJ-9010", "Coordinator intake", "coordinator-intake", "Use one intake engine");
    const coordinator = new ManagedDocumentChangeCoordinator(runtime, new CursorStore(), "observe");

    await coordinator.reconcile(state);
    const source = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9010-coordinator-intake/INPUTS/report.pdf";
    await mock.writeExternal(source, "%PDF coordinator intake");
    const metadata = await runtime.objects.getMetadata(source);
    if (!metadata) throw new Error("fixture metadata missing");
    const evidence = requireDropboxV1Evidence(metadata);

    const summary = await coordinator.reconcile(state);
    expect(summary.ingested).toBe(1);

    const intakeId = await intakeIdFor(state.project_id, runtime.providerId, evidence.file_id, evidence.rev);
    expect(await new IntakeRepository(runtime).read(state.project_id, intakeId)).toMatchObject({
      state: "ingested",
      logical_input_path: "report.pdf"
    });
  });
});
