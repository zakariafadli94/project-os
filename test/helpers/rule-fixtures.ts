export const ruleAt = "2026-09-12T10:00:00.000Z";
export function ruleFixture(projectId = "PRJ-7101", overrides: Record<string, unknown> = {}) {
  return {
    rule_id: "RULE-7101", version: 1,
    scope: projectId === "GLOBAL" ? { kind: "global" } : { kind: "project", project_id: projectId },
    source_refs: ["DEC-7101"], title: "Verify destination", operations: ["deliverable.create"],
    resource_scope: { resource_types: ["deliverable"], zones: ["DELIVERABLES"] },
    check_id: "allowed_destination", parameters: { zone: "DELIVERABLES" },
    enforcement: "automatic", check_stage: "pre_admission", exception_allowed: true,
    status: "draft", activation_evidence: [], created_by: "founder", created_at: ruleAt,
    ...overrides
  };
}
export function governanceTx(operation: string, payload: unknown, baseRevision = 0, projectId = "PRJ-7101") {
  return { schema_version: "1.0", transaction_id: `TXN-RULE-${crypto.randomUUID().toUpperCase()}`,
    project_id: projectId, base_revision: baseRevision, created_at: ruleAt, operation, payload };
}
export function exceptionFixture(overrides: Record<string, unknown> = {}) {
  return { exception_id: "EXC-7101", rule_id: "RULE-7101", rule_version: 1, project_id: "PRJ-7101",
    resources: ["DEL-7101"], operations: ["deliverable.create"], reason: "Accepted temporary migration",
    granted_by: "founder", grant_refs: ["DEC-7102"], granted_at: ruleAt,
    expires_at: "2026-09-13T10:00:00.000Z", ...overrides };
}
