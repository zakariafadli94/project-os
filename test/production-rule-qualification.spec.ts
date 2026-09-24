import { env } from "cloudflare:workers";
import { createExecutionContext, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { installDropboxMock, type DropboxMockFault } from "./helpers/mock-dropbox";
import { governanceTx, ruleFixture } from "./helpers/rule-fixtures";
import { globalGovernanceBootstrapPath, globalGovernancePath, RuleGovernanceRepository } from "../src/persistence/rule-governance-repository";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { applyRuleGovernance } from "../src/domain/rule-governance";
import { eventIdForRevision } from "../src/domain/event";
import { archiveProjectRoot, machineCommitRecordPath, machineRegistryJsonPath, machineStatePath } from "../src/persistence/layout";
import { encodeAdmission } from "../src/admission/transport";
import { sha256Text } from "../src/documents/hash";
import * as artifactAdmission from "../src/admission/operation-context";
import { commitFixture } from "./helpers/convergence-fixture";
import { issueMutationContext } from "../src/admission/mutation-context";
import { createProductionRuleQualificationResolver } from "../src/rules/production-qualification";
import { resolveAndQualifyRuleActivation } from "../src/rules/qualification";

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

async function qualifyViaCommitInventory(f: Awaited<ReturnType<typeof fixture>>) {
  const governance = JSON.parse(f.mock.files.get(globalGovernancePath)!);
  const acceptance: any = Object.values(governance.journal).find((entry: any) => entry.transaction.operation === "rule.accept");
  return resolveAndQualifyRuleActivation(createProductionRuleQualificationResolver(createProductionPersistence(f.environment), f.environment), {
    rule: governance.rules[`${f.rule.rule_id}@1`], requested_evidence_refs: [`${globalGovernancePath}#transaction=${acceptance.transaction.transaction_id}`], now: new Date().toISOString()
  });
}

async function reviewInventoryFixture(filesPerProject: number, faults: DropboxMockFault[] = []) {
  const f = await fixture({ resource_scope: { resource_types: ["artifact"], zones: ["REVIEW"] }, parameters: { allowed_zones: ["REVIEW"] } }, false, faults);
  const registry = JSON.parse(f.mock.files.get(machineRegistryJsonPath())!);
  // Durable Object storage outlives individual fixtures in the suite. Allocate
  // new synthetic projects so this I/O measurement cannot inherit another
  // test's cached ProjectGuard state.
  const syntheticProjectIds = Array.from({ length: 3 }, () => `PRJ-${String(++projectNumber).padStart(4, "0")}`);
  for (const project_id of syntheticProjectIds) {
    registry.projects.push({ project_id, slug: "synthetic-convergence", status: "active" });
    for (const commit of commitFixture(project_id, 2)) await f.mock.writeExternal(machineCommitRecordPath(project_id, commit.new_revision), JSON.stringify(commit));
  }
  await f.mock.writeExternal(machineRegistryJsonPath(), JSON.stringify(registry));
  const roots = registry.projects.map((project: any) => `/PROJECT_OS/WORKSPACE/PROJECTS/${project.project_id}-${project.slug}/REVIEW`);
  for (const root of roots) for (let i = 0; i < filesPerProject; i++) await f.mock.writeExternal(`${root}/00-CURRENT/file-${i}.md`, "review member");
  f.environment.PROJECT_OS_ADMISSION_PROJECT_MODES = JSON.stringify(Object.fromEntries(registry.projects.map((project: any) => [project.project_id, "strict"])));
  await runInDurableObject(f.registry, instance => Object.assign((instance as any).env, f.environment));
  // The shared fake lists files only; expose the real immediate folder entry for this nested inventory.
  const outbound = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const path = request.url.endsWith("/2/files/list_folder") ? (await request.clone().json() as any).path : undefined;
    const response = await outbound(input, init);
    if (!roots.includes(path)) return response;
    const listing = await response.json() as any;
    return Response.json({ ...listing, entries: [...listing.entries, { ".tag": "folder", name: "00-CURRENT", path_display: `${path}/00-CURRENT` }] });
  });
  return { ...f, roots: roots as string[] };
}

