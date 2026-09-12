import { describe, expect, it } from "vitest";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ManagedDocumentService } from "../src/documents/service";
import { emptyProjectState } from "../src/domain/transitions";
import { sha256Text } from "../src/documents/hash";
import { canonicalJson } from "../src/rules/contract";
import { ExecutionJournal } from "../src/execution/journal";
import { packageRuntime } from "./helpers/package-runtime";
import { ruleFixture } from "./helpers/rule-fixtures";
import { StableWorkProductReconciler } from "../src/documents/stable-work-product-reconciler";
import { packageNavigationLedgerSchema } from "../src/domain/document-package";

async function fixture(memberCount = 1) {
  const store = packageRuntime();
  const repository = new DocumentLedgerRepository(store.runtime);
  const state = emptyProjectState("PRJ-9300", "Packages", "packages");
  const content = "first", hash = await sha256Text(content);
  const document_id = `DOC-${"1".repeat(24)}`, document_version_id = `VER-REQ-${"1".repeat(24)}`;
  const immutable_payload_path = await repository.storeTextPayload(state.project_id, hash, content);
  await repository.writeVersion({ schema_version: "1.0", project_id: state.project_id, document_id, version_id: document_version_id, kind: "work_product", stage: "working", logical_path: "a.md", source: "project_os", created_at: "2026-09-12T12:00:00Z", immutable_payload_path, content_sha256: hash, size: content.length });
  const manifest = { schema_version: "1.0", project_id: state.project_id, creation_request_id: "DOCREQ-PACKAGE-0001", version: 1, members: [{ relative_path: "a.md", document_id, document_version_id, immutable_payload_path, content_sha256: hash, size: content.length }], links: [], source_refs: ["accepted:package"], created_by: "operator", created_at: "2026-09-12T12:00:00Z" };
  for (let index = 1; index < memberCount; index++) {
    const payload = `member ${index}`, content_sha256 = await sha256Text(payload);
    const member = { relative_path: `${index}.md`, document_id: `DOC-${String(index + 1).repeat(24)}`, document_version_id: `VER-REQ-${String(index + 1).repeat(24)}`, immutable_payload_path: await repository.storeTextPayload(state.project_id, content_sha256, payload), content_sha256, size: payload.length };
    await repository.writeVersion({ schema_version: "1.0", project_id: state.project_id, document_id: member.document_id, version_id: member.document_version_id, kind: "work_product", stage: "working", logical_path: member.relative_path, source: "project_os", created_at: manifest.created_at, immutable_payload_path: member.immutable_payload_path, content_sha256, size: payload.length });
    manifest.members.push(member);
  }
  const ref = await repository.freezePackage(manifest);
  const request = { operation: "package.replace", request_id: "DOCREQ-REPLACE-0001", project_id: state.project_id, candidate: ref, zone: "WORKING", expected_navigation_generation: 0, expected_project_revision: 0, created_at: "2026-09-12T12:00:00Z" };
  const admission = async (r: any) => ({ project_id: state.project_id, operation: "package.replace", kind: "document", request_id: r.request_id, request_hash: await sha256Text(canonicalJson(r)), actor: { actor_id: "operator", authority: "ingress" }, resources: [{ resource_id: r.candidate.package_id, resource_type: "package", zone: r.zone, version: `${r.candidate.version}:${r.candidate.manifest_sha256}` }], global_revision: 0, project_revision: 0, ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: 0 }, verdict: "allow", results: [], gaps: [], deferred_rules: [] });
  const service: any = new ManagedDocumentService(store.runtime);
  return { ...store, repository, service, state, manifest, request, admission };
}

