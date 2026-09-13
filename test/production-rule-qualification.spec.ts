import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";
import { governanceTx, ruleFixture } from "./helpers/rule-fixtures";
import { globalGovernancePath, RuleGovernanceRepository } from "../src/persistence/rule-governance-repository";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { applyRuleGovernance } from "../src/domain/rule-governance";
import { eventIdForRevision } from "../src/domain/event";
import { archiveProjectRoot, machineCommitRecordPath, machineRegistryJsonPath } from "../src/persistence/layout";
import { encodeAdmission } from "../src/admission/transport";
import { sha256Text } from "../src/documents/hash";
import * as artifactAdmission from "../src/admission/operation-context";
import { commitFixture } from "./helpers/convergence-fixture";

const testEnv = env as unknown as Env;
let projectNumber = 9600;
afterEach(() => vi.restoreAllMocks());

async function fixture(overrides: Record<string, unknown> = {}, realContentHash = false, faults: DropboxMockFault[] = []) {
  const mock = installDropboxMock({ realContentHash, faults });
  const registry = testEnv.REGISTRY_GUARD.getByName("global");
  const environment = { ...testEnv, RULE_GOVERNANCE_TOKEN: "qualification-production-authority", RULE_ADMISSION_SIGNING_KEY: "qualification-production-signing", CF_VERSION_METADATA: { id: "production-wiring-test-version", tag: `git-${"a".repeat(40)}` }, PROJECT_OS_LAYOUT_MODE: "v2" } as Env;
  // Configure bindings only: the production constructor owns the resolver. No protected resolver replacement.
  await runInDurableObject(registry, (instance, state) => {
    Object.assign((instance as any).env, environment);
    state.storage.sql.exec("DELETE FROM projects; DELETE FROM requests; DELETE FROM governance_events; DELETE FROM meta WHERE key = 'rule_governance'");
    state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'next_project_number'", String(++projectNumber));
  });
  const created: any = await (await registry.fetch("https://internal/create", { method: "POST", body: JSON.stringify(governanceTx("project.create", { name: "Qualification", slug: "qualification", aliases: [], objective: "Test production wiring" }, 0, "PRJ-AUTO")) })).json();
  expect(created.status).toBe("committed");
  const project = created.project_id as string;
  const guard = testEnv.PROJECT_GUARD.getByName(project);
  const decision = governanceTx("decision.accept", { decision_id: "DEC-QUALIFICATION01", title: "Accepted destination rule", decision: "Only WORKING artifacts", reason: "fixture accepted authority", impacts: [] }, 1, project);
  const accepted: any = await (await guard.fetch("https://internal/transaction", { method: "POST", body: JSON.stringify(decision) })).json();
  expect(accepted.status).toBe("committed");
  const route = governanceTx("artifact.route.configure", { route_id: "ROUTE-QUALIFICATION01", source_prefix: "LOGICAL", target_prefix: "WORKING/attachments", exclusive: true, decision_ids: ["DEC-QUALIFICATION01"] }, 2, project);
  expect(await (await guard.fetch("https://internal/transaction", { method: "POST", body: JSON.stringify(route) })).json()).toMatchObject({ status: "committed" });
  environment.PROJECT_OS_ADMISSION_PROJECT_MODES = JSON.stringify({ [project]: "strict" });
  await runInDurableObject(registry, instance => Object.assign((instance as any).env, environment));
  await runInDurableObject(guard, instance => Object.assign((instance as any).env, environment));
  const rule = ruleFixture("GLOBAL", { rule_id: "RULE-PRODUCTION01", source_refs: [machineCommitRecordPath(project, accepted.new_revision)], operations: ["artifact.write"], resource_scope: { resource_types: ["artifact"], zones: ["WORKING", "ARTIFACTS"] }, check_id: "allowed_destination", parameters: { allowed_zones: ["WORKING"] }, ...overrides });
  const submit = (tx: ReturnType<typeof governanceTx>) => registry.fetch("https://internal/governance/transaction", { method: "POST", headers: { authorization: `Bearer ${environment.RULE_GOVERNANCE_TOKEN}` }, body: JSON.stringify(tx) });
  expect(await (await submit(governanceTx("rule.propose", { rule }, 0, "GLOBAL"))).json()).toMatchObject({ status: "committed" });
  const acceptance = governanceTx("rule.accept", { rule_id: rule.rule_id, version: 1 }, 1, "GLOBAL");
  expect(await (await submit(acceptance)).json()).toMatchObject({ status: "committed" });
  const activate = (refs = [`${globalGovernancePath}#transaction=${acceptance.transaction_id}`]) => submit(governanceTx("rule.activate", { rule_id: rule.rule_id, version: 1, activation_evidence: refs }, 2, "GLOBAL"));
  return { mock, project, guard, registry, environment, rule, activate, submit };
}

