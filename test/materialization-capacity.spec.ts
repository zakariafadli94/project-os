import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { initialProgress, ConvergenceJournal } from "../src/convergence/journal";
import type { Obligation } from "../src/convergence/contract";
import { createProductionPersistence } from "../src/persistence/production-factory";
import type { Env } from "../src/env";
import { installDropboxMock } from "./helpers/mock-dropbox";

const testEnv = env as unknown as Env;

function obligation(id: string, overrides: Partial<Obligation> = {}): Obligation {
  return {
    id, layer: "human_handoff", from_revision: 0,
    target: { revision: 3, projection_version: 6 }, incident: 1,
    state: "pending", first_pending_at: "2020-01-01T00:00:00.000Z",
    next_attempt_at: null, failure_count: 0, last_attempt_number: 0,
    last_closed_attempt_number: 0, last_verified_at: null, code: null,
    lease_until: null, continuation: null, ...overrides
  };
}

describe("MaterializationGuard admission capacity diagnostics", () => {
  it("does not charge empty or verified continuations as executable work and diagnoses terminal repair", async () => {
    installDropboxMock();
    const projectId = "PRJ-8393";
    const now = new Date().toISOString();
    const progress = initialProgress(projectId, now, "capacity-diagnostic");
    progress.obligations = {
      ["a".repeat(64)]: obligation("a".repeat(64), { state: "verified", continuation: "done" }),
      ["b".repeat(64)]: obligation("b".repeat(64), { state: "running", continuation: "" }),
      ["c".repeat(64)]: obligation("c".repeat(64), {
        state: "blocked", continuation: null, code: "manual_repair_required"
      })
    };
    const journal = new ConvergenceJournal(createProductionPersistence(testEnv, projectId), projectId);
    await journal.save(progress, null);

    const response = await testEnv.MATERIALIZATION_GUARD.getByName(projectId)
      .fetch("https://materialization-guard.internal/capacity");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      queued_outputs: 0,
      oldest_pending_seconds: 0,
      continuation_available: true,
      within_qualified_envelope: true,
      reason: "repair_required",
      canonical_revision: 3,
      blocking_obligation: {
        layer: "human_handoff",
        target_revision: 3,
        code: "manual_repair_required"
      },
      retry_after_seconds: null
    });
  });
});
