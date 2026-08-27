import { describe, expect, it, vi } from "vitest";
import { DropboxApiError, type DropboxTransport } from "../src/dropbox/client";
import { machineStatePath } from "../src/dropbox/layout";
import { ProjectRepository } from "../src/dropbox/repository";
import { emptyProjectState } from "../src/domain/transitions";
import { createDropboxPersistence } from "../src/persistence/providers/dropbox/adapter";
import { ProviderOperationError } from "../src/persistence/provider/errors";
import { withProviderResilience } from "../src/persistence/provider/resilience";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

function baseTransport(download: DropboxTransport["download"]): DropboxTransport {
  return {
    upload: async () => undefined,
    download,
    move: async () => undefined,
    getMetadata: async () => null,
    listFolder: async () => [],
    delete: async () => undefined
  };
}

describe("Dropbox provider reads fail closed", () => {
  it("maps and does not retry a non-transient read failure", async () => {
    const download = vi.fn<DropboxTransport["download"]>()
      .mockRejectedValue(new DropboxApiError("invalid request", 400, "req-bad-read", "invalid_arg"));
    const sleep = vi.fn(async () => undefined);
    const runtime = withProviderResilience(createDropboxPersistence(baseTransport(download)), {
      sleep,
      random: () => 0
    });

    const failure = await runtime.objects.readText("/PROJECT_OS/.project-os/projects/PRJ-0002/state.json")
      .then(() => null, (error) => error);

    expect(failure).toBeInstanceOf(ProviderOperationError);
    expect(failure).toMatchObject({
      retryable: false,
      diagnostics: { providerId: "dropbox", status: 400, requestId: "req-bad-read" }
    });
    expect(download).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("still rejects canonical state bound to a different project", async () => {
    const expectedProjectId = "PRJ-2101";
    const wrongState = emptyProjectState("PRJ-9999", "Wrong Project", "wrong-project", "Wrong binding");
    wrongState.revision = 1;
    wrongState.last_event_id = "EVT-000001";
    wrongState.created_at = "2026-08-24T07:00:00+01:00";
    wrongState.updated_at = wrongState.created_at;

    const download = vi.fn<DropboxTransport["download"]>(async (path) => {
      if (path === machineStatePath(expectedProjectId)) return JSON.stringify(wrongState);
      return null;
    });
    const repository = new ProjectRepository(persistenceFromDropbox(baseTransport(download)), "v2");

    await expect(repository.readProjectState(expectedProjectId))
      .rejects.toThrow(`Canonical project state binding mismatch: expected ${expectedProjectId}, got PRJ-9999`);
    expect(download).toHaveBeenCalledTimes(1);
  });
});