it.each(["list", "metadata", "metadata_revalidation"])("diagnoses canonical qualification I/O without exposing provider response secrets: %s", async operation => {
  const faults: DropboxMockFault[] = [];
  const f = await fixture({}, false, faults);
  const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${f.project}-qualification/WORKING`;
  const file = `${root}/existing.md`;
  await f.mock.writeExternal(file, "allowed existing file");
  const path = operation === "list" ? root : file;
  faults.push({ endpoint: operation === "list" ? "/2/files/list_folder" : "/2/files/get_metadata", path, occurrence: operation === "metadata_revalidation" ? 2 : 1, status: 403, error_summary: "secret-provider-body-DO-NOT-EXPOSE" });
  const response = await f.activate();
  expect(response.status).toBe(503);
  const result = await response.json() as any;
  expect(result).toMatchObject({ error: "QUALIFICATION_IO_UNAVAILABLE", qualification: { verdict: "unavailable" } });
  expect(result.qualification.observed).toContain(`operation=${operation}`);
  expect(result.qualification.observed).toContain(`path=${path}`);
  expect(result.qualification.observed).toContain("status=403");
  expect(JSON.stringify(result)).not.toContain("secret-provider-body");
  expect(JSON.parse(f.mock.files.get(globalGovernancePath)!).rules["RULE-PRODUCTION01@1"].status).toBe("accepted_unenforced");
});

it.each([["Too many subrequests", "subrequest_limit"], ["slice_budget_exhausted", "request_budget"], ["unexpected transport error", "unclassified"]])("classifies a transport failure without returning its raw message: %s", async (message, failure) => {
  const f = await fixture();
  const outbound = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/2/files/list_folder") && (await request.clone().json() as any).path.endsWith("/WORKING")) throw new Error(`${message}: secret-transport-value`);
    return outbound(input, init);
  });
  const response = await f.activate();
  const result = await response.json() as any;
  expect(response.status).toBe(503);
  expect(result.error).toBe("QUALIFICATION_IO_UNAVAILABLE");
  expect(result.qualification.observed).toContain(`failure=${failure}`);
  expect(JSON.stringify(result)).not.toContain("secret-transport-value");
});

it("activates from canonical acceptance evidence through production wiring and enforces the data-only rule", async () => {
  const f = await fixture();
  expect(await (await f.activate()).json()).toMatchObject({ status: "committed" });
  const headers = { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` };
  async function submit(relative_path: string, request_id: string) {
    const { context }: any = await (await worker.fetch(new Request(`https://example.com/v1/projects/${f.project}/mutation-context`, { headers }), f.environment, createExecutionContext())).json();
    const request = { project_id: f.project, request_id, relative_path, mode: "create", content: "qualified content", content_sha256: await sha256Text("qualified content") };
    if (relative_path === "unrouted.md") {
      const direct = await f.guard.fetch("https://internal/artifact", { method: "POST", body: JSON.stringify(encodeAdmission(request, context)) });
      expect(await direct.json()).toMatchObject({ error: "DESTINATION_FORBIDDEN" });
    }
    return worker.fetch(new Request("https://example.com/v1/artifacts", { method: "POST", headers, body: JSON.stringify(encodeAdmission(request, context)) }), f.environment, createExecutionContext());
  }
  const refused = await submit("unrouted.md", "ART-QUALIFIED-DENY-0001");
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: "DESTINATION_FORBIDDEN" });
  const allowed = await submit("LOGICAL/allowed.md", "ART-QUALIFIED-ALLOW-0001");
  expect(await allowed.json()).toMatchObject({ status: "committed" });
  expect(f.mock.files.has(`/PROJECT_OS/WORKSPACE/PROJECTS/${f.project}-qualification/ARTIFACTS/unrouted.md`)).toBe(false);
  expect(f.mock.files.get(`/PROJECT_OS/WORKSPACE/PROJECTS/${f.project}-qualification/WORKING/attachments/allowed.md`)).toBe("qualified content");
});

