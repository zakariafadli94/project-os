import { describe, expect, it, vi } from "vitest";
import { DropboxApiError, type DropboxTransport } from "../src/dropbox/client";
import { machineStatePath } from "../src/dropbox/layout";
import { ProjectRepository } from "../src/dropbox/repository";
import { ResilientDropboxTransport } from "../src/dropbox/resilient-transport";
import { emptyProjectState } from "../src/domain/transitions";

function baseTransport(download: DropboxTransport["download"]): DropboxTransport {
  return {
    upload: async () => undefined,
    download,
    move: async () => undefined
  };
}

describe("Dropbox resilient reads fail closed", () => {
  it("does not retry a non-transient read failure", async () => {
    const download = vi.fn<DropboxTransport["download"]>()
      .mockRejectedValue(new DropboxApiError("invalid request", 400, "req-bad-read", "invalid_arg"));
    const sleep = vi.fn(async () => undefined);
    const transport = new ResilientDropboxTransport(baseTransport(download), {
      sleep,
      random: () => 0
    });

    await expect(transport.download("/PROJECT_OS/.project-os/projects/PRJ-0002/state.json"))
      .rejects.toMatchObject({ status: 400, requestId: "req-bad-read" });

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
    const repository = new ProjectRepository(baseTransport(download), "v2");

    await expect(repository.readProjectState(expectedProjectId))
      .rejects.toThrow(`Canonical project state binding mismatch: expected ${expectedProjectId}, got PRJ-9999`);
    expect(download).toHaveBeenCalledTimes(1);
  });
});
