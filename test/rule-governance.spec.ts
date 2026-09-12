import { describe, expect, it } from "vitest";
import { applyTransaction, emptyProjectState } from "../src/domain/transitions";
import { parseTransaction } from "../src/domain/transaction";
import type { ProjectState } from "../src/domain/project-state";
import { readProjectState, encodeProjectState } from "../src/schema/project-state";
import { exceptionFixture, governanceTx, ruleFixture } from "./helpers/rule-fixtures";

function transition(state: ProjectState, operation: string, payload: unknown, revision = state.revision) {
  return applyTransaction(state, parseTransaction(governanceTx(operation, payload, revision)));
}
function commit(state: ProjectState, operation: string, payload: unknown): ProjectState {
  const result = transition(state, operation, payload);
  expect(result.kind).toBe("commit");
  if (result.kind !== "commit") throw new Error(JSON.stringify(result));
  expect(result.event.type).toBe(operation);
  return result.state;
}
function accepted(overrides: Record<string, unknown> = {}) {
  const proposed = commit(emptyProjectState("PRJ-7101", "Rules", "rules"), "rule.propose", { rule: ruleFixture("PRJ-7101", overrides) });
  return commit(proposed, "rule.accept", { rule_id: "RULE-7101", version: 1 });
}
function active(overrides: Record<string, unknown> = {}) {
  return commit(accepted(overrides), "rule.activate", { rule_id: "RULE-7101", version: 1, activation_evidence: ["qualification:7101"] });
}

