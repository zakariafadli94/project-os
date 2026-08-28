import { describe, expect, it } from "vitest";
import type {
  ExternalMutationCandidateRecord,
  ExternalMutationResolutionRecord
} from "../src/domain/mutation-gate";
import {
  MutationGateRepository,
  MutationResolutionConflictError,
  type MutationResolutionTerminalEvidence
} from "../src/mutation-gate/repository";
import {
  machineMutationCandidatePath,
  machineMutationResolutionPath
} from "../src/persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../src/persistence/provider/capabilities";
import { ProviderConflictError } from "../src/persistence/provider/errors";

const projectId = "PRJ-0003";
const candidateId = "MUTCAND-AAAAAAAAAAAAAAAAAAAAAAAA";
const resolutionId = "MUTRES-BBBBBBBBBBBBBBBBBBBBBBBB";
const requestHash = "c".repeat(64);

const candidate: ExternalMutationCandidateRecord = {
  schema_version: "1.0",
  candidate_id: candidateId,
  project_id: projectId,
  source: "external_unverified",
  detection_source: "incremental",
  provider_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-test/ARTIFACTS/example.md",
  provider_file_id: "id:test-candidate",
  provider_rev: "rev-1",
  provider_content_hash: "d".repeat(64),
  size: 7,
  immutable_payload_path: `/PROJECT_OS/.project-os/projects/${projectId}/mutation-gate/payloads/candidates/${candidateId}/payload`,
  detected_at: "2026-08-28T12:00:00Z"
};

const resolution: ExternalMutationResolutionRecord = {
  schema_version: "1.0",
  resolution_id: resolutionId,
  project_id: projectId,
  candidate_id: candidateId,
  action: "reject",
  resolved_at: "2026-08-28T12:01:00Z"
};

const terminalEvidence: MutationResolutionTerminalEvidence = {
  schema_version: "1.0",
  project_id: projectId,
  candidate_id: candidateId,
  resolution_id: resolutionId,
  resolution,
  resolution_request_sha256: requestHash
};

describe("MutationGate terminal replay write amplification", () => {
  it("replays complete terminal evidence without issuing createText", async () => {
    const harness = repositoryHarness({ includeResolution: true });

    await expect(harness.repository.writeResolution(resolution, requestHash)).resolves.toEqual(resolution);

    expect(harness.createCalls).toEqual([]);
  });

  it("repairs a missing resolution record behind compatible terminal evidence", async () => {
    const harness = repositoryHarness({ includeResolution: false });
    const resolutionPath = machineMutationResolutionPath(projectId, candidateId, resolutionId);

    await expect(harness.repository.writeResolution(resolution, requestHash)).resolves.toEqual(resolution);

    expect(harness.createCalls).toEqual([resolutionPath]);
    expect(harness.files.get(resolutionPath)).toBe(pretty(resolution));
  });

  it("rejects a divergent resolution record behind compatible terminal evidence", async () => {
    const harness = repositoryHarness({
      includeResolution: true,
      storedResolution: { ...resolution, resolved_at: "2026-08-28T12:02:00Z" }
    });

    await expect(harness.repository.writeResolution(resolution, requestHash))
      .rejects.toBeInstanceOf(MutationResolutionConflictError);
  });
});

function repositoryHarness(input: {
  includeResolution: boolean;
  storedResolution?: ExternalMutationResolutionRecord;
}) {
  const candidatePath = machineMutationCandidatePath(projectId, candidateId);
  const resolutionPath = machineMutationResolutionPath(projectId, candidateId, resolutionId);
  const terminalPath = resolutionPath.slice(0, -`/${resolutionId}.json`.length) + "/terminal.json";
  const files = new Map<string, string>([
    [candidatePath, pretty(candidate)],
    [terminalPath, pretty(terminalEvidence)]
  ]);
  if (input.includeResolution) files.set(resolutionPath, pretty(input.storedResolution ?? resolution));

  const createCalls: string[] = [];
  const runtime: ProjectOsPersistenceRuntime = {
    providerId: "test",
    objects: {
      readText: async (path) => files.get(path) ?? null,
      createText: async (path, content) => {
        createCalls.push(path);
        if (files.has(path)) throw new ProviderConflictError(`exists: ${path}`);
        files.set(path, content);
      },
      upsertText: async (path, content) => { files.set(path, content); },
      getMetadata: async () => null,
      listChildren: async () => [],
      move: async () => undefined,
      delete: async (path) => { files.delete(path); }
    },
    conditionalWrite: {
      writeTextConditional: async () => ({ path: "/unused", size: 0 })
    },
    serverSideCopy: {
      copyObject: async () => ({ path: "/unused", size: 0 })
    },
    changeFeed: {
      listChanges: async () => ({ entries: [], cursor: "unused" })
    },
    evidence: {
      stableObjectId: { semantics: "stable-through-move" },
      revisionToken: { semantics: "opaque-object-revision" },
      integrityHash: { semantics: "identified-algorithm" }
    }
  };

  return {
    repository: new MutationGateRepository(runtime),
    files,
    createCalls
  };
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