describe("package replacement through frozen L4 effects", () => {
  it("refuses a destination identity substitution between create response and observation", async () => {
    const f = await fixture();
    const copy = f.runtime.serverSideCopy.copyObjectVersion!;
    f.runtime.serverSideCopy.copyObjectVersion = async (...args) => {
      const result = await copy(...args);
      const content = f.files.get(args[1])!.content;
      f.files.delete(args[1]); f.put(args[1], content);
      return result;
    };
    expect((await f.service.replacePackage(f.request, f.state, await f.admission(f.request))).status).not.toBe("finalized");
    expect([...f.files.keys()].some(p => p.endsWith("/navigation.json"))).toBe(false);
  });
  it("decodes historical schema 1.0 navigation without inventing visible member evidence", () => {
    const historical = { schema_version: "1.0", project_id: "PRJ-9300", source_request_id: "DOCREQ-HISTORICAL-0001", heads: {} };
    expect(packageNavigationLedgerSchema.parse(historical)).toEqual(historical);
    expect(packageNavigationLedgerSchema.parse(historical)).not.toHaveProperty("visible_members");
  });
  it("exposes canonical expectations to drift audit without certifying changed visible targets", async () => {
    const f = await fixture();
    await f.service.replacePackage(f.request, f.state, await f.admission(f.request));
    f.files.delete("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9300-packages/WORKING/CURRENT.md");
    expect((await (f.repository as any).readCanonicalPackageNavigationForAudit(f.state.project_id)).WORKING.generation).toBe(1);
    await expect(f.repository.readPackageNavigation(f.state.project_id)).rejects.toThrow("package_navigation_visible_missing");
  });
  it("uses the observed size as binary read bound without exceeding a provider's exact limit", async () => {
    const f = await fixture();
    const read = f.runtime.objects.readBytes!;
    f.runtime.objects.readBytes = async (path, max) => {
      const metadata = await f.runtime.objects.getMetadata(path);
      if (metadata && max > Math.max(1, metadata.size)) throw new Error("read bound exceeds exact provider limit");
      return read(path, max);
    };
    expect((await f.service.replacePackage(f.request, f.state, await f.admission(f.request))).status).toBe("finalized");
  });
  it("does not finalize a same-bytes member revision substitution after navigation was written", async () => {
    const f = await fixture();
    const create = f.runtime.objects.createText;
    f.runtime.objects.createText = async (path, content) => {
      await create(path, content);
      if (path.endsWith("/HANDOFF.md")) {
        const member = `/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9300-packages/WORKING/PACKAGES/${f.request.candidate.package_id}/1/a.md`;
        f.put(member, "first");
      }
    };
    expect((await f.service.replacePackage(f.request, f.state, await f.admission(f.request))).status).not.toBe("finalized");
  });
  it("never credits a copy whose provider proof identifies another source", async () => {
    const f = await fixture();
    const copy = f.runtime.serverSideCopy.copyObjectVersion!;
    f.runtime.serverSideCopy.copyObjectVersion = async (...args) => { const result = await copy(...args); return { ...result, source: { ...result.source, objectId: "id:foreign" } }; };
    expect((await f.service.replacePackage(f.request, f.state, await f.admission(f.request))).status).not.toBe("finalized");
    expect([...f.files.keys()].some(p => p.endsWith("/navigation.json"))).toBe(false);
  });
  it("revalidates visible member identity without rereading the binary payload", async () => {
    const f = await fixture();
    await f.service.replacePackage(f.request, f.state, await f.admission(f.request));
    const read = f.runtime.objects.readBytes!;
    f.runtime.objects.readBytes = async (path, max) => { if (path.endsWith("/a.md")) throw new Error("binary reread forbidden"); return read(path, max); };
    expect((await f.repository.readPackageNavigation(f.state.project_id)).WORKING?.generation).toBe(1);
  });
  it("never uses optimistic copy when exact source-version capability is unavailable", async () => {
    const f = await fixture();
    delete (f.runtime.serverSideCopy as any).copyObjectVersion;
    expect((await f.service.replacePackage(f.request, f.state, await f.admission(f.request))).status).not.toBe("finalized");
    expect(f.effects.filter((e) => e.startsWith("copy:"))).toEqual([]);
  });
  it.each(["CURRENT.md", "INDEX.md", "member"])("refuses fresh navigation when visible %s was replaced after finalization", async (target) => {
    const f = await fixture();
    await f.service.replacePackage(f.request, f.state, await f.admission(f.request));
    const base = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9300-packages/WORKING";
    const path = target === "CURRENT.md" ? `${base}/CURRENT.md` : `${base}/PACKAGES/${f.request.candidate.package_id}/1/${target === "member" ? "a.md" : target}`;
    f.put(path, "foreign contents");
    await expect(f.repository.readPackageNavigation(f.state.project_id)).rejects.toThrow("package_navigation_visible");
  });
  it.each(["same_project_file", "other_project", "forbidden_namespace"])("rejects widening a frozen package copy address: %s", async (attack) => {
    const f = await fixture();
    await f.service.replacePackage(f.request, f.state, await f.admission(f.request), { effectBudget: 1 });
    const journal = new ExecutionJournal(f.runtime, f.state.project_id, "document-package-prepare", f.request.request_id);
    const record = (await journal.readAdmission())!;
    const plan = structuredClone(record.plan!);
    const action = plan.steps[0].action;
    if (action.kind !== "copy_if_unchanged") throw new Error("fixture copy required");
    action.destination = attack === "same_project_file"
      ? { path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9300-packages/WORKING/unrelated.md", logical_path: "WORKING/unrelated.md" }
      : attack === "other_project"
        ? { path: "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9301-other/WORKING/a.md", logical_path: "WORKING/a.md" }
        : { path: "/PROJECT_OS/.project-os/registry.json", logical_path: "registry.json" };
    const effects = f.effects.length;
    await expect(journal.commit(record.admission, plan)).rejects.toThrow();
    expect(f.effects).toHaveLength(effects);
  });
  it("does not finalize STATE/HANDOFF navigation when another current zone index vanished", async () => {
    const f = await fixture();
    const published = { ...f.request, zone: "DELIVERABLES" };
    const proof: any = await f.admission(published);
    proof.results = [{ verdict: "allow", code: "EXACT_APPROVAL_VERIFIED", resource_id: published.candidate.package_id, approval_id: "APPROVAL-1", evidence_refs: ["canonical:approval"], rule: null }];
    await f.service.replacePackage(published, f.state, proof);
    f.files.delete("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9300-packages/DELIVERABLES/CURRENT.md");
    const request = { ...f.request, request_id: "DOCREQ-MISSING-NAV-0001" };
    await expect(f.service.replacePackage(request, f.state, await f.admission(request))).rejects.toThrow("package_navigation_visible_missing");
  });
  it("reads one canonical navigation ledger when absent and never caches away a later write", async () => {
    const f = await fixture();
    let reads = 0;
    const read = f.runtime.objects.readText;
    f.runtime.objects.readText = async (path) => { reads++; return read(path); };
    expect(await f.repository.readPackageNavigation(f.state.project_id)).toEqual({});
    expect(reads).toBe(1);
    await f.service.replacePackage(f.request, f.state, await f.admission(f.request));
    expect((await f.repository.readPackageNavigation(f.state.project_id)).WORKING?.generation).toBe(1);
  });
  it("publishes one current head with identical STATE/HANDOFF navigation only after every member exists", async () => {
    const f = await fixture();
    const result = await f.service.replacePackage(f.request, f.state, await f.admission(f.request));
    expect(result.status).toBe("finalized");
    const current = await (f.repository as any).readPackageNavigation(f.state.project_id);
    expect(current.WORKING.generation).toBe(1);
    expect(current.WORKING.packages).toHaveLength(1);
    const base = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9300-packages";
    const line = `- [[WORKING/CURRENT|WORKING current packages]]`;
    expect(f.files.get(`${base}/STATE.md`)?.content).toContain(line);
    expect(f.files.get(`${base}/HANDOFF.md`)?.content).toContain(line);
    expect(f.files.get(`${base}/WORKING/CURRENT.md`)?.content).toContain(`/1/INDEX|${f.request.candidate.package_id} v1`);
    expect(f.files.get(`${base}/WORKING/PACKAGES/${f.request.candidate.package_id}/1/INDEX.md`)?.content).toContain("/1/a.md");
    expect((await new ExecutionJournal(f.runtime, f.state.project_id, "document", f.request.request_id).status())?.status).toBe("finalized");
  });
  it("replacement archives under canonical ARCHIVES and only deletes the exact verified predecessor file", async () => {
    const f = await fixture();
    await f.service.replacePackage(f.request, f.state, await f.admission(f.request));
    const v2 = await f.repository.freezePackage({ ...f.manifest, version: 2, predecessor: f.request.candidate });
    const request = { ...f.request, request_id: "DOCREQ-REPLACE-0002", candidate: v2, expected_navigation_generation: 1 };
    expect((await f.service.replacePackage(request, f.state, await f.admission(request))).status).toBe("finalized");
    expect(f.effects.some((e) => e.includes("->/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9300-packages/ARCHIVES/PACKAGES/"))).toBe(true);
    expect(f.effects.filter((e) => e.startsWith("delete:")).map((e) => e.split("/").pop()).sort()).toEqual(["INDEX.md", "a.md"]);
    expect((await (f.repository as any).readPackageNavigation(f.state.project_id)).WORKING.packages[0].ref.version).toBe(2);
  });
  it("unfinished batched copies resume from canonical cursor without recopy or including unmanifested files", async () => {
    const f = await fixture();
    const first = await f.service.replacePackage(f.request, f.state, await f.admission(f.request), { effectBudget: 1 });
    expect(first.status).toBe("finalizing");
    const copyCount = f.effects.filter((e) => e.startsWith("copy:")).length;
    const base = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9300-packages";
    f.put(`${base}/WORKING/unmanifested.md`, "keep");
    const resumed: any = new ManagedDocumentService(f.runtime);
    expect((await resumed.replacePackage(f.request, f.state, await f.admission(f.request))).status).toBe("finalized");
    expect(f.effects.filter((e) => e.startsWith("copy:")).length).toBe(copyCount);
    expect(f.files.has(`${base}/WORKING/unmanifested.md`)).toBe(true);
  });
  it("same-generation replacement loses the CAS and cannot establish a second current navigation", async () => {
    const f = await fixture();
    await f.service.replacePackage(f.request, f.state, await f.admission(f.request));
    const request = { ...f.request, request_id: "DOCREQ-CONCURRENT-0002" };
    await expect(f.service.replacePackage(request, f.state, await f.admission(request))).rejects.toThrow("package_navigation_conflict");
    expect((await (f.repository as any).readPackageNavigation(f.state.project_id)).WORKING.generation).toBe(1);
  });
  it("stale exact-version admission cannot approve a successor; published version coexists with working successor", async () => {
    const f = await fixture();
    const published = { ...f.request, zone: "DELIVERABLES" };
    const proof: any = await f.admission(published);
    proof.results = [{ verdict: "allow", code: "EXACT_APPROVAL_VERIFIED", resource_id: published.candidate.package_id, approval_id: "APPROVAL-1", evidence_refs: ["canonical:approval"], rule: null }];
    await f.service.replacePackage(published, f.state, proof);
    const v2 = await f.repository.freezePackage({ ...f.manifest, version: 2, predecessor: f.request.candidate });
    const successor = { ...f.request, request_id: "DOCREQ-SUCCESSOR-0002", candidate: v2 };
    await expect(f.service.replacePackage(successor, f.state, proof)).rejects.toThrow("package_admission_binding");
    await f.service.replacePackage(successor, f.state, await f.admission(successor));
    const nav = await (f.repository as any).readPackageNavigation(f.state.project_id);
    expect(nav.DELIVERABLES.packages[0].ref.version).toBe(1);
    expect(nav.WORKING.packages[0].ref.version).toBe(2);
  });
  it("missing member prevents finalization and terminal current publication", async () => {
    const f = await fixture();
    f.files.delete(f.manifest.members[0].immutable_payload_path);
    await expect(f.service.replacePackage(f.request, f.state, await f.admission(f.request))).rejects.toThrow();
    expect(f.effects.filter((e) => e.startsWith("copy:") || e.startsWith("delete:"))).toEqual([]);
  });
  it("archives the obsolete generated package index instead of leaving an active index with broken links", async () => {
    const f = await fixture();
    await f.service.replacePackage(f.request, f.state, await f.admission(f.request));
    const v2 = await f.repository.freezePackage({ ...f.manifest, version: 2, predecessor: f.request.candidate });
    const request = { ...f.request, request_id: "DOCREQ-INDEX-0002", candidate: v2, expected_navigation_generation: 1 };
    await f.service.replacePackage(request, f.state, await f.admission(request));
    const base = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9300-packages";
    expect(f.files.has(`${base}/WORKING/PACKAGES/${v2.package_id}/1/INDEX.md`)).toBe(false);
    expect(f.files.has(`${base}/ARCHIVES/PACKAGES/${v2.package_id}/1/WORKING/INDEX.md`)).toBe(true);
  });
  it("source mutation immediately before conditional deletion preserves new bytes and prevents finalization", async () => {
    const f = await fixture();
    await f.service.replacePackage(f.request, f.state, await f.admission(f.request));
    const v2 = await f.repository.freezePackage({ ...f.manifest, version: 2, predecessor: f.request.candidate });
    const request = { ...f.request, request_id: "DOCREQ-CHANGED-0002", candidate: v2, expected_navigation_generation: 1 };
    const remove = f.runtime.objects.deleteIfUnchanged!;
    let changedPath = "";
    f.runtime.objects.deleteIfUnchanged = async (path, expected) => { changedPath = path; f.put(path, "external edit"); return remove(path, expected); };
    expect((await f.service.replacePackage(request, f.state, await f.admission(request))).status).toBe("conflict");
    expect(f.files.get(changedPath)?.content).toBe("external edit");
    expect(f.effects.filter((e) => e.startsWith("delete:"))).toEqual([]);
  });
  it("does not finalize or issue a delete receipt when a third party removes the source before our conditional delete", async () => {
    const f = await fixture();
    await f.service.replacePackage(f.request, f.state, await f.admission(f.request));
    const v2 = await f.repository.freezePackage({ ...f.manifest, version: 2, predecessor: f.request.candidate });
    const request = { ...f.request, request_id: "DOCREQ-MISSING-DELETE-0002", candidate: v2, expected_navigation_generation: 1 };
    const remove = f.runtime.objects.deleteIfUnchanged!;
    f.runtime.objects.deleteIfUnchanged = async (path, expected) => {
      f.files.delete(path);
      return remove(path, expected);
    };

    const result = await f.service.replacePackage(request, f.state, await f.admission(request));
    const journal = new ExecutionJournal(f.runtime, f.state.project_id, "document", request.request_id);

    expect(result.status).not.toBe("finalized");
    expect((await journal.status())?.status).not.toBe("finalized");
    expect([...f.files.keys()].filter((path) => path.includes(`/execution/${f.state.project_id}/document/${request.request_id}/effects/`))).toHaveLength(0);
  });
  it("member loss after copies and before postcheck cannot establish a verified current head", async () => {
    const f = await fixture();
    const create = f.runtime.objects.createText;
    f.runtime.objects.createText = async (path, content) => { await create(path, content); if (path.endsWith("/HANDOFF.md")) f.files.delete(`/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9300-packages/WORKING/PACKAGES/${f.request.candidate.package_id}/1/a.md`); };
    expect((await f.service.replacePackage(f.request, f.state, await f.admission(f.request))).status).toBe("conflict");
    await expect((f.repository as any).readPackageNavigation(f.state.project_id)).rejects.toThrow("package_navigation_unfinalized");
  });
  it("three-member package resumes two interrupted slices from persisted verified steps", async () => {
    const f = await fixture(3);
    expect((await f.service.replacePackage(f.request, f.state, await f.admission(f.request), { effectBudget: 1 })).status).toBe("finalizing");
    expect(f.effects.filter((e) => e.startsWith("copy:"))).toHaveLength(1);
    const cold: any = new ManagedDocumentService(f.runtime);
    expect((await cold.replacePackage(f.request, f.state, await f.admission(f.request), { effectBudget: 1 })).status).toBe("finalizing");
    expect(f.effects.filter((e) => e.startsWith("copy:"))).toHaveLength(2);
    expect((await cold.replacePackage(f.request, f.state, await f.admission(f.request))).status).toBe("finalized");
    expect(f.effects.filter((e) => e.startsWith("copy:"))).toHaveLength(3);
  });
  it("phase two independently verifies the immutable phase-one finalization proof", async () => {
    const f = await fixture();
    const prepared = await f.service.replacePackage(f.request, f.state, await f.admission(f.request), { effectBudget: 1 });
    f.put(prepared.finalization_ref, "{}");
    await expect(f.service.replacePackage(f.request, f.state, await f.admission(f.request))).rejects.toThrow("package_execution_unproven");
    expect(f.effects.some((e) => e.endsWith("/CURRENT.md"))).toBe(false);
  });
  it("prepared navigation cannot erase a different zone finalized by another request", async () => {
    const f = await fixture();
    await f.service.replacePackage(f.request, f.state, await f.admission(f.request), { effectBudget: 1 });
    const review = { ...f.request, request_id: "DOCREQ-OTHERZONE-0002", zone: "REVIEW" };
    const proof: any = await f.admission(review);
    proof.results = [{ verdict: "allow", code: "EXACT_APPROVAL_VERIFIED", resource_id: review.candidate.package_id, approval_id: "APP-OTHERZONE", evidence_refs: ["canonical:approval"], rule: null }];
    await f.service.replacePackage(review, f.state, proof);
    await expect(f.service.replacePackage(f.request, f.state, await f.admission(f.request))).rejects.toThrow("package_navigation_conflict");
    expect(f.files.get("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9300-packages/STATE.md")?.content).toContain("[[REVIEW/CURRENT");
  });
  it("canonical exact deferred RuleVersion resolves to verified package postchecks", async () => {
    const f = await fixture();
    const rule: any = ruleFixture(f.state.project_id, { operations: ["package.replace"], resource_scope: { resource_types: ["package"], zones: ["WORKING"] }, check_id: "verified_presence", parameters: {}, check_stage: "post_execution", status: "active", activation_evidence: ["server:qualified"] });
    const proof: any = await f.admission(f.request);
    const ref = { rule_id: rule.rule_id, version: rule.version, scope: rule.scope };
    proof.deferred_rules = [ref]; proof.ruleset.rules = [ref];
    const result = await f.service.replacePackage(f.request, f.state, proof, { postcheckRules: [rule] });
    expect(result.status).toBe("finalized");
    expect(result.postchecks).toContainEqual({ check_id: `rule:${canonicalJson(ref)}`, verdict: "allow", evidence_refs: expect.arrayContaining([expect.stringContaining("/observations/")]) });
  });
  it("canonical package projections retain their DOC/VER membership instead of becoming independent working heads", async () => {
    const f = await fixture();
    await f.service.replacePackage(f.request, f.state, await f.admission(f.request));
    const path = `/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9300-packages/WORKING/PACKAGES/${f.request.candidate.package_id}/1/a.md`;
    const reconciler = new StableWorkProductReconciler(f.runtime);
    expect(await reconciler.reconcile(f.state, { kind: "file", name: "a.md", path })).toMatchObject({ handled: true, captured: 0, restored: 0 });
    f.files.delete(path);
    expect(await reconciler.reconcile(f.state, { kind: "deleted", name: "a.md", path })).toMatchObject({ handled: true, restored: 0 });
    expect(await f.repository.listHeadIds(f.state.project_id)).toEqual([]);
  });
  it("first package cannot overwrite an unrelated preexisting CURRENT index", async () => {
    const f = await fixture();
    const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9300-packages/WORKING/CURRENT.md";
    f.put(path, "unrelated existing navigation");
    await expect(f.service.replacePackage(f.request, f.state, await f.admission(f.request))).rejects.toThrow("package_destination_collision");
    expect(f.files.get(path)?.content).toBe("unrelated existing navigation");
  });
  it("freezes a referenced manifest document only inside the exact bound project", async () => {
    const f = await fixture();
    const value = { ...f.manifest, project_id: "PRJ-9301" };
    const content = canonicalJson(value), content_sha256 = await sha256Text(content);
    const path = await f.repository.storeTextPayload(f.state.project_id, content_sha256, content);
    const document_id = `DOC-${"3".repeat(24)}`, version_id = `VER-REQ-${"3".repeat(24)}`;
    await f.repository.writeVersion({ schema_version: "1.0", project_id: f.state.project_id, document_id, version_id, kind: "work_product", stage: "working", logical_path: "manifest.json", source: "project_os", created_at: f.manifest.created_at, immutable_payload_path: path, content_sha256 });
    const request = { operation: "package.freeze", request_id: "DOCREQ-FREEZE-0001", project_id: f.state.project_id, document_id, expected_version_id: version_id, content_sha256, expected_project_revision: 0, created_at: f.manifest.created_at };
    await expect(f.service.freezePackageDocument(request, f.state)).rejects.toThrow("package_manifest_document_binding");
    expect([...f.files.keys()].some((p) => p.includes("/PRJ-9301/"))).toBe(false);
  });
});
