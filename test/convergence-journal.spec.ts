import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Canonical } from "../src/materialization/hash";
import { ConvergenceJournal, initialProgress } from "../src/convergence/journal";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";
import { installDropboxMock } from "./helpers/mock-dropbox";

afterEach(() => vi.restoreAllMocks());

describe("convergence journal", () => {
  it("retains an immutable reservation across a new journal instance", async () => {
    installDropboxMock();
    const runtime = persistenceFromDropbox(new DropboxClient({
      appKey: "key",
      appSecret: "secret",
      refreshToken: "refresh"
    }));
    const journal = new ConvergenceJournal(runtime, "PRJ-9258");
    const obligationId = await sha256Canonical({ project: "PRJ-9258", layer: "head", from: 258, pv: 3, incident: 1 });
    const attempt = {
      schema_version: "1.0" as const,
      project_id: "PRJ-9258",
      obligation_id: obligationId,
      layer: "head" as const,
      from_revision: 258,
      target: { revision: 258, projection_version: 3 },
      attempt_number: 1,
      incident: 1,
      incarnation: "writer-1",
      reserved_at: "2026-09-08T00:00:00.000Z",
      lease_until: "2026-09-08T00:00:10.000Z"
    };

    await journal.save(initialProgress("PRJ-9258", attempt.reserved_at, attempt.incarnation), null);
    await journal.reserve(attempt);

    const coldJournal = new ConvergenceJournal(runtime, "PRJ-9258");
    await coldJournal.reserve(attempt);
    await expect(coldJournal.listAttempts(obligationId)).resolves.toEqual([attempt]);
    await expect(coldJournal.reserve({ ...attempt, incarnation: "writer-2" })).rejects.toThrow(
      "journal_integrity_conflict"
    );
  });
});