describe("canonical rule governance", () => {
  it("canonicalizes duplicate and differently ordered normalized operations", () => {
    const rule = ruleFixture("PRJ-7101", { operations: ["task.start", "deliverable.create", "task.start"] });
    const proposed = parseTransaction(governanceTx("rule.propose", { rule }));
    expect(proposed.payload).toMatchObject({ rule: { operations: ["deliverable.create", "task.start"] } });
    const granted = parseTransaction(governanceTx("rule.exception.grant", { exception: exceptionFixture({ operations: ["task.start", "deliverable.create", "task.start"] }) }));
    expect(granted.payload).toMatchObject({ exception: { operations: ["deliverable.create", "task.start"] } });
  });
  it("normalizes historical v1 and v2 to empty governance maps", () => {
    const state = emptyProjectState("PRJ-7101", "Rules", "rules") as unknown as Record<string, unknown>;
    delete state.local_rules; delete state.rule_exceptions;
    for (const schema_version of ["1.0", "2.0"]) {
      expect(readProjectState({ ...state, schema_version }).state).toMatchObject({ local_rules: {}, rule_exceptions: {} });
    }
  });
  it("preserves immutable content through acceptance, activation, supersession and retirement", () => {
    const first = active();
    expect(first.local_rules["RULE-7101@1"]).toMatchObject({ status: "active", title: "Verify destination" });
    const second = commit(first, "rule.propose", { rule: ruleFixture("PRJ-7101", { version: 2, supersedes: 1 }) });
    expect(second.local_rules["RULE-7101@1"].status).toBe("active");
    const ready = commit(second, "rule.accept", { rule_id: "RULE-7101", version: 2 });
    const switched = commit(ready, "rule.activate", { rule_id: "RULE-7101", version: 2, activation_evidence: ["qualification:7102"] });
    expect(switched.local_rules["RULE-7101@1"].status).toBe("superseded");
    expect(first.local_rules["RULE-7101@1"].status).toBe("active");
    const retired = commit(switched, "rule.retire", { rule_id: "RULE-7101", version: 2, reason: "Obsolete" });
    expect(retired.local_rules["RULE-7101@2"].status).toBe("retired");
    for (const stage of ["v1_only", "core_v2"] as const) {
      expect(readProjectState(encodeProjectState(retired, stage)).state.local_rules).toEqual(retired.local_rules);
    }
  });
  it("rejects activation before acceptance and repeated acceptance or retirement", () => {
    const draft = commit(emptyProjectState("PRJ-7101", "Rules", "rules"), "rule.propose", { rule: ruleFixture() });
    expect(transition(draft, "rule.activate", { rule_id: "RULE-7101", version: 1, activation_evidence: ["q"] })).toMatchObject({ kind: "rejected", code: "INVALID_RULE_TRANSITION" });
    expect(transition(accepted(), "rule.accept", { rule_id: "RULE-7101", version: 1 })).toMatchObject({ kind: "rejected", code: "INVALID_RULE_TRANSITION" });
    expect(transition(draft, "rule.retire", { rule_id: "RULE-7101", version: 1, reason: "x" })).toMatchObject({ kind: "rejected", code: "INVALID_RULE_TRANSITION" });
  });
  it("rejects overwriting an active version or replacing without monotonic exact predecessor", () => {
    const state = active();
    for (const overrides of [{ title: "Disabled" }, { version: 2 }, { version: 2, supersedes: 9 }]) {
      expect(transition(state, "rule.propose", { rule: ruleFixture("PRJ-7101", overrides) }).kind).toBe("rejected");
    }
  });
  it("does not let local governance target global or another project's rules", () => {
    const state = emptyProjectState("PRJ-7101", "Rules", "rules");
    for (const projectId of ["GLOBAL", "PRJ-7102"]) {
      expect(transition(state, "rule.propose", { rule: ruleFixture(projectId) })).toMatchObject({ kind: "rejected", code: "RULE_SCOPE_MISMATCH" });
    }
    expect(transition(state, "rule.retire", { rule_id: "GLOBAL-RULE", version: 1, reason: "Local override" })).toMatchObject({ kind: "rejected", code: "RULE_NOT_FOUND" });
  });
  it("rejects stale governance instead of rebasing", () => {
    const state = active();
    expect(transition(state, "rule.retire", { rule_id: "RULE-7101", version: 1, reason: "Obsolete" }, 0)).toMatchObject({ kind: "conflict", code: "STALE_REVISION" });
  });
  it("grants and revokes an exact exception while preserving its grant provenance", () => {
    const state = active();
    const granted = commit(state, "rule.exception.grant", { exception: exceptionFixture() });
    expect(granted.rule_exceptions["EXC-7101"]).toMatchObject({ status: "granted", grant_refs: ["DEC-7102"] });
    const revoked = commit(granted, "rule.exception.revoke", { exception_id: "EXC-7101", reason: "Window closed", revoked_by: "founder" });
    expect(revoked.rule_exceptions["EXC-7101"]).toMatchObject({ status: "revoked", grant_refs: ["DEC-7102"], revoked_by: "founder" });
    expect(transition(revoked, "rule.exception.grant", { exception: exceptionFixture() }).kind).toBe("rejected");
  });
  it.each([
    { resources: [] }, { resources: ["*"] }, { operations: [] }, { operations: ["*"] },
    { reason: " " }, { grant_refs: [] }, { granted_by: "" },
    { expires_at: undefined }, { expires_at: "2026-09-12T09:00:00.000Z" }
  ])("rejects unbounded or expired exception %j", (changes) => {
    expect(() => parseTransaction(governanceTx("rule.exception.grant", { exception: exceptionFixture() }))).not.toThrow();
    expect(() => parseTransaction(governanceTx("rule.exception.grant", { exception: exceptionFixture(changes) }))).toThrow();
  });
  it("rejects wrong exception version, project, operation and disallowed exception", () => {
    const state = active();
    for (const changes of [{ rule_version: 2 }, { project_id: "PRJ-7102" }, { operations: ["task.complete"] }]) {
      expect(transition(state, "rule.exception.grant", { exception: exceptionFixture(changes) }).kind).toBe("rejected");
    }
    expect(transition(active({ exception_allowed: false }), "rule.exception.grant", { exception: exceptionFixture() })).toMatchObject({ kind: "rejected", code: "RULE_EXCEPTION_FORBIDDEN" });
  });
  it.each(["authentication", "project_isolation", "transaction_only_writes", "expected_revision", "evidence_preservation"])("never delegates foundational check %s", (check_id) => {
    expect(transition(active({ check_id }), "rule.exception.grant", { exception: exceptionFixture() })).toMatchObject({ kind: "rejected", code: "RULE_EXCEPTION_FORBIDDEN" });
  });
  it("requires sources, exact scopes, draft proposal and nonempty activation evidence", () => {
    expect(() => parseTransaction(governanceTx("rule.propose", { rule: ruleFixture() }))).not.toThrow();
    for (const changes of [{ source_refs: [] }, { scope: { kind: "project" } }, { scope: { kind: "global", project_id: "PRJ-7101" } }, { status: "active" }]) {
      expect(() => parseTransaction(governanceTx("rule.propose", { rule: ruleFixture("PRJ-7101", changes) }))).toThrow();
    }
    expect(() => parseTransaction(governanceTx("rule.activate", { rule_id: "RULE-7101", version: 1, activation_evidence: [] }))).toThrow();
  });
});