async function interceptProjectStateReads(f: Awaited<ReturnType<typeof fixture>>, run: () => Promise<void>, alter?: (body: any) => Promise<void>, budget?: { used: number; limit: number }) {
  const namespace = f.environment.PROJECT_GUARD;
  const metrics = { calls: 0, delegatedHttpCalls: 0, maxDelegatedHttpCalls: 0 };
  const outbound = vi.mocked(fetch).getMockImplementation()!;
  let childDepth = 0;
  const spend = () => { if (budget && ++budget.used > budget.limit) throw new Error("Too many subrequests"); };
  if (budget) vi.mocked(fetch).mockImplementation((input, init) => { if (!childDepth) spend(); return outbound(input, init); });
  await runInDurableObject(f.registry, instance => {
    (instance as any).env.PROJECT_GUARD = { getByName(projectId: string) {
      const stub = namespace.getByName(projectId);
      return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        metrics.calls++;
        spend();
        const before = f.mock.calls.length;
        childDepth++;
        let response: Response;
        try { response = await stub.fetch(input, init); } finally { childDepth--; }
        const count = f.mock.calls.length - before;
        metrics.delegatedHttpCalls += count;
        metrics.maxDelegatedHttpCalls = Math.max(metrics.maxDelegatedHttpCalls, count);
        if (!alter || response.status !== 200) return response;
        const body = await response.json();
        await alter(body);
        return Response.json(body);
      } };
    } };
  });
  try { await run(); } finally {
    await runInDurableObject(f.registry, instance => { (instance as any).env.PROJECT_GUARD = namespace; });
    if (budget) vi.mocked(fetch).mockImplementation(outbound);
  }
  return metrics;
}

it.each(["acknowledged", "lost_ack"])("returns the committed v2 receipt with recovery headroom for the entire cold four-project activation: %s", async outcome => {
  const faults: DropboxMockFault[] = [];
  const f = await reviewInventoryFixture(40, faults);
  const rule = { ...f.rule, version: 2, supersedes: 1 };
  expect(await (await f.submit(governanceTx("rule.propose", { rule }, 2, "GLOBAL"))).json()).toMatchObject({ status: "committed" });
  const accept = governanceTx("rule.accept", { rule_id: rule.rule_id, version: 2 }, 3, "GLOBAL");
  expect(await (await f.submit(accept)).json()).toMatchObject({ status: "committed" });
  await evictDurableObject(f.registry);
  await runInDurableObject(f.registry, instance => Object.assign((instance as any).env, f.environment));
  if (outcome === "lost_ack") faults.push({ endpoint: "/2/files/upload", path: globalGovernancePath, occurrence: 1, phase: "after", status: 409, error_summary: "conflict/lost-ack" });
  const budget = { used: 0, limit: 50 };
  await interceptProjectStateReads(f, async () => {
    const tx = governanceTx("rule.activate", { rule_id: rule.rule_id, version: 2, activation_evidence: [`${globalGovernancePath}#transaction=${accept.transaction_id}`] }, 4, "GLOBAL");
    const response = await f.submit(tx);
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ status: "committed", new_revision: 5 });
    const canonical = JSON.parse(f.mock.files.get(globalGovernancePath)!);
    expect(canonical.journal[tx.transaction_id].receipt).toEqual(receipt);
  }, undefined, budget);
  expect(budget.used, "Includes OAuth, delegated calls, final canonical write/recovery and return").toBeLessThanOrEqual(outcome === "lost_ack" ? 49 : 43);
});

