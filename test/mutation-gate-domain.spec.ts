import { describe, expect, it } from "vitest";
import {
  mutationCandidateIdFor,
  mutationIntentIdFor,
  mutationResolutionIdFor,
  parseExternalMutationCandidateRecord
} from "../src/domain/mutation-gate";

describe("mutation gate domain", () => {
  it("derives deterministic project-bound ids", async () => {
    const intent = await mutationIntentIdFor("PRJ-0002", "ART-MUTATION-000001");
    expect(intent).toMatch(/^MUTINT-[A-F0-9]{24}$/);
    expect(await mutationIntentIdFor("PRJ-0002", "ART-MUTATION-000001")).toBe(intent);
    expect(await mutationIntentIdFor("PRJ-0003", "ART-MUTATION-000001")).not.toBe(intent);

    const candidate = await mutationCandidateIdFor({
      projectId: "PRJ-0002",
      providerFileId: "id:abc",
      providerRev: "rev-17"
    });
    expect(candidate).toMatch(/^MUTCAND-[A-F0-9]{24}$/);

    const resolution = await mutationResolutionIdFor("PRJ-0002", candidate, "candidate.reject");
    expect(resolution).toMatch(/^MUTRES-[A-F0-9]{24}$/);
  });

  it("rejects candidate evidence bound to another project namespace", () => {
    expect(() => parseExternalMutationCandidateRecord({
      schema_version: "1.0",
      candidate_id: "MUTCAND-111111111111111111111111",
      project_id: "PRJ-0002",
      source: "external_unverified",
      detection_source: "incremental",
      provider_path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/DELIVERABLES/x.md",
      provider_file_id: "id:abc",
      provider_rev: "rev-17",
      provider_content_hash: "a".repeat(64),
      size: 3,
      immutable_payload_path: "/PROJECT_OS/.project-os/projects/PRJ-0003/mutation-gate/payloads/candidates/MUTCAND-111111111111111111111111/payload",
      detected_at: "2026-08-25T16:00:00+01:00"
    })).toThrow(/project/i);
  });
});
