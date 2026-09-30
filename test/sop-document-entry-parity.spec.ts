import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { createControlTowerServer } from "../src/control-tower/mcp";
import { encodeAdmission } from "../src/admission/transport";
import { sha256Text } from "../src/documents/hash";
import { globalGovernancePath } from "../src/persistence/rule-governance-repository";
import { machineCommitRecordPath } from "../src/persistence/layout";
import { machineRegistryJsonPath } from "../src/persistence/layout";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import { governanceTx, ruleFixture } from "./helpers/rule-fixtures";

const baseEnv = env as unknown as Env;
const createdAt = "2026-09-29T12:00:00.000Z";
const signingKey = "sop-document-entry-signing-key";
const governanceToken = "rule-admission-test-authority";
const ingressToken = "sop-document-entry-ingress-token";
const operatorToken = "sop-document-entry-operator-token";
let projectNumber = 9800;

async function setup() {
  const allocatedNumber = ++projectNumber;
  const mock = installDropboxMock();
  const registry = baseEnv.REGISTRY_GUARD.getByName("global");
  const environment = {
    ...baseEnv,
    RULE_GOVERNANCE_TOKEN: governanceToken,
    RULE_ADMISSION_SIGNING_KEY: signingKey,
    MUTATION_CONTEXT_SIGNING_KEY: signingKey,
    INGRESS_TOKEN: ingressToken,
    CONTROL_TOWER_OPERATOR_TOKEN: operatorToken,
    PROJECT_OS_LAYOUT_MODE: "v2",
    CF_VERSION_METADATA: { id: "sop-document-entry-test-version", tag: `git-${"b".repeat(40)}` }
  } as Env;
  await runInDurableObject(registry, (instance, state) => {
    Object.assign((instance as any).env, environment);
    state.storage.sql.exec("DELETE FROM requests WHERE project_id = 'GLOBAL'; DELETE FROM governance_events; DELETE FROM meta WHERE key = 'rule_governance'");
    state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'next_project_number'", String(allocatedNumber));
  });

  const createdResponse = await registry.fetch("https://registry-guard.internal/create", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(governanceTx("project.create", {
      name: `SOP document entry ${allocatedNumber}`, slug: `sop-document-entry-${allocatedNumber}`, aliases: [], objective: "Verify exact-approval wrappers"
    }, 0, "PRJ-AUTO"))
  });
  const created: any = await createdResponse.json();
  expect(created, JSON.stringify(created)).toMatchObject({ status: "committed", project_id: expect.stringMatching(/^PRJ-/) });
  const projectId = created.project_id as string;
  const guard = environment.PROJECT_GUARD.getByName(projectId);
  const registryBody = JSON.parse(mock.files.get(machineRegistryJsonPath())!);
  const projectModes = JSON.stringify(Object.fromEntries(registryBody.projects.filter((project: any) => project.status !== "archived")
    .map((project: any) => [project.project_id, "strict"])));
  Object.assign(environment, { PROJECT_OS_ADMISSION_PROJECT_MODES: projectModes });
  await runInDurableObject(registry, instance => Object.assign((instance as any).env, environment));
  await runInDurableObject(guard, instance => Object.assign((instance as any).env, environment));
  await bootstrapRuleAdmissionGovernance(environment, signingKey, projectId);

  const context = async (token: string) => {
    const response = await guard.fetch("https://project-guard.internal/mutation-context?include_state=false", {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.status).toBe(200);
    return (await response.json<any>()).context;
  };
  const decisionTx = governanceTx("decision.accept", {
    decision_id: "DEC-SOPENTRY01", title: "Exact document entry test", decision: "Use canonical versions", reason: "Qualification fixture", impacts: []
  }, created.new_revision, projectId);
  const decisionResponse = await guard.fetch("https://project-guard.internal/transaction", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(encodeAdmission(decisionTx, await context(ingressToken)))
  });
  const decision: any = await decisionResponse.json();
  expect(decision).toMatchObject({ status: "committed" });

  const operationNames = ["document.publish", "review.promote"];
  const rule = ruleFixture("GLOBAL", {
    rule_id: "RULE-SOP-DOC-ENTRY01",
    title: "Require exact approval for document lifecycle",
    source_refs: [machineCommitRecordPath(projectId, decision.new_revision)],
    operations: operationNames,
    resource_scope: { resource_types: ["document"], zones: ["DOCUMENTS"] },
    check_id: "exact_approval", parameters: {}, enforcement: "explicit_approval", check_stage: "pre_admission"
  });
  const submitGovernance = (tx: unknown) => registry.fetch("https://registry-guard.internal/governance/transaction", {
    method: "POST", headers: { authorization: `Bearer ${governanceToken}`, "content-type": "application/json" }, body: JSON.stringify(tx)
  });
  const proposed = governanceTx("rule.propose", { rule }, 1, "GLOBAL");
  const proposedResponse = await submitGovernance(proposed);
  expect(proposedResponse.ok, await proposedResponse.clone().text()).toBe(true);
  const accepted = governanceTx("rule.accept", { rule_id: rule.rule_id, version: 1 }, 2, "GLOBAL");
  expect((await submitGovernance(accepted)).ok).toBe(true);
  const activated = await submitGovernance(governanceTx("rule.activate", {
    rule_id: rule.rule_id, version: 1, activation_evidence: [`${globalGovernancePath}#transaction=${accepted.transaction_id}`]
  }, 3, "GLOBAL"));
  expect(activated.ok, await activated.clone().text()).toBe(true);
  expect(await activated.clone().json<any>()).toMatchObject({ status: "committed" });

  const controlTower = createControlTowerServer(environment as unknown as Parameters<typeof createControlTowerServer>[0], { read: true, mutate: true }) as any;
  return { environment, guard, projectId, context, controlTower, mock };
}