it.each(["unread_bootstrap_missing", "changed_initial_transaction", "wrong_token_bootstrap_missing", "consumed_read"])("verifies initialization before publishing when no exact read proof authorizes the write: %s", async fault => {
  const f = await fixture();
  const runtime = createProductionPersistence(f.environment);
  const repository = new RuleGovernanceRepository(runtime);
  let state = JSON.parse(f.mock.files.get(globalGovernancePath)!);
  let token = (await runtime.objects.getMetadata(globalGovernancePath))!.revisionToken!;
  if (fault === "unread_bootstrap_missing") f.mock.files.delete(globalGovernanceBootstrapPath);
  else {
    const verified = (await repository.read())!;
    state = structuredClone(verified.state); token = verified.token;
    if (fault === "changed_initial_transaction") {
      const initial = Object.values(state.journal)[0] as any;
      initial.transaction.payload.rule.source_refs = ["changed-initial-authority"];
      initial.event.payload = structuredClone(initial.transaction.payload);
      state.rules["RULE-PRODUCTION01@1"].source_refs = ["changed-initial-authority"];
    } else {
      if (fault === "consumed_read") await repository.write(state, token);
      else await f.mock.writeExternal(globalGovernancePath, f.mock.files.get(globalGovernancePath)!);
      token = (await runtime.objects.getMetadata(globalGovernancePath))!.revisionToken!;
      f.mock.files.delete(globalGovernanceBootstrapPath);
    }
  }
  const before = f.mock.files.get(globalGovernancePath);
  const uploads = f.mock.uploadCalls.length;
  await expect(repository.write(state, token)).rejects.toThrow(/initialization evidence/);
  expect(f.mock.uploadCalls.slice(uploads)).toEqual([]);
  expect(f.mock.files.get(globalGovernancePath)).toBe(before);
});

it("does not turn an acknowledged canonical activation into unavailable by reading bootstrap afterwards", async () => {
  const f = await fixture();
  const outbound = vi.mocked(fetch).getMockImplementation()!;
  let acknowledged = false;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (acknowledged) throw new Error("Too many subrequests after canonical acknowledgement");
    const request = new Request(input, init);
    const response = await outbound(input, init);
    if (request.url.endsWith("/2/files/upload") && JSON.parse(request.headers.get("Dropbox-API-Arg") ?? "{}").path === globalGovernancePath && response.ok) acknowledged = true;
    return response;
  });
  const response = await f.activate();
  const body = await response.json() as any;
  expect.soft(body).toMatchObject({ status: "committed", new_revision: 3 });
  const canonical = JSON.parse(f.mock.files.get(globalGovernancePath)!);
  expect(canonical.revision).toBe(3);
  expect(Object.values(canonical.journal).some((entry: any) => entry.transaction.operation === "rule.activate" && entry.receipt.status === "committed")).toBe(true);
});

it("keeps four-project qualification I/O independent of the number of REVIEW files", async () => {
  const counts: number[] = [];
  const profiles: Array<Record<string, number>> = [];
  for (const filesPerProject of [1, 40]) {
    const f = await reviewInventoryFixture(filesPerProject);
    const providerStart = f.mock.providerCalls.length;
    const metrics = await interceptProjectStateReads(f, async () => { expect(await (await f.activate()).json()).toMatchObject({ status: "committed" }); });
    const calls = f.mock.providerCalls.slice(providerStart);
    const profile: Record<string, number> = {};
    for (const call of calls) {
      const signature = `${call.endpoint} ${call.paths.join(",")}`;
      profile[signature] = (profile[signature] ?? 0) + 1;
    }
    profiles.push(profile);
    // The generic fetch counter also includes non-provider work and unrelated
    // alarm traffic. Measure the Dropbox calls whose scaling this test guards.
    counts.push(calls.length);
    // The audit below proves four distinct project snapshots. A scheduled
    // alarm may make another ProjectGuard call through this shared stub.
    expect(metrics.calls).toBeGreaterThanOrEqual(4);
    expect(metrics.calls).toBeLessThanOrEqual(8);
    expect(metrics.maxDelegatedHttpCalls).toBeLessThanOrEqual(50);
    expect(calls.some(call => call.endpoint.endsWith("/files/get_metadata") && call.paths.some(path => path.includes("/REVIEW/")))).toBe(false);
    const proof: any = Object.values(JSON.parse(f.mock.files.get(globalGovernancePath)!).journal).find((entry: any) => entry.qualification);
    expect(proof.qualification.proof.audit.project_states).toHaveLength(4);
    expect(proof.qualification.proof.audit.directories.map((entry: any) => entry.path)).toEqual(expect.arrayContaining(f.roots.flatMap(root => [root, `${root}/00-CURRENT`])));
  }
  // A per-file scan would add O(160) calls; a small fixed variation from
  // scheduled project work does not imply REVIEW inventory scaling.
  expect(counts[1], `provider request counts for 4 vs 160 files: ${counts.join(", ")}; profiles: ${JSON.stringify(profiles)}`).toBeLessThanOrEqual(counts[0]! + 8);
  expect(counts[1]).toBeLessThanOrEqual(50);
});

