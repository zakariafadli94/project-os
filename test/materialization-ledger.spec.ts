import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ProjectionOutputEvidence } from "../src/domain/materialization";
import {
  initializeMaterializationSchema,
  MaterializationLedger
} from "../src/materialization/ledger";

async function withLedger<T>(projectId: string, fn: (ledger: MaterializationLedger) => T | Promise<T>): Promise<T> {
  const stub = env.PROJECT_GUARD.getByName(projectId);
  return runInDurableObject(stub, async (_instance, state) => {
    initializeMaterializationSchema(state.storage);
    return fn(new MaterializationLedger(state.storage));
  });
}

function evidence(path: string, seed: string, sourceRevision: number): ProjectionOutputEvidence {
  return {
    relative_path: path,
    input_hash: seed.repeat(64).slice(0, 64),
    content_hash: seed.toUpperCase().repeat(64).slice(0, 64).toLowerCase(),
    source_revision: sourceRevision
  };
}

describe("MaterializationLedger", () => {
  it("coalesces queued revisions before a target starts", async () => {
    await withLedger("PRJ-3401", (ledger) => {
      ledger.requestTarget({ revision: 2, projection_version: 1 });
      ledger.requestTarget({ revision: 3, projection_version: 1 });
      ledger.requestTarget({ revision: 5, projection_version: 1 });
      expect(ledger.beginNextTarget()).toEqual({
        revision: 5,
        projection_version: 1,
        coalesced_revisions: [2, 3, 4]
      });
    });
  });

  it("does not preempt an active target and selects newer work after completion", async () => {
    await withLedger("PRJ-3402", (ledger) => {
      ledger.requestTarget({ revision: 5, projection_version: 1 });
      expect(ledger.beginNextTarget()?.revision).toBe(5);
      ledger.requestTarget({ revision: 6, projection_version: 1 });
      expect(ledger.beginNextTarget()?.revision).toBe(5);
      ledger.completeTarget({ revision: 5, projection_version: 1, outputs: new Map(), removed_outputs: [] });
      expect(ledger.beginNextTarget()).toEqual({ revision: 6, projection_version: 1, coalesced_revisions: [] });
    });
  });

  it("treats a projection-version change at the same business revision as pending work", async () => {
    await withLedger("PRJ-3403", (ledger) => {
      ledger.restoreExternalBaseline(
        { revision: 7, projection_version: 1 },
        new Map([["global:STATE", evidence("STATE.md", "a", 7)]])
      );
      ledger.requestTarget({ revision: 7, projection_version: 2 });
      expect(ledger.beginNextTarget()).toEqual({ revision: 7, projection_version: 2, coalesced_revisions: [] });
    });
  });

  it("persists verified output progress across ledger instances", async () => {
    const projectId = "PRJ-3404";
    const stub = env.PROJECT_GUARD.getByName(projectId);
    await runInDurableObject(stub, async (_instance, state) => {
      initializeMaterializationSchema(state.storage);
      const first = new MaterializationLedger(state.storage);
      first.requestTarget({ revision: 4, projection_version: 1 });
      first.beginNextTarget();
      first.recordVerifiedOutput("global:STATE", evidence("STATE.md", "b", 4));

      const second = new MaterializationLedger(state.storage);
      expect(second.attemptOutputs()).toEqual(new Map([
        ["global:STATE", evidence("STATE.md", "b", 4)]
      ]));
    });
  });

  it("failure does not advance completed head", async () => {
    await withLedger("PRJ-3405", (ledger) => {
      ledger.requestTarget({ revision: 3, projection_version: 1 });
      ledger.beginNextTarget();
      ledger.failActive("provider conflict");
      const status = ledger.status();
      expect(status.head).toBeNull();
      expect(status.active?.revision).toBe(3);
      expect(status.last_error).toBe("provider conflict");
    });
  });

  it("completes atomically by applying output deltas, removals, head update and preserving newer queued work", async () => {
    await withLedger("PRJ-3406", (ledger) => {
      const old = new Map([
        ["global:BRIEF", evidence("BRIEF.md", "c", 2)],
        ["task:TASK-OLD3406", evidence("TASKS/TASK-OLD3406.md", "d", 2)]
      ]);
      ledger.restoreExternalBaseline({ revision: 2, projection_version: 1 }, old);
      ledger.requestTarget({ revision: 3, projection_version: 1 });
      ledger.beginNextTarget();
      ledger.recordVerifiedOutput("global:STATE", evidence("STATE.md", "e", 3));
      ledger.requestTarget({ revision: 4, projection_version: 1 });

      ledger.completeTarget({
        revision: 3,
        projection_version: 1,
        outputs: new Map([
          ["global:BRIEF", evidence("BRIEF.md", "f", 3)],
          ["global:STATE", evidence("STATE.md", "e", 3)]
        ]),
        removed_outputs: ["task:TASK-OLD3406"]
      });

      expect(ledger.baselineOutputs()).toEqual(new Map([
        ["global:BRIEF", evidence("BRIEF.md", "f", 3)],
        ["global:STATE", evidence("STATE.md", "e", 3)]
      ]));
      expect(ledger.attemptOutputs().size).toBe(0);
      expect(ledger.status().head).toEqual({ revision: 3, projection_version: 1 });
      expect(ledger.status().requested).toEqual({ revision: 4, projection_version: 1 });
    });
  });

  it("restores an external completed baseline and exposes compact status", async () => {
    await withLedger("PRJ-3407", (ledger) => {
      ledger.restoreExternalBaseline(
        { revision: 9, projection_version: 2 },
        new Map([
          ["global:STATE", evidence("STATE.md", "1", 9)],
          ["global:HANDOFF", evidence("HANDOFF.md", "2", 9)]
        ])
      );
      const status = ledger.status();
      expect(status.head).toEqual({ revision: 9, projection_version: 2 });
      expect(status.output_count).toBe(2);
      expect(status.attempt_output_count).toBe(0);
      expect(status.active).toBeNull();
    });
  });
});