async function bodyFrom(response: Response | any): Promise<{ status: number; body: any }> {
  if (response instanceof Response) return { status: response.status, body: await response.json() };
  return { status: response.isError ? 409 : 200, body: JSON.parse(response.content[0].text) };
}

it.each(["API", "Control Tower", "ProjectGuard"] as const)(
  "requires an exact live grant before review promotion and publication via %s",
  async entry => {
    const f = await setup();
    let requestNumber = 0;
    const requestId = (name: string) => `DOCREQ-SOP-${name}-${entry.replace(/[^A-Z]/g, "") || "PG"}-${String(++requestNumber).padStart(4, "0")}`;
    const submit = async (request: Record<string, unknown>): Promise<{ status: number; body: any }> => {
      if (entry === "Control Tower") {
        return bodyFrom(await f.controlTower._registeredTools.project_os_write_working_document.handler({ project_id: f.projectId, request }));
      }
      const mutationContext = await f.context(ingressToken);
      const encoded = JSON.stringify(encodeAdmission(request, mutationContext));
      if (entry === "ProjectGuard") {
        return bodyFrom(await f.guard.fetch("https://project-guard.internal/document", {
          method: "POST", headers: { "content-type": "application/json" }, body: encoded
        }));
      }
      return bodyFrom(await worker.fetch(new Request("https://example.com/v1/documents", {
        method: "POST", headers: { authorization: `Bearer ${ingressToken}`, "content-type": "application/json" }, body: encoded
      }), f.environment, createExecutionContext()));
    };

    const workingContent = "# Exact approval entry parity\n";
    const workingResponse = await f.guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(encodeAdmission({
        operation: "working.write", request_id: requestId("WORK"), project_id: f.projectId,
        logical_path: "sop-entry.md", content: workingContent, content_sha256: await sha256Text(workingContent), created_at: createdAt
      }, await f.context(ingressToken)))
    });
    const working: any = await workingResponse.json();
    expect(working).toMatchObject({ status: "committed", document_id: expect.stringMatching(/^DOC-/), version_id: expect.stringMatching(/^VER-/) });

    const grant = async (operation: "review.promote" | "document.publish", resourceVersion: string) => {
      const token = operatorToken;
      const mutationContext = await f.context(token);
      expect(mutationContext.actor).toEqual({ actor_id: "control_tower", authority: "control_tower_operator" });
      const tx = governanceTx("approval.grant", {
        approval_id: `APR-SOP-${entry.replace(/[^A-Z]/g, "")}-${operation.replace(/\./g, "-").toUpperCase()}`,
        actor_id: entry === "Control Tower" ? "control_tower" : "ingress",
        rule_id: "RULE-SOP-DOC-ENTRY01", rule_version: 1, rule_scope: { kind: "global" },
        resource_id: working.document_id, resource_type: "document", resource_zone: "DOCUMENTS",
        resource_version: resourceVersion, operation, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      }, mutationContext.canonical_revision, f.projectId);
      const response = await f.guard.fetch("https://project-guard.internal/transaction", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encodeAdmission(tx, mutationContext))
      });
      const receipt = await response.json<any>();
      expect(receipt).toMatchObject({ status: "committed", transaction_id: tx.transaction_id });
    };

    const promoteRequest = (request_id: string) => ({ operation: "review.promote", request_id, project_id: f.projectId,
      document_id: working.document_id, expected_version_id: working.version_id, created_at: createdAt });
    const deniedPromote = await submit(promoteRequest(requestId("REVIEW-DENY")));
    expect(deniedPromote.status).toBe(409);
    expect(deniedPromote.body).toMatchObject({ error: "EXACT_APPROVAL_REQUIRED" });
    await grant("review.promote", working.version_id);
    const promoted = await submit(promoteRequest(requestId("REVIEW-ALLOW")));
    expect(promoted.status).toBe(200);
    expect(promoted.body).toMatchObject({ status: "committed", document_id: working.document_id, version_id: expect.stringMatching(/^VER-/) });

    const publishRequest = (request_id: string) => ({ operation: "publish", request_id, project_id: f.projectId,
      document_id: working.document_id, expected_version_id: promoted.body.version_id, created_at: createdAt });
    const deniedPublish = await submit(publishRequest(requestId("PUBLISH-DENY")));
    expect(deniedPublish.status).toBe(409);
    expect(deniedPublish.body).toMatchObject({ error: "EXACT_APPROVAL_REQUIRED" });
    await grant("document.publish", promoted.body.version_id);
    const published = await submit(publishRequest(requestId("PUBLISH-ALLOW")));
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ status: "committed", document_id: working.document_id, stage: "published" });
    expect(f.mock.files.has(machineCommitRecordPath(f.projectId, 2))).toBe(true);
  }
);
