import { describe, expect, it } from "vitest";
import type { ExecutionAdmission } from "../src/execution/contract";
import { ExecutionJournal } from "../src/execution/journal";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { requestDigest } from "../src/persistence/observation";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

describe("execution admission proof continuity", () => {
  it("fixture contract: preserves the exact approval_id and evidence_refs when an admitted request is recovered and replayed", async () => {
    const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
    const projectId = "PRJ-9258";
    const requestId = "REQ-APPROVAL-CONTINUITY-001";
    const hash = await requestDigest({ operation: "research.add", resource_id: "RES-APPROVAL0001", resource_version: "V1" });
    const frozenResults = [{
      verdict: "allow" as const,
      code: "EXACT_APPROVAL_VERIFIED",
      rule: { rule_id: "RULE-EXACT-APPROVAL", version: 3, scope: { kind: "project" as const, project_id: projectId } },
      expected: "approval for exact resource version",
      observed: "approved exact resource version",
      required_action: "none",
      resource_id: "RES-APPROVAL0001",
      approval_id: "APR-APPROVAL0001",
      evidence_refs: ["canonical:approval/APR-APPROVAL0001", "canonical:resource/RES-APPROVAL0001"]
    }];
    const admission: ExecutionAdmission = {
      project_id: projectId, kind: "transaction", request_id: requestId, operation: "research.add",
      request_hash: hash, actor: { actor_id: "reviewer", authority: "ingress" },
      resources: [{ resource_id: "RES-APPROVAL0001", resource_type: "research", zone: "PROJECT", version: "V1" }],
      global_revision: 7, project_revision: 12,
      ruleset: { digest: hash, rules: [], global_revision: 7, project_revision: 12 },
      verdict: "allow", results: frozenResults, gaps: [], deferred_rules: []
    };
    const cold = () => new ExecutionJournal(runtime, projectId, "transaction", requestId);
    const progressPath = `${await cold().root()}/progress.json`;
    const faults: DropboxMockFault[] = [];
    installDropboxMock({ faults });

    // This is a contract/storage fixture. It proves the journal preserves server-generated
    // approval result bytes across a cold retry; it does not mint or authorize approval.
    const first = cold();
    await first.commit(admission, null);
    expect((await first.status())?.status).toBe("admitted");

    // Simulate three provider acknowledgments lost after progress finalization
    // has reached storage. Each cold resume preserves V and the original proof.
    for (let interruption = 1; interruption <= 3; interruption += 1) {
      faults.push({ endpoint: "/2/files/upload", path: progressPath, occurrence: 1, status: 409,
        error_summary: "conflict/lost-ack", phase: "after" });
      const resumed = cold();
      const persisted = await resumed.readAdmission();
      expect(persisted?.admission.request_hash, `retry ${interruption} retains intent V`).toBe(hash);
      expect(persisted?.admission.results, `retry ${interruption} retains the exact approval`).toEqual(frozenResults);
      await resumed.commit(admission, null);
      await expect(resumed.recordReceipt("committed", "receipt:transaction-committed"), `lost provider acknowledgment ${interruption}`)
        .rejects.toThrow();
      expect((await cold().status())?.status, `retry ${interruption} sees persisted finalizing state`).toBe("finalizing");
    }
    const recovered = cold();
    expect((await recovered.readAdmission())?.admission.results).toEqual(frozenResults);
    await recovered.recordReceipt("committed", "receipt:transaction-committed");
    const finalized = await recovered.finalizeMaterializedTransaction({
      canonical_commit_ref: "canonical:commit:13",
      receipt_ref: "receipt:transaction-committed",
      materialization_head_ref: "materialization:head:13",
      materialization_record_ref: "materialization:record:13",
      target_revision: 13,
      source_event_id: "EVT-APPROVAL-CONTINUITY-13",
      result_root_hash: "c".repeat(64)
    });
    expect(finalized).toMatchObject({ status: "finalized", terminal: true, request_hash: hash });
    expect((await recovered.readAdmission())?.admission.results).toEqual(frozenResults);

    // V+1 changes the request's resource version and digest. The actual journal
    // contract rejects reusing V's request identity; production approval evaluation
    // is not exercised by this fixture and is not claimed here.
    const versionVPlusOneHash = await requestDigest({ operation: "research.add", resource_id: "RES-APPROVAL0001", resource_version: "V2" });
    const versionVPlusOne = {
      ...admission,
      request_hash: versionVPlusOneHash,
      resources: [{ ...admission.resources[0]!, version: "V2" }]
    };
    expect(versionVPlusOneHash).not.toBe(hash);
    await expect(cold().commit(versionVPlusOne, null)).rejects.toThrow("execution_identity_conflict");
  });
});