it.each(["project", "slug", "status", "revision", "hash", "stale"])("refuses mismatched or stale ProjectGuard authority: %s", async fault => {
  const f = await fixture();
  await interceptProjectStateReads(f, async () => {
    expect(await (await f.activate()).json()).toMatchObject({ error: "QUALIFICATION_INVENTORY_UNAVAILABLE" });
  }, async body => {
    if (fault === "project") body.canonical_state.project_id = "PRJ-9999";
    if (fault === "slug") body.canonical_state.slug = "other-project";
    if (fault === "status") body.canonical_state.status = "archived";
    if (fault === "revision") body.canonical_state.revision++;
    if (fault === "hash") body.context.state_hash = "f".repeat(64);
    if (fault === "stale") body.context = await issueMutationContext(body.canonical_state, f.environment.MUTATION_CONTEXT_SIGNING_KEY!, Date.now() - 60_000);
  });
});

it.each(["source", "global"])("still refuses canonical %s changes during destination inventory", async changed => {
  const f = await reviewInventoryFixture(3);
  const path = changed === "source" ? machineCommitRecordPath(f.project, 2) : globalGovernancePath;
  const outbound = vi.mocked(fetch).getMockImplementation()!;
  let altered = false;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (!altered && request.url.endsWith("/2/files/list_folder") && (await request.clone().json() as any).path.endsWith("/REVIEW")) {
      altered = true;
      await f.mock.writeExternal(path, f.mock.files.get(path)!);
    }
    return outbound(input, init);
  });
  expect(await (await f.activate()).json()).toMatchObject({ error: "QUALIFICATION_INVENTORY_UNAVAILABLE" });
});

it("rejects a REVIEW listing changed before final inventory revalidation", async () => {
  const f = await reviewInventoryFixture(3);
  const outbound = vi.mocked(fetch).getMockImplementation()!;
  const target = `${f.roots[0]}/00-CURRENT`;
  let lists = 0;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/2/files/list_folder") && (await request.clone().json() as any).path === target && ++lists === 2) await f.mock.writeExternal(`${target}/late-member.md`, "new membership");
    return outbound(input, init);
  });
  expect(await (await f.activate()).json()).toMatchObject({ error: "QUALIFICATION_INVENTORY_UNAVAILABLE", qualification: { observed: "Directory inventory changed during qualification" } });
});

