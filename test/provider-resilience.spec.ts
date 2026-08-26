import { expect, it, vi } from "vitest";
import type { ObjectPersistence } from "../src/persistence/provider/contract";
import type { PersistenceRuntime } from "../src/persistence/provider/capabilities";
import { ProviderConflictError, ProviderOperationError } from "../src/persistence/provider/errors";
import { withProviderResilience } from "../src/persistence/provider/resilience";

function runtimeWith(overrides: Partial<ObjectPersistence>): PersistenceRuntime {
  const objects: ObjectPersistence = {
    readText: async () => null,
    createText: async () => undefined,
    upsertText: async () => undefined,
    getMetadata: async () => null,
    listChildren: async () => [],
    move: async () => undefined,
    delete: async () => undefined,
    ...overrides
  };
  return {
    providerId: "test",
    objects,
    conditionalWrite: { writeTextConditional: async () => ({ path: "/x", size: 0 }) },
    serverSideCopy: { copyObject: async () => ({ path: "/x", size: 0 }) },
    changeFeed: { listChanges: async () => ({ entries: [], cursor: "cursor" }) },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" },
      revisionToken: { semantics: "opaque-object-revision" },
      integrityHash: { semantics: "identified-algorithm" }
    }
  };
}

it("retries only provider failures marked retryable", async () => {
  let attempts = 0;
  const runtime = runtimeWith({
    readText: async () => {
      attempts += 1;
      if (attempts < 3) throw new ProviderOperationError("temporary", true);
      return "ok";
    }
  });
  const sleep = vi.fn(async () => undefined);
  const resilient = withProviderResilience(runtime, { maxAttempts: 5, baseDelayMs: 1, sleep, random: () => 0 });
  await expect(resilient.objects.readText("/x")).resolves.toBe("ok");
  expect(attempts).toBe(3);
  expect(sleep).toHaveBeenCalledTimes(2);
});

it("does not retry terminal provider failures", async () => {
  let attempts = 0;
  const runtime = runtimeWith({
    readText: async () => {
      attempts += 1;
      throw new ProviderOperationError("terminal", false);
    }
  });
  const resilient = withProviderResilience(runtime, { maxAttempts: 5, sleep: async () => undefined });
  await expect(resilient.objects.readText("/x")).rejects.toThrow("terminal");
  expect(attempts).toBe(1);
});

it("preserves exact-content move replay cleanup", async () => {
  const files = new Map<string, string>([["/from", "same"], ["/to", "same"]]);
  const runtime = runtimeWith({
    move: async () => { throw new ProviderConflictError("destination exists"); },
    readText: async (path) => files.get(path) ?? null,
    delete: async (path) => { files.delete(path); }
  });
  const resilient = withProviderResilience(runtime, { maxAttempts: 1 });
  await resilient.objects.move("/from", "/to");
  expect(files.has("/from")).toBe(false);
  expect(files.get("/to")).toBe("same");
});