it("qualifies a corrected successor without activating its accepted unenforced predecessor", async () => {
  const f = await fixture({ source_refs: ["generated-view:revision-112"] });
  expect(await (await f.activate()).json()).toMatchObject({ error: "QUALIFICATION_SOURCE_UNVERIFIED" });
  const original = JSON.parse(f.mock.files.get(globalGovernancePath)!).rules["RULE-PRODUCTION01@1"];
  const rule = { ...f.rule, version: 2, supersedes: 1, source_refs: [machineCommitRecordPath(f.project, 2)] };
  expect(await (await f.submit(governanceTx("rule.propose", { rule }, 2, "GLOBAL"))).json()).toMatchObject({ status: "committed" });
  const acceptance = governanceTx("rule.accept", { rule_id: rule.rule_id, version: 2 }, 3, "GLOBAL");
  expect(await (await f.submit(acceptance)).json()).toMatchObject({ status: "committed" });
  const activate = (refs: string[]) => f.submit(governanceTx("rule.activate", { rule_id: rule.rule_id, version: 2, activation_evidence: refs }, 4, "GLOBAL"));
  expect(await (await activate(["client:corrected-source-approved"])).json()).toMatchObject({ error: "QUALIFICATION_REFERENCE_UNVERIFIED" });
  expect(await (await activate([`${globalGovernancePath}#transaction=${acceptance.transaction_id}`])).json()).toMatchObject({ status: "committed" });
  const governance = JSON.parse(f.mock.files.get(globalGovernancePath)!);
  expect(governance.rules["RULE-PRODUCTION01@1"]).toEqual({ ...original, status: "superseded" });
  expect(governance.rules["RULE-PRODUCTION01@1"].activation_evidence).toEqual([]);
  expect(governance.rules["RULE-PRODUCTION01@2"].status).toBe("active");
  const activations: any[] = Object.values(governance.journal).filter((entry: any) => entry.transaction.operation === "rule.activate" && entry.receipt.status === "committed");
  expect(activations).toHaveLength(1);
  expect(activations[0].transaction.payload.version).toBe(2);
  expect(activations[0].qualification.proof.evidence.rule_version).toBe(2);
});

