import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Receipt } from "../src/domain/receipt";
import { sha256Text } from "../src/documents/hash";
import { installDropboxMock } from "./helpers/mock-dropbox";
import { bootstrapRuleAdmissionGovernance } from "./helpers/rule-admission-governance";
import { encodeAdmission } from "../src/admission/transport";
import { normalizeDocumentAdmission } from "../src/admission/operation-context";
import { createProductionPersistence } from "../src/persistence/production-factory";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { documentIdFor } from "../src/domain/managed-document";
import { ruleFixture } from "./helpers/rule-fixtures";
import { machineDocumentHeadPath, machineDocumentVersionPath, machineStatePath } from "../src/persistence/layout";

const testEnv = env as unknown as Env;
const at = "2026-08-24T19:35:00+01:00";
const governanceSigningKey = "project-document-governance";

async function createProject(transactionId: string): Promise<Receipt> {
  const suffix = transactionId.slice(-4).toLowerCase();
  const response = await testEnv.REGISTRY_GUARD.getByName("global").fetch("https://registry-guard.internal/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.0",
      transaction_id: transactionId,
      project_id: "PRJ-AUTO",
      base_revision: 0,
      operation: "project.create",
      created_at: at,
      payload: { name: `Document ${suffix}`, slug: `document-${suffix}`, aliases: [], objective: "Managed docs" }
    })
  });
  const receipt = await response.json<Receipt>();
  expect(receipt.status).toBe("committed");
  return receipt;
}

