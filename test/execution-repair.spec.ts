import { describe, expect, it } from "vitest";
import { authorizeRepair, parseRepairIntent } from "../src/execution/repair";
import type { ExecutionAdmission } from "../src/execution/contract";

const hash = "a".repeat(64);
const resources = [{ resource_id: "DOC-EXACT", resource_type: "document", zone: "WORKING", version: "V1" }];
const intent = parseRepairIntent({ project_id: "PRJ-8294", operation: "project.repair", request_id: "REPAIR-8294", base_revision: 4, resources, diagnosed_drift_refs: ["drift:8294"], action: { kind: "resume_committed", original_kind: "document", original_request_id: "REQ-8294", effect_plan_hash: hash } });
const original = { admission: { project_id: intent.project_id, request_id: "REQ-8294", kind: "document", resources } as ExecutionAdmission, effect_plan_hash: hash };
const proof = { project_id: intent.project_id, project_revision: 4, resources, diagnosis: "interrupted_verified_copy", evidence_ref: "server:drift-proof" };

describe("typed deterministic repair", () => {
  it("is unavailable without a server-resolved diagnosis", async () => {
    await expect(authorizeRepair(intent, 4, original, async () => null)).rejects.toThrow("repair_evidence_unavailable");
  });
  it("authorizes only the exact original intent and current canonical revision", async () => {
    await expect(authorizeRepair(intent, 4, original, async () => proof)).resolves.toEqual(["server:drift-proof"]);
    await expect(authorizeRepair(intent, 5, original, async () => proof)).rejects.toThrow("repair_revision_conflict");
    await expect(authorizeRepair(intent, 4, { ...original, effect_plan_hash: "b".repeat(64) }, async () => proof)).rejects.toThrow("repair_intent_conflict");
    await expect(authorizeRepair({ ...intent, resources: [...resources, { ...resources[0], resource_id: "EXTRA" }] }, 4, original, async () => proof)).rejects.toThrow("repair_resources_conflict");
  });
  it("cannot use another project's diagnosis or an unchecked observation", async () => {
    await expect(authorizeRepair(intent, 4, original, async () => ({ ...proof, project_id: "PRJ-8295" }))).rejects.toThrow("repair_evidence_unavailable");
    await expect(authorizeRepair(intent, 4, original, async () => ({ ...proof, evidence_ref: "" }))).rejects.toThrow("repair_evidence_unavailable");
  });
});