it("extends production enforcement data-only with cumulative global and local allowed_destination rules", async () => {
  const f = await fixture({
    resource_scope: { resource_types: ["artifact"], zones: ["WORKING", "ARTIFACTS", "RESEARCH"] },
    parameters: { allowed_zones: ["WORKING", "ARTIFACTS"] }
  });
  const headers = { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` };
  const mutationContext = async () => {
    const response = await worker.fetch(new Request(`https://example.com/v1/projects/${f.project}/mutation-context`, { headers }), f.environment, createExecutionContext());
    expect(response.status).toBe(200);
    return (await response.json() as any).context;
  };
  const transaction = async (operation: string, payload: unknown, revision: number) => {
    const tx = governanceTx(operation, payload, revision, f.project);
    const response = await f.guard.fetch("https://internal/transaction", { method: "POST", body: JSON.stringify(encodeAdmission(tx, await mutationContext())) });
    const receipt: any = await response.json();
    expect(receipt).toMatchObject({ status: "committed", new_revision: revision + 1 });
    return receipt;
  };
  // Existing typed route configuration supplies a third physical zone for independent refusals.
  await transaction("artifact.route.configure", { route_id: "ROUTE-QUALIFICATION02", source_prefix: "STUDY", target_prefix: "RESEARCH/attachments", exclusive: true, decision_ids: ["DEC-QUALIFICATION01"] }, 3);
  expect(await (await f.activate()).json()).toMatchObject({ status: "committed" });
  const local = ruleFixture(f.project, { ...f.rule, scope: { kind: "project", project_id: f.project }, rule_id: "RULE-PRODUCTION-LOCAL01", parameters: { allowed_zones: ["WORKING", "RESEARCH"] } });
  await transaction("rule.propose", { rule: local }, 4);
  const accepted = await transaction("rule.accept", { rule_id: local.rule_id, version: 1 }, 5);
  const activated = await transaction("rule.activate", { rule_id: local.rule_id, version: 1, activation_evidence: [machineCommitRecordPath(f.project, accepted.new_revision)] }, 6);
  const canonical = JSON.parse(f.mock.files.get(machineCommitRecordPath(f.project, activated.new_revision))!);
  expect(canonical.state.local_rules["RULE-PRODUCTION-LOCAL01@1"].status).toBe("active");
  const localProof = canonical.state.local_rule_qualifications["RULE-PRODUCTION-LOCAL01@1"].qualification.proof;
  const globalState = JSON.parse(f.mock.files.get(globalGovernancePath)!);
  const globalProof = Object.values(globalState.journal).find((entry: any) => entry.transaction.operation === "rule.activate") as any;
  expect(localProof.evidence.deployed_check_id).toBe("allowed_destination");
  expect(globalProof.qualification.proof.evidence.deployed_check_id).toBe("allowed_destination");
  expect(localProof.audit.catalogue_sha256).toBe(globalProof.qualification.proof.audit.catalogue_sha256);

  const artifact = async (relative_path: string, suffix: string) => {
    const request = { project_id: f.project, request_id: `ART-EXTENSIBILITY-${suffix}-0001`, relative_path, mode: "create", content: "cumulative qualified content", content_sha256: await sha256Text("cumulative qualified content") };
    return worker.fetch(new Request("https://example.com/v1/artifacts", { method: "POST", headers, body: JSON.stringify(encodeAdmission(request, await mutationContext())) }), f.environment, createExecutionContext());
  };
  for (const [path, suffix] of [["STUDY/global-denied.md", "GLOBAL-DENY"], ["local-denied.md", "LOCAL-DENY"]]) {
    const response = await artifact(path, suffix);
    expect(response.status, path).toBe(409);
    expect(await response.json()).toMatchObject({ error: "DESTINATION_FORBIDDEN" });
  }
  expect(await (await artifact("LOGICAL/both-allowed.md", "BOTH-ALLOW")).json()).toMatchObject({ status: "committed" });
  const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${f.project}-qualification`;
  expect(f.mock.files.has(`${root}/RESEARCH/attachments/global-denied.md`)).toBe(false);
  expect(f.mock.files.has(`${root}/ARTIFACTS/local-denied.md`)).toBe(false);
  expect(f.mock.files.get(`${root}/WORKING/attachments/both-allowed.md`)).toBe("cumulative qualified content");
});

it("qualifies a narrow REVIEW rule without governing ordinary ARTIFACTS writes", async () => {
  const f = await fixture({ resource_scope: { resource_types: ["artifact"], zones: ["REVIEW"] }, parameters: { allowed_zones: ["REVIEW"] } }, true);
  f.environment.PROJECT_OS_REVIEW_CANDIDATE_INGRESS_MODE = "off";
  f.environment.PROJECT_OS_REVIEW_CANDIDATE_CAPABILITY = undefined;
  f.environment.PROJECT_OS_MUTATION_GATE_MODE = "observe";
  await runInDurableObject(f.guard, instance => Object.assign((instance as any).env, f.environment));
  const headers = { authorization: `Bearer ${testEnv.INGRESS_TOKEN}` };
  const submit = async (request: unknown) => {
    const { context }: any = await (await worker.fetch(new Request(`https://example.com/v1/projects/${f.project}/mutation-context`, { headers }), f.environment, createExecutionContext())).json();
    return worker.fetch(new Request("https://example.com/v1/artifacts", { method: "POST", headers, body: JSON.stringify(encodeAdmission(request, context)) }), f.environment, createExecutionContext());
  };
  const content = "%PDF-1.7\nreview staging only\n%%EOF";
  const candidate = async (request_id: string) => {
    const path = `/PROJECT_OS/.project-os/artifacts/staging/${request_id}/candidate.pdf`;
    const source = (await f.mock.writeExternal(path, content))!;
    return { request_id, project_id: f.project, operation: "REVIEW_CANDIDATE", base_revision: 3, relative_path: "candidate.pdf", media_type: "application/pdf", content_sha256: await sha256Text(content), mode: "create", source: { kind: "staged_provider_object", provider_id: "dropbox", path, object_id: source.id, revision_token: source.rev, size: source.size, integrity: { algorithm: "dropbox-content-hash", value: source.content_hash } } };
  };
  expect(await (await submit(await candidate("ART-REVIEW-BEFORE-0001"))).json()).toMatchObject({ status: "rejected", code: "REVIEW_CANDIDATE_DISABLED" });
  expect(await (await f.activate()).json()).toMatchObject({ status: "committed" });
  const governance = JSON.parse(f.mock.files.get(globalGovernancePath)!);
  const activated: any = Object.values(governance.journal).find((entry: any) => entry.transaction.operation === "rule.activate");
  expect(activated.qualification.proof.audit.probes).toEqual(expect.arrayContaining([
    expect.objectContaining({ artifact_operation: "REVIEW_CANDIDATE", code: "DESTINATION_ALLOWED" }),
    expect.objectContaining({ artifact_operation: "REVIEW_CANDIDATE", relative_path: "nested/qualification-probe.pdf", code: "ARTIFACT_DESTINATION_FORBIDDEN", verdict: "deny" })
  ]));
  expect(activated.qualification.proof.audit.probes.every((probe: any) => probe.artifact_operation === "REVIEW_CANDIDATE")).toBe(true);
  expect(governance.rules["RULE-PRODUCTION01@1"].resource_scope.zones).toEqual(["REVIEW"]);
  const request = await candidate("ART-REVIEW-AFTER-0001");
  expect(await (await submit(request)).json()).toMatchObject({ status: "committed", operation: "REVIEW_CANDIDATE", accepted: false, published: false });
  const ordinary = await submit({ request_id: "ART-REVIEW-ORDINARY-0001", project_id: f.project, relative_path: "ordinary.md", mode: "create", content: "unaffected", content_sha256: await sha256Text("unaffected") });
  expect(await ordinary.json()).toMatchObject({ status: "committed" });
  const invalid = await submit({ ...request, request_id: "ART-REVIEW-NESTED-0001", relative_path: "nested/candidate.pdf" });
  expect(invalid.status).toBe(400);
  const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${f.project}-qualification`;
  expect(f.mock.files.get(`${root}/REVIEW/CANDIDATES/${request.request_id}/candidate.pdf`)).toBe(content);
  expect(f.mock.files.get(`${root}/ARTIFACTS/ordinary.md`)).toBe("unaffected");
  expect([...f.mock.files.keys()].some(path => path.startsWith(`${root}/REVIEW/CANDIDATES/ART-REVIEW-NESTED-0001/`))).toBe(false);
  expect([...f.mock.files.keys()].filter(path => path.startsWith(`${root}/DELIVERABLES/`) || path.includes(`/documents/heads/`))).toEqual([]);
});

it.each([["REVIEW"], ["REVIEW", "ARTIFACTS"]])("never counts an unavailable review negative-control boundary as verified: %j", async (...zones) => {
  const f = await fixture({ resource_scope: { resource_types: ["artifact"], zones }, parameters: { allowed_zones: ["REVIEW"] } });
  const normalize = artifactAdmission.normalizeArtifactAdmission;
  vi.spyOn(artifactAdmission, "normalizeArtifactAdmission").mockImplementation(async (intent, state) => {
    if ("operation" in intent && intent.operation === "REVIEW_CANDIDATE" && intent.relative_path.includes("/")) throw new Error("temporary boundary unavailable");
    return normalize(intent, state);
  });
  expect(await (await f.activate()).json()).toMatchObject({ error: "QUALIFICATION_TEST_EVIDENCE_UNAVAILABLE" });
});

it.each([
  { change: { parameters: { allowed_zones: [] } }, code: "INVALID_CHECK_PARAMETERS" },
  { change: { check_id: "unknown" }, code: "UNKNOWN_ACTIVE_CHECK" },
  { change: { check_id: "expected_version", parameters: { required: true } }, code: "QUALIFICATION_COVERAGE_UNAVAILABLE" },
  { change: { operations: ["project.materialize"] }, code: "UNSUPPORTED_CHECK_OPERATION" },
  { change: { source_refs: ["client:accepted"] }, code: "QUALIFICATION_SOURCE_UNVERIFIED" }
])("keeps an unequipped/inexact rule accepted_unenforced: $code", async ({ change, code }) => {
  const f = await fixture(change);
  expect(await (await f.activate()).json()).toMatchObject({ error: code });
  expect((await (await f.registry.fetch("https://internal/governance")).json() as any).rules["RULE-PRODUCTION01@1"].status).toBe("accepted_unenforced");
});

it("rejects client assertions in place of the exact canonical rule-accept receipt", async () => {
  const f = await fixture();
  expect(await (await f.activate(["client:positive-negative-tests-passed"])).json()).toMatchObject({ error: "QUALIFICATION_REFERENCE_UNVERIFIED" });
});

it("fails closed when a registered project's canonical inventory has an internal hole", async () => {
  const f = await fixture();
  f.mock.files.delete(machineCommitRecordPath(f.project, 2));
  expect(await (await f.activate()).json()).toMatchObject({ error: "QUALIFICATION_INVENTORY_UNAVAILABLE" });
});

it("refuses historical files already outside the rule's allowed zones", async () => {
  const f = await fixture();
  await f.mock.writeExternal(`/PROJECT_OS/WORKSPACE/PROJECTS/${f.project}-qualification/ARTIFACTS/legacy.md`, "unqualified historical artifact");
  expect(await (await f.activate()).json()).toMatchObject({ error: "QUALIFICATION_HISTORICAL_DRIFT" });
});

async function migratedRegistryFixture() {
  const f = await fixture();
  const registry = JSON.parse(f.mock.files.get(machineRegistryJsonPath())!);
  registry.projects.push({ project_id: "PRJ-0001", slug: "legacy-archive-one", status: "archived" }, { project_id: "PRJ-0004", slug: "legacy-archive-four", status: "archived" }, { project_id: "PRJ-0002", slug: "synthetic-convergence", status: "active" });
  await f.mock.writeExternal(machineRegistryJsonPath(), JSON.stringify(registry));
  for (const commit of commitFixture("PRJ-0002", 169).slice(51)) await f.mock.writeExternal(machineCommitRecordPath("PRJ-0002", commit.new_revision), JSON.stringify(commit));
  await f.mock.writeExternal(`${archiveProjectRoot("PRJ-0001", "legacy-archive-one")}/ARTIFACTS/legacy.md`, "Terminal archive is outside admission scope");
  f.environment.PROJECT_OS_ADMISSION_PROJECT_MODES = JSON.stringify({ [f.project]: "strict", "PRJ-0002": "strict" });
  await runInDurableObject(f.registry, instance => Object.assign((instance as any).env, f.environment));
  return f;
}

it("qualifies a contiguous migrated 52..169 suffix and ignores terminal archives without machine history", async () => {
  const f = await migratedRegistryFixture();
  const response = await f.activate();
  expect(await response.json()).toMatchObject({ status: "committed" });
  const governance = JSON.parse(f.mock.files.get(globalGovernancePath)!);
  const activation: any = Object.values(governance.journal).find((entry: any) => entry.transaction.operation === "rule.activate");
  const paths = activation.qualification.proof.audit.objects.map((object: any) => object.path);
  expect(paths).toContain(machineCommitRecordPath("PRJ-0002", 52));
  expect(paths).toContain(machineCommitRecordPath("PRJ-0002", 169));
  expect(activation.qualification.proof.audit.directories.some((entry: any) => entry.path.includes("/PRJ-0001/") || entry.path.includes("/PRJ-0004/"))).toBe(false);
  expect(f.mock.files.has(machineCommitRecordPath("PRJ-0002", 1))).toBe(false);
  expect(f.mock.files.has(machineCommitRecordPath("PRJ-0001", 1))).toBe(false);
});

it.each(["internal_hole", "first_previous_revision", "first_filename_binding", "latest_filename_binding"])("refuses an unverified migrated suffix: %s", async fault => {
  const f = await migratedRegistryFixture();
  if (fault === "internal_hole") f.mock.files.delete(machineCommitRecordPath("PRJ-0002", 100));
  else {
    const path = machineCommitRecordPath("PRJ-0002", fault === "latest_filename_binding" ? 169 : 52);
    const commit = JSON.parse(f.mock.files.get(path)!);
    if (fault === "first_previous_revision") commit.previous_revision = 0;
    else Object.assign(commit, JSON.parse(f.mock.files.get(machineCommitRecordPath("PRJ-0002", 53))!));
    await f.mock.writeExternal(path, JSON.stringify(commit));
  }
  expect(await (await f.activate()).json()).toMatchObject({ error: "QUALIFICATION_INVENTORY_UNAVAILABLE" });
});

it("journals the verified production qualification and refuses tampering with its bound proof", async () => {
  const f = await fixture();
  const receipt: any = await (await f.activate()).json();
  expect(receipt.status).toBe("committed");
  const governance = JSON.parse(f.mock.files.get(globalGovernancePath)!);
  const proof = governance.journal[receipt.transaction_id].qualification;
  expect(proof, "canonical activation keeps a replayable qualification record").toBeDefined();
  expect(proof.proof.evidence).toMatchObject({ deployed_check_id: "allowed_destination", rule_id: f.rule.rule_id });
  expect(proof.proof.audit.probes.some((probe: any) => probe.code === "DESTINATION_ALLOWED")).toBe(true);
  expect(proof.proof.audit.probes.some((probe: any) => probe.code === "DESTINATION_FORBIDDEN")).toBe(true);
  expect(proof.proof.audit.objects.length).toBeGreaterThan(0);
  proof.proof.evidence.negative_test_refs = ["forged:passed"];
  await f.mock.writeExternal(globalGovernancePath, JSON.stringify(governance));
  expect((await f.registry.fetch("https://internal/governance")).status).toBe(503);
});

it("keeps legacy governance history readable without inventing a qualification attestation", async () => {
  const f = await fixture();
  const receipt: any = await (await f.activate()).json();
  const governance = JSON.parse(f.mock.files.get(globalGovernancePath)!);
  delete governance.journal[receipt.transaction_id].qualification;
  delete governance.journal[receipt.transaction_id].qualification_required;
  await f.mock.writeExternal(globalGovernancePath, JSON.stringify(governance));
  expect((await new RuleGovernanceRepository(createProductionPersistence(f.environment)).read())?.state.revision).toBe(3);
  expect((await f.registry.fetch("https://internal/governance")).status).toBe(503);
});

async function legacyActivation(f: Awaited<ReturnType<typeof fixture>>) {
  const prior = JSON.parse(f.mock.files.get(globalGovernancePath)!);
  const tx = governanceTx("rule.activate", { rule_id: f.rule.rule_id, version: 1, activation_evidence: ["legacy:self-declared"] }, 2, "GLOBAL");
  const result = applyRuleGovernance(prior, tx as any, "GLOBAL");
  if (result.kind !== "commit") throw new Error("legacy fixture transition invalid");
  const event_id = eventIdForRevision(3);
  const receipt = { schema_version: "1.0", project_id: "GLOBAL", transaction_id: tx.transaction_id, status: "committed", previous_revision: 2, new_revision: 3, event_id, committed_at: tx.created_at };
  const event = { schema_version: "1.0", event_id, project_id: "GLOBAL", revision: 3, transaction_id: tx.transaction_id, type: tx.operation, timestamp: tx.created_at, payload: tx.payload };
  await f.mock.writeExternal(globalGovernancePath, JSON.stringify({ ...prior, ...result.state, revision: 3, journal: { ...prior.journal, [tx.transaction_id]: { transaction: tx, receipt, event } } }));
}

function permitInput(f: Awaited<ReturnType<typeof fixture>>, revision = 3, version = 1) {
  return { actor: { actor_id: "project_guard", authority: "internal" }, project_id: f.project, operation: f.rule.operations[0], resources: [{ resource_id: "ART-LEGACY-QUALIFIED01", resource_type: f.rule.resource_scope.resource_types[0], zone: f.rule.resource_scope.zones[0], version: "a".repeat(64), relative_path: "LOGICAL/old.md" }], request_hash: "c".repeat(64), global_revision: revision, ruleset: { digest: "d".repeat(64), rules: [{ rule_id: f.rule.rule_id, version, scope: { kind: "global" } }], global_revision: revision, project_revision: 3 } };
}

it.each([
  { check_id: "expected_version", parameters: { required: true } },
  { check_id: "exact_approval", parameters: {} },
  { check_id: "coherent_phase", parameters: {}, operations: ["plan.phase.complete"], resource_scope: { resource_types: ["project"], zones: ["PROJECT"] } }
])("does not expose or issue permits from unqualified legacy $check_id activation", async overrides => {
  const f = await fixture(overrides);
  await legacyActivation(f);
  const history = await new RuleGovernanceRepository(createProductionPersistence(f.environment)).read();
  expect(history?.state.rules["RULE-PRODUCTION01@1"].status).toBe("active");
  const response = await f.registry.fetch("https://internal/governance");
  expect.soft(response.status).toBe(503);
  expect.soft(await response.json()).toMatchObject({ error: "governance_qualification_unavailable" });
  const permit = await f.registry.fetch("https://internal/rule-admission", { method: "POST", body: JSON.stringify(permitInput(f)) });
  expect(permit.status).toBe(503);
  expect(await permit.json()).toMatchObject({ error: "governance_qualification_unavailable" });
});

it("restores effectiveness only through an explicitly qualified compatible successor of a legacy rule", async () => {
  const f = await fixture();
  await legacyActivation(f);
  expect((await f.registry.fetch("https://internal/governance")).status).toBe(503);
  const next = { ...f.rule, version: 2, supersedes: 1 };
  expect(await (await f.submit(governanceTx("rule.propose", { rule: next }, 3, "GLOBAL"))).json()).toMatchObject({ status: "committed" });
  const accept = governanceTx("rule.accept", { rule_id: next.rule_id, version: 2 }, 4, "GLOBAL");
  expect(await (await f.submit(accept)).json()).toMatchObject({ status: "committed" });
  expect(await (await f.submit(governanceTx("rule.activate", { rule_id: next.rule_id, version: 2, activation_evidence: [`${globalGovernancePath}#transaction=${accept.transaction_id}`] }, 5, "GLOBAL"))).json()).toMatchObject({ status: "committed" });
  const response = await f.registry.fetch("https://internal/governance");
  expect(response.status).toBe(200);
  expect((await response.json() as any).rules).toMatchObject({ "RULE-PRODUCTION01@1": { status: "superseded" }, "RULE-PRODUCTION01@2": { status: "active" } });
  const permit = await f.registry.fetch("https://internal/rule-admission", { method: "POST", body: JSON.stringify(permitInput(f, 6, 2)) });
  expect(permit.status).toBe(200);
  expect(await permit.json()).toHaveProperty("token");
});