describe("ProjectGuard managed documents", () => {
  beforeEach(async () => {
    installDropboxMock();
    await bootstrapRuleAdmissionGovernance(testEnv, governanceSigningKey);
  });
  afterEach(() => vi.restoreAllMocks());

  it("freezes a referenced document and resumes governed package effects through the existing document boundary", async () => {
    installDropboxMock({ immutableRevisions: true });
    await bootstrapRuleAdmissionGovernance(testEnv, governanceSigningKey);
    const created = await createProject("TXN-PACKAGE-PROJECT-0092");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const write = async (request_id: string, logical_path: string, content: string) => {
      const response = await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify({ operation: "working.write", request_id, project_id: created.project_id, logical_path, content, content_sha256: await sha256Text(content), created_at: at }) });
      const receipt: any = await response.json(); expect(receipt.status).toBe("committed"); return receipt;
    };
    const member = await write("DOCREQ-PACKAGE-MEMBER-0092", "member.md", "# Member");
    const repository = new DocumentLedgerRepository(createProductionPersistence(testEnv));
    const version = (await repository.readVersion(created.project_id, member.document_id, member.version_id))!;
    const manifest = { schema_version: "1.0", project_id: created.project_id, creation_request_id: "DOCREQ-PACKAGE-CREATE-0092", version: 1, members: [{ relative_path: "member.md", document_id: member.document_id, document_version_id: member.version_id, immutable_payload_path: version.immutable_payload_path, content_sha256: version.content_sha256, size: version.size }], links: [], source_refs: ["accepted:fixture"], created_by: "operator", created_at: at };
    const content = JSON.stringify(manifest);
    const descriptor = await write("DOCREQ-PACKAGE-MANIFEST-0092", "manifest.json", content);
    const key = governanceSigningKey;
    await runInDurableObject(guard, (instance) => Object.assign((instance as any).env, { MUTATION_CONTEXT_SIGNING_KEY: key, RULE_ADMISSION_SIGNING_KEY: key, PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" }) }));
    const { context }: any = await (await guard.fetch("https://internal/mutation-context")).json();
    const submit = async (request: unknown) => (await guard.fetch("https://internal/document", { method: "POST", body: JSON.stringify(encodeAdmission(request, context)) })).json<any>();
    const frozen = await submit({ operation: "package.freeze", request_id: "DOCREQ-PACKAGE-FREEZE-0092", project_id: created.project_id, document_id: descriptor.document_id, expected_version_id: descriptor.version_id, content_sha256: await sha256Text(content), expected_project_revision: 1, created_at: at });
    expect(frozen).toMatchObject({ status: "committed", candidate: { version: 1 } });
    const request = { operation: "package.replace", request_id: "DOCREQ-PACKAGE-REPLACE-0092", project_id: created.project_id, candidate: frozen.candidate, zone: "WORKING", expected_navigation_generation: 0, expected_project_revision: 1, created_at: at };
    let result = await submit(request);
    for (let count = 0; count < 5 && result.status === "finalizing"; count++) result = await submit(request);
    expect(result).toMatchObject({ status: "committed", execution_status: "finalized" });
    expect((await repository.readPackageNavigation(created.project_id)).WORKING?.packages[0].ref).toEqual(frozen.candidate);
    expect(await submit(request)).toEqual(result);
  });

  it("package transport refuses legacy ungoverned execution even with a well-formed manifest reference", async () => {
    const created = await createProject("TXN-PACKAGE-PROJECT-0091");
    const response = await testEnv.PROJECT_GUARD.getByName(created.project_id).fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "package.replace", request_id: "DOCREQ-PACKAGE-GUARD-0091", project_id: created.project_id, candidate: { project_id: created.project_id, package_id: `PKG-${"A".repeat(64)}`, version: 1, manifest_sha256: "b".repeat(64) }, zone: "WORKING", expected_navigation_generation: 0, expected_project_revision: 1, created_at: at })
    });
    expect(await response.json()).toMatchObject({ status: "rejected", code: "PACKAGE_GOVERNANCE_REQUIRED" });
  });

  it("writes a working document and exposes compact logical status", async () => {
    const created = await createProject("TXN-DOCUMENT-PROJECT-0001");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const content = "# Commercial strategy";
    const write = await guard.fetch("https://project-guard.internal/document", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "working.write",
        request_id: "DOCREQ-WORK-36010001",
        project_id: created.project_id,
        logical_path: "strategy/commercial.md",
        content,
        content_sha256: await sha256Text(content),
        created_at: at
      })
    });
    expect(write.status).toBe(200);
    const receipt = await write.json<{ status: string; document_id: string; version_id: string; stage: string }>();
    expect(receipt).toMatchObject({ status: "committed", stage: "working" });

    const status = await guard.fetch(
      `https://project-guard.internal/document-status?document_id=${encodeURIComponent(receipt.document_id)}`,
      { method: "GET" }
    );
    expect(status.status).toBe(200);
    const body = await status.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      project_id: created.project_id,
      document_id: receipt.document_id,
      kind: "work_product",
      logical_path: "strategy/commercial.md",
      working_version_id: receipt.version_id,
      reconciliation_status: "clean"
    });
    expect(JSON.stringify(body)).not.toContain(content);
    expect(body).not.toHaveProperty("provider");
  });

  it("keeps an unqualified local expected-version rule unavailable", async () => {
    const mock = installDropboxMock();
    await bootstrapRuleAdmissionGovernance(testEnv, governanceSigningKey);
    const created = await createProject("TXN-DOCUMENT-PROJECT-0008");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const initialContent = "first";
    const initial = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        operation: "working.write", request_id: "DOCREQ-WORK-36080001", project_id: created.project_id,
        logical_path: "strategy/rule-evidence.md", content: initialContent,
        content_sha256: await sha256Text(initialContent), created_at: at
      })
    });
    const first = await initial.json<{ document_id: string; version_id: string }>();
    const signing = "document-rule-observation-signing";
    await bootstrapRuleAdmissionGovernance(testEnv, signing, created.project_id);
    let modifiedState = "";
    await runInDurableObject(guard, (instance, state) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        MUTATION_CONTEXT_SIGNING_KEY: signing,
        RULE_ADMISSION_SIGNING_KEY: signing,
        PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({ [created.project_id]: "strict" })
      });
      const row = state.storage.sql.exec<{ state_json: string }>("SELECT state_json FROM project_state WHERE singleton = 1").toArray()[0]!;
      const project = JSON.parse(row.state_json);
      const active = ruleFixture(created.project_id, {
        rule_id: "RULE-DOCUMENT-VERSION-0008", status: "active", activation_evidence: ["server:qualified"],
        operations: ["working.write"], resource_scope: { resource_types: ["document"], zones: ["DOCUMENTS"] },
        check_id: "expected_version", parameters: { required: true }
      });
      project.local_rules = { [`${active.rule_id}@${active.version}`]: active };
      modifiedState = JSON.stringify(project);
      state.storage.sql.exec("UPDATE project_state SET state_json = ? WHERE singleton = 1", modifiedState);
    });
    mock.files.set(machineStatePath(created.project_id), `${modifiedState}\n`);
    const { context }: any = await (await guard.fetch("https://project-guard.internal/mutation-context")).json();
    const nextContent = "second";

    const response = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(encodeAdmission({
        operation: "working.write", request_id: "DOCREQ-WORK-36080002", project_id: created.project_id,
        logical_path: "strategy/rule-evidence.md", content: nextContent,
        content_sha256: await sha256Text(nextContent), expected_version_id: first.version_id, created_at: at
      }, context))
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "LOCAL_RULE_QUALIFICATION_UNAVAILABLE" });
  });

  it("rejects a head changed during observation and re-reads independent durable head/version evidence", async () => {
    const mock = installDropboxMock();
    await bootstrapRuleAdmissionGovernance(testEnv, governanceSigningKey);
    const created = await createProject("TXN-DOCUMENT-PROJECT-0009");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const initialContent = "first";
    const initial = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        operation: "working.write", request_id: "DOCREQ-WORK-36090001", project_id: created.project_id,
        logical_path: "strategy/stable-evidence.md", content: initialContent,
        content_sha256: await sha256Text(initialContent), created_at: at
      })
    });
    expect(initial.status).toBe(200);
    await initial.json();
    const documentId = await documentIdFor(created.project_id, "strategy/stable-evidence.md");
    const first = await new DocumentLedgerRepository(createProductionPersistence(testEnv)).readHead(created.project_id, documentId);
    expect(first?.working_version_id).toBeDefined();
    const request = {
      operation: "working.write", request_id: "DOCREQ-WORK-36090002", project_id: created.project_id,
      logical_path: "strategy/stable-evidence.md", content: "second",
      content_sha256: await sha256Text("second"), expected_version_id: first!.working_version_id!, created_at: at
    } as const;
    const normalized = await normalizeDocumentAdmission(request);
    const headPath = machineDocumentHeadPath(created.project_id, documentId);
    let metadataSpy: ReturnType<typeof vi.spyOn>;
    await runInDurableObject(guard, (instance) => {
      const runtime = (instance as unknown as { persistence: ReturnType<typeof createProductionPersistence> }).persistence;
      const original = runtime.objects.getMetadata.bind(runtime.objects);
      let changed = false;
      metadataSpy = vi.spyOn(runtime.objects, "getMetadata").mockImplementation(async (path) => {
        const metadata = await original(path);
        if (!changed && path === headPath) {
          changed = true;
          await mock.writeExternal(headPath, mock.files.get(headPath)!);
        }
        return metadata;
      });
    });

    const unstable = await runInDurableObject(guard, async (instance) => {
      const project = await (instance as any).loadOrRecoverState();
      return (instance as any).resolveServerObservations(project, normalized);
    });

    expect(unstable).toEqual([]);
    metadataSpy!.mockRestore();
    const runtime = createProductionPersistence(testEnv);
    const versionPath = machineDocumentVersionPath(created.project_id, documentId, first!.working_version_id!);
    const headBeforeRetry = await runtime.objects.getMetadata(headPath);
    const versionBeforeRetry = await runtime.objects.getMetadata(versionPath);
    expect(headBeforeRetry).toMatchObject({ path: headPath, objectId: expect.any(String), revisionToken: expect.any(String), integrityHash: expect.any(Object) });
    expect(versionBeforeRetry).toMatchObject({ path: versionPath, objectId: expect.any(String), revisionToken: expect.any(String), integrityHash: expect.any(Object) });

    const observations = await runInDurableObject(guard, async (instance) => {
      const project = await (instance as any).loadOrRecoverState();
      return (instance as any).resolveServerObservations(project, normalized);
    });

    const ref = (metadata: NonNullable<typeof headBeforeRetry>) =>
      `${metadata.path}#object_id=${encodeURIComponent(metadata.objectId!)}&revision_token=${encodeURIComponent(metadata.revisionToken!)}&integrity_hash_algorithm=${encodeURIComponent(metadata.integrityHash!.algorithm)}&integrity_hash=${encodeURIComponent(metadata.integrityHash!.value)}`;
    expect(observations).toMatchObject([{ current_version: first!.working_version_id, evidence_refs: [ref(headBeforeRetry!), ref(versionBeforeRetry!)] }]);
  });

  it("rejects request-id reuse with a different document payload", async () => {
    const created = await createProject("TXN-DOCUMENT-PROJECT-0002");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const base = {
      operation: "working.write",
      request_id: "DOCREQ-WORK-36020001",
      project_id: created.project_id,
      logical_path: "strategy/commercial.md",
      content: "one",
      content_sha256: await sha256Text("one"),
      created_at: at
    };
    const first = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base)
    });
    expect((await first.json<{ status: string }>()).status).toBe("committed");

    const changed = { ...base, content: "two", content_sha256: await sha256Text("two") };
    const second = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(changed)
    });
    expect(await second.json()).toMatchObject({ status: "rejected", code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  });

  it("keeps request-id binding durable when the local document request cache is lost", async () => {
    const created = await createProject("TXN-DOCUMENT-PROJECT-0004");
    const guard = testEnv.PROJECT_GUARD.getByName(created.project_id);
    const base = {
      operation: "working.write",
      request_id: "DOCREQ-WORK-36040001",
      project_id: created.project_id,
      logical_path: "strategy/original.md",
      content: "durable original",
      content_sha256: await sha256Text("durable original"),
      created_at: at
    };
    const first = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base)
    });
    const committed = await first.json<Record<string, unknown>>();
    expect(committed).toMatchObject({ status: "committed", request_id: base.request_id });

    await runInDurableObject(guard, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM document_requests");
    });

    const exactReplay = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base)
    });
    expect(await exactReplay.json()).toEqual(committed);

    await runInDurableObject(guard, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM document_requests");
    });

    const changed = {
      ...base,
      logical_path: "strategy/other.md",
      content: "different effect",
      content_sha256: await sha256Text("different effect")
    };
    const mismatch = await guard.fetch("https://project-guard.internal/document", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(changed)
    });
    expect(await mismatch.json()).toMatchObject({ status: "rejected", code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  });

  it("fails closed when the Durable Object project binding differs", async () => {
    const created = await createProject("TXN-DOCUMENT-PROJECT-0003");
    const guard = testEnv.PROJECT_GUARD.getByName("PRJ-9999");
    const response = await guard.fetch("https://project-guard.internal/document", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "working.write",
        request_id: "DOCREQ-WORK-36030001",
        project_id: created.project_id,
        logical_path: "strategy/commercial.md",
        content: "x",
        content_sha256: await sha256Text("x"),
        created_at: at
      })
    });
    expect(await response.json()).toMatchObject({ status: "rejected", code: "PROJECT_BINDING_MISMATCH" });
  });
});