it.each(["list", "metadata", "metadata_revalidation"])("diagnoses canonical qualification I/O without exposing provider response secrets: %s", async operation => {
  const faults: DropboxMockFault[] = [];
  const f = await fixture({}, false, faults);
  const root = `/PROJECT_OS/WORKSPACE/PROJECTS/${f.project}-qualification/WORKING`;
  const file = machineCommitRecordPath(f.project, 2);
  const path = operation === "list" ? root : file;
  faults.push({ endpoint: operation === "list" ? "/2/files/list_folder" : "/2/files/get_metadata", path, occurrence: operation === "metadata_revalidation" ? 3 : 1, status: 403, error_summary: "secret-provider-body-DO-NOT-EXPOSE" });
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

it("the direct commit-inventory fallback fails closed on an internal history hole", async () => {
  const f = await fixture();
  f.mock.files.delete(machineCommitRecordPath(f.project, 2));
  expect(await qualifyViaCommitInventory(f)).toMatchObject({ code: "QUALIFICATION_INVENTORY_UNAVAILABLE" });
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
  const commits = commitFixture("PRJ-0002", 169);
  for (const commit of commits.slice(51)) await f.mock.writeExternal(machineCommitRecordPath("PRJ-0002", commit.new_revision), JSON.stringify(commit));
  await f.mock.writeExternal(machineStatePath("PRJ-0002"), JSON.stringify(commits.at(-1)!.state));
  await f.mock.writeExternal(`${archiveProjectRoot("PRJ-0001", "legacy-archive-one")}/ARTIFACTS/legacy.md`, "Terminal archive is outside admission scope");
  f.environment.PROJECT_OS_ADMISSION_PROJECT_MODES = JSON.stringify({ [f.project]: "strict", "PRJ-0002": "strict" });
  await runInDurableObject(f.registry, instance => Object.assign((instance as any).env, f.environment));
  return f;
}

it("qualifies a contiguous migrated 52..169 suffix and ignores terminal archives without machine history", async () => {
  const f = await migratedRegistryFixture();
  const fallback = await qualifyViaCommitInventory(f);
  expect(fallback.verdict).toBe("allow");
  const paths = fallback.qualification_proof!.audit!.objects.map(object => object.path);
  expect(paths).toContain(machineCommitRecordPath("PRJ-0002", 52));
  expect(paths).toContain(machineCommitRecordPath("PRJ-0002", 169));
  const response = await f.activate();
  expect(await response.json()).toMatchObject({ status: "committed" });
  const governance = JSON.parse(f.mock.files.get(globalGovernancePath)!);
  const activation: any = Object.values(governance.journal).find((entry: any) => entry.transaction.operation === "rule.activate");
  expect(activation.qualification.proof.audit.project_states).toEqual(expect.arrayContaining([expect.objectContaining({ project_id: "PRJ-0002", revision: 169, authority: "ProjectGuard" })]));
  expect(activation.qualification.proof.audit.directories.some((entry: any) => entry.path.includes("/PRJ-0001/") || entry.path.includes("/PRJ-0004/"))).toBe(false);
  expect(f.mock.files.has(machineCommitRecordPath("PRJ-0002", 1))).toBe(false);
  expect(f.mock.files.has(machineCommitRecordPath("PRJ-0001", 1))).toBe(false);
});

it.each(["internal_hole", "first_previous_revision", "first_filename_binding", "latest_filename_binding"])("direct commit-inventory fallback refuses an unverified migrated suffix: %s", async fault => {
  const f = await migratedRegistryFixture();
  if (fault === "internal_hole") f.mock.files.delete(machineCommitRecordPath("PRJ-0002", 100));
  else {
    const path = machineCommitRecordPath("PRJ-0002", fault === "latest_filename_binding" ? 169 : 52);
    const commit = JSON.parse(f.mock.files.get(path)!);
    if (fault === "first_previous_revision") commit.previous_revision = 0;
    else Object.assign(commit, JSON.parse(f.mock.files.get(machineCommitRecordPath("PRJ-0002", 53))!));
    await f.mock.writeExternal(path, JSON.stringify(commit));
  }
  expect(await qualifyViaCommitInventory(f)).toMatchObject({ code: "QUALIFICATION_INVENTORY_UNAVAILABLE" });
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
