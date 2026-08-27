import { describe, expect, it, vi } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { ManagedDocumentChangeCoordinator } from "../src/documents/change-coordinator";
import type { DropboxTransport } from "../src/dropbox/client";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

function unusedTransport(): DropboxTransport {
  return {
    async upload() { throw new Error("archived reconciliation must not upload"); },
    async download() { throw new Error("archived reconciliation must not download"); },
    async move() { throw new Error("archived reconciliation must not move"); }
  };
}

describe("MutationGate archived reconciliation mode", () => {
  it("reports the configured enforce mode without touching provider or cursor state", async () => {
    const cursorStore = {
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => true)
    };
    const coordinator = new ManagedDocumentChangeCoordinator(persistenceFromDropbox(unusedTransport()), cursorStore, "enforce");
    const state = emptyProjectState("PRJ-9903", "Archived Gate", "archived-gate", "Archived mode contract");
    state.status = "archived";

    await expect(coordinator.reconcile(state)).resolves.toMatchObject({
      archived: true,
      mutation_gate_mode: "enforce",
      candidates: 0,
      policy_violations: 0
    });
    expect(cursorStore.get).not.toHaveBeenCalled();
    expect(cursorStore.put).not.toHaveBeenCalled();
    expect(cursorStore.delete).not.toHaveBeenCalled();
  });
});