it("does not reinterpret a new activation with a missing qualification as legacy history", async () => {
  const f = await fixture();
  const receipt: any = await (await f.activate()).json();
  const governance = JSON.parse(f.mock.files.get(globalGovernancePath)!);
  delete governance.journal[receipt.transaction_id].qualification;
  await f.mock.writeExternal(globalGovernancePath, JSON.stringify(governance));
  expect((await f.registry.fetch("https://internal/governance")).status).toBe(503);
});

it("does not claim build qualification without deployment identity", async () => {
  const f = await fixture();
  await runInDurableObject(f.registry, instance => { (instance as any).env.CF_VERSION_METADATA = {}; });
  expect(await (await f.activate()).json()).toMatchObject({ error: "QUALIFICATION_EVIDENCE_UNAVAILABLE" });
});

it("does not qualify a global rule while a governed project is configured outside strict admission", async () => {
  const f = await fixture();
  await runInDurableObject(f.registry, instance => { (instance as any).env.PROJECT_OS_ADMISSION_PROJECT_MODES = "{}"; });
  expect(await (await f.activate()).json()).toMatchObject({ error: "QUALIFICATION_COVERAGE_UNAVAILABLE" });
});

it("refuses activation when no negative deployed rule probe is possible", async () => {
  const f = await fixture({ parameters: { allowed_zones: ["ARTIFACTS", "WORKING"] } });
  expect(await (await f.activate()).json()).toMatchObject({ error: "QUALIFICATION_TEST_EVIDENCE_UNAVAILABLE" });
});

it("checks contradictions against all active global rules", async () => {
  const f = await fixture();
  expect(await (await f.activate()).json()).toMatchObject({ status: "committed" });
  const rule = { ...f.rule, rule_id: "RULE-PRODUCTION02", parameters: { allowed_zones: ["ARTIFACTS"] } };
  expect(await (await f.submit(governanceTx("rule.propose", { rule }, 3, "GLOBAL"))).json()).toMatchObject({ status: "committed" });
  const acceptance = governanceTx("rule.accept", { rule_id: rule.rule_id, version: 1 }, 4, "GLOBAL");
  expect(await (await f.submit(acceptance)).json()).toMatchObject({ status: "committed" });
  const response = await f.submit(governanceTx("rule.activate", { rule_id: rule.rule_id, version: 1, activation_evidence: [`${globalGovernancePath}#transaction=${acceptance.transaction_id}`] }, 5, "GLOBAL"));
  expect(await response.json()).toMatchObject({ error: "RULESET_CONFLICT" });
});
