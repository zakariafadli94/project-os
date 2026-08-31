import { describe, expect, it } from "vitest";
import type { CanonicalCommitRecord } from "../src/domain/commit-record";
import { CURRENT_PROJECTION_VERSION } from "../src/domain/materialization";
import type { ProjectGovernanceProfile } from "../src/domain/project-governance";
import type { Receipt } from "../src/domain/receipt";
import { parseTransaction } from "../src/domain/transaction";
import { applyTransaction } from "../src/domain/transitions";
import { GovernanceRepository } from "../src/governance/repository";
import { planProjection } from "../src/materialization/planner";
import { machineProjectGovernanceProfilePath } from "../src/persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../src/persistence/provider/contract";
import { ProviderConflictError, ProviderPreconditionFailedError } from "../src/persistence/provider/errors";

const at = "2026-08-30T08:05:00+01:00";

function memoryRuntime() {
  const files = new Map<string, string>();
  const runtime: ProjectOsPersistenceRuntime = {
    providerId: "test",
    objects: {
      readText: async (path) => files.get(path) ?? null,
      createText: async (path, content) => {
        if (files.has(path)) throw new ProviderConflictError("exists");
        files.set(path, content);
      },
      upsertText: async (path, content) => { files.set(path, content); },
      getMetadata: async (_path): Promise<ProviderObjectMetadata | null> => null,
      listChildren: async () => [],
      move: async (from, to) => {
        const content = files.get(from);
        if (content === undefined || files.has(to)) throw new ProviderConflictError("move conflict");
        files.delete(from);
        files.set(to, content);
      },
      delete: async (path) => { files.delete(path); }
    },
    conditionalWrite: {
      writeTextConditional: async () => { throw new ProviderPreconditionFailedError("unused"); }
    },
    serverSideCopy: {
      copyObject: async (_from, to) => ({ path: to, size: 0 })
    },
    changeFeed: {
      listChanges: async () => ({ entries: [], cursor: "cursor" })
    },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" },
      revisionToken: { semantics: "opaque-object-revision" },
      integrityHash: { semantics: "identified-algorithm" }
    }
  };
  return { runtime, files };
}

function profile(): ProjectGovernanceProfile {
  return {
    schema_version: "1.0",
    project_id: "PRJ-9201",
    project_kind: "synthetic_probe",
    authorization_id: "PCAUTH-CCCCCCCCCCCCCCCCCCCCCCCC",
    improvement_package_id: "IMP-GOV001",
    created_at: at
  };
}

function createRecord(): CanonicalCommitRecord {
  const transaction = parseTransaction({
    schema_version: "1.0",
    transaction_id: "TXN-GOV-MAT-9201-CREATE",
    project_id: "PRJ-9201",
    base_revision: 0,
    operation: "project.create",
    created_at: at,
    payload: {
      name: "Governance Probe",
      slug: "governance-probe",
      aliases: [],
      objective: "Prove governance profile rendering"
    }
  });
  const result = applyTransaction(null, transaction);
  if (result.kind !== "commit") throw new Error(`fixture failed: ${result.kind}`);
  const receipt: Receipt & { status: "committed"; event_id: string } = {
    schema_version: "1.0",
    transaction_id: transaction.transaction_id,
    status: "committed",
    project_id: transaction.project_id,
    previous_revision: 0,
    new_revision: result.state.revision,
    event_id: result.event.event_id,
    committed_at: at
  };
  return {
    schema_version: "1.0",
    project_id: transaction.project_id,
    previous_revision: 0,
    new_revision: result.state.revision,
    transaction,
    state: result.state,
    event: result.event,
    receipt
  };
}

describe("project governance persistence", () => {
  it("safe-adds an immutable profile and never invents one when absent", async () => {
    const { runtime, files } = memoryRuntime();
    const repository = new GovernanceRepository(runtime);

    expect(await repository.readProjectProfile("PRJ-9201")).toBeNull();
    await repository.writeProjectProfile(profile());
    expect(await repository.readProjectProfile("PRJ-9201")).toEqual(profile());
    expect(files.has(machineProjectGovernanceProfilePath("PRJ-9201"))).toBe(true);

    await expect(repository.writeProjectProfile(profile())).resolves.toBeUndefined();
    await expect(repository.writeProjectProfile({ ...profile(), project_kind: "real", improvement_package_id: undefined }))
      .rejects.toThrow(/conflict|different/i);
  });

  it("threads the separate profile into PROJECT.md planning without changing ProjectState", async () => {
    const record = createRecord();
    const stateBefore = structuredClone(record.state);
    const plan = await planProjection(record, null, CURRENT_PROJECTION_VERSION, profile());
    const project = plan.changed_outputs.get("global:PROJECT");

    expect(project?.content).toContain("Project kind: synthetic_probe");
    expect(project?.content).toContain("Synthetic project — fictitious / non-business");
    expect(record.state).toEqual(stateBefore);
  });
});
