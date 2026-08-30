import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { workspaceManagedDocumentPath } from "../src/persistence/layout";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { IntakeSweep } from "../src/documents/intake-sweep";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

const at = "2026-08-30T12:45:00.000Z";

function runtime() {
  return persistenceFromDropbox(new DropboxClient({
    appKey: "key",
    appSecret: "secret",
    refreshToken: "refresh"
  }), {
    sleep: async () => undefined,
    random: () => 0
  });
}

describe("IntakeSweep", () => {
  afterEach(() => vi.restoreAllMocks());

  it("discovers and ingests a nested INPUT without using the provider change cursor", async () => {
    const mock = installDropboxMock();
    const persistence = runtime();
    const state = emptyProjectState("PRJ-9012", "Sweep", "sweep", "Discover missed inputs");
    const source = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9012-sweep/INPUTS/nested/report.pdf";
    await mock.writeExternal(source, "%PDF sweep payload");

    const result = await new IntakeSweep(persistence).sweep(state, at);

    expect(result).toMatchObject({ archived: false, files_scanned: 1, ingested: 1, duplicates: 0, failed: 0 });
    expect(mock.files.has(source)).toBe(false);
    expect(mock.files.get(workspaceManagedDocumentPath(
      state.project_id,
      state.slug,
      "references",
      "UNCLASSIFIED/nested/report.pdf"
    ))).toBe("%PDF sweep payload");
  });

  it("skips archived projects without touching their INPUTS", async () => {
    const mock = installDropboxMock();
    const persistence = runtime();
    const state = emptyProjectState("PRJ-9013", "Archived sweep", "archived-sweep", "Skip archived inputs");
    state.status = "archived";
    const source = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9013-archived-sweep/INPUTS/report.pdf";
    await mock.writeExternal(source, "%PDF archived");

    const result = await new IntakeSweep(persistence).sweep(state, at);

    expect(result).toEqual({ archived: true, files_scanned: 0, ingested: 0, duplicates: 0, failed: 0 });
    expect(mock.files.get(source)).toBe("%PDF archived");
  });
});
