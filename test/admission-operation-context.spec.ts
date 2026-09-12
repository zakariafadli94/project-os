import { describe, expect, it } from "vitest";
import { normalizeArtifactAdmission, normalizeCandidateResolutionAdmission, normalizeDocumentAdmission, normalizeSystemAdmission, normalizeTransactionAdmission } from "../src/admission/operation-context";
import { emptyProjectState } from "../src/domain/transitions";
import { documentIdFor } from "../src/domain/managed-document";
import { candidate } from "./helpers/review-candidate";

describe("server-owned admission normalization", () => {
  it("preserves the typed REVIEW_CANDIDATE intent rather than treating its filename as an ordinary artifact", async () => {
    const normalized = await normalizeArtifactAdmission(candidate, emptyProjectState(candidate.project_id, "Review", "review"));
    expect(normalized.resources[0]).toMatchObject({ resource_id: candidate.request_id, zone: "REVIEW", relative_path: "example.pdf", artifact_operation: "REVIEW_CANDIDATE" });
  });
  it.each(["WORKING", "DELIVERABLES", "ARCHIVES"])("uses the accepted server route's %s zone, not the client alias", async (zone) => {
    const state = emptyProjectState("PRJ-8101", "Routing", "routing");
    state.decisions["DEC-8101"] = { decision_id: "DEC-8101", title: "Route", decision: "Route", reason: "accepted", impacts: [], status: "accepted", created_at: "2026-09-12T12:00:00Z", updated_at: "2026-09-12T12:00:00Z" };
    state.artifact_routes["ROUTE-8101"] = { route_id: "ROUTE-8101", source_prefix: "CLIENT-ALIAS", target_prefix: `${zone}/approved`, exclusive: true, decision_ids: ["DEC-8101"], created_at: "2026-09-12T12:00:00Z", updated_at: "2026-09-12T12:00:00Z" };
    const request = { request_id: "ART-81010000", project_id: state.project_id, relative_path: "CLIENT-ALIAS/a.md", content_sha256: "a".repeat(64), mode: "create" as const, content: "body" };
    const normalized = await normalizeArtifactAdmission(request, state);
    expect(normalized.resources[0]).toMatchObject({ zone, relative_path: "CLIENT-ALIAS/a.md" });
    state.decisions["DEC-8101"].status = "superseded";
    await expect(normalizeArtifactAdmission(request, state)).rejects.toThrow();
  });
  it("maps an artifact request to the registered artifact operation without accepting client rules", async () => {
    const normalized = await normalizeArtifactAdmission({
      request_id: "ART-81010000", project_id: "PRJ-8101", relative_path: "DELIVERABLES/a.md", content_sha256: "a".repeat(64), mode: "create", content: "body"
    }, emptyProjectState("PRJ-8101", "Routing", "routing"));

    expect(normalized.operation).toBe("artifact.write");
    expect(normalized.resources).toEqual([{ resource_id: "ART-81010000", resource_type: "artifact", zone: "ARTIFACTS", version: "a".repeat(64), relative_path: "DELIVERABLES/a.md" }]);
    expect(normalized.request_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maps managed-document and transaction operations to catalogue operation names", async () => {
    const document = await normalizeDocumentAdmission({ operation: "publish", request_id: "DOCREQ-81010000", project_id: "PRJ-8101", document_id: "DOC-ABCDEF0123456789ABCDEF01", created_at: "2026-09-12T12:00:00.000Z" });
    const request = { schema_version: "1.0" as const, transaction_id: "TXN-81010000", project_id: "PRJ-8101", base_revision: 4, created_at: "2026-09-12T12:00:00.000Z", operation: "task.create" as const, payload: { task_id: "TASK-8101", title: "Task" } };
    const transaction = await normalizeTransactionAdmission(request);

    expect(document.operation).toBe("document.publish");
    expect(document.resources[0]).toMatchObject({ resource_id: "DOC-ABCDEF0123456789ABCDEF01", resource_type: "document", zone: "DOCUMENTS" });
    expect(transaction.operation).toBe("task.create");
    expect(transaction.resources[0]).toMatchObject({ resource_id: request.transaction_id, resource_type: "task", zone: "PROJECT" });
  });

  it("maps review-candidate promotion to the registered review promotion control", async () => {
    const normalized = await normalizeDocumentAdmission({ operation: "review_candidate.promote", request_id: "DOCREQ-81010001", project_id: "PRJ-8101", candidate_request_id: "ART-81010001", logical_path: "reports/candidate.pdf", expected_project_revision: 4, accepted: true, created_at: "2026-09-12T12:00:00.000Z" });

    expect(normalized.operation).toBe("review.promote");
    expect(normalized.resources[0]).toMatchObject({ resource_id: await documentIdFor("PRJ-8101", "reports/candidate.pdf"), resource_type: "document", zone: "DOCUMENTS" });
  });

  it("maps candidate resolution and recovery to registered system operations with exact resources", async () => {
    const candidate = await normalizeCandidateResolutionAdmission({ operation: "candidate.reject", resolution_id: "MUTRES-810100000000000000000001", project_id: "PRJ-8101", candidate_id: "MUTCAND-810100000000000000000001" });
    const recovery = await normalizeSystemAdmission("PRJ-8101", "input.recover", "INPUTS", "input-recovery", "recovery-v1");

    expect(candidate.operation).toBe("candidate.resolve");
    expect(candidate.resources[0]).toMatchObject({ resource_id: "MUTCAND-810100000000000000000001", resource_type: "candidate", zone: "MUTATION_GATE" });
    expect(recovery).toMatchObject({ operation: "input.recover", resources: [{ resource_id: "input-recovery", resource_type: "input", zone: "INPUTS", version: "recovery-v1" }] });
  });
});
