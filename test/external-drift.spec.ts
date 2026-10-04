import { describe, expect, it } from "vitest";
import { PackageExternalDriftObserver } from "../src/documents/external-drift";
import { ManagedDocumentChangeCoordinator } from "../src/documents/change-coordinator";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ManagedDocumentService } from "../src/documents/service";
import { emptyProjectState } from "../src/domain/transitions";
import { sha256Text } from "../src/documents/hash";
import { canonicalJson } from "../src/rules/contract";
import { ExecutionJournal, executionHash } from "../src/execution/journal";
import { packageManifestPath } from "../src/domain/document-package";
import { packageRuntime } from "./helpers/package-runtime";

async function fixture(withSecondPackage = false) {
  const store = packageRuntime();
  const repository = new DocumentLedgerRepository(store.runtime);
  const state = emptyProjectState("PRJ-9320", "External drift", "external-drift");
  const content = "first", content_sha256 = await sha256Text(content);
  const immutable_payload_path = await repository.storeTextPayload(state.project_id, content_sha256, content);
  const document_id = `DOC-${"1".repeat(24)}`, document_version_id = `VER-REQ-${"1".repeat(24)}`;
  await repository.writeVersion({ schema_version: "1.0", project_id: state.project_id, document_id, version_id: document_version_id, kind: "work_product", stage: "working", logical_path: "a.md", source: "project_os", created_at: "2026-09-12T12:00:00Z", immutable_payload_path, content_sha256, size: content.length });
  const manifest = { schema_version: "1.0" as const, project_id: state.project_id, creation_request_id: "DOCREQ-DRIFT-PACKAGE-0001", version: 1, members: [{ relative_path: "a.md", document_id, document_version_id, immutable_payload_path, content_sha256, size: content.length }], links: [], source_refs: ["accepted:package"], created_by: "operator", created_at: "2026-09-12T12:00:00Z" };
  const v1 = await repository.freezePackage(manifest);
  const request = (candidate: typeof v1, request_id: string, expected_navigation_generation: number) => ({ operation: "package.replace" as const, request_id, project_id: state.project_id, candidate, zone: "WORKING" as const, expected_navigation_generation, expected_project_revision: 0, created_at: "2026-09-12T12:00:00Z" });
  const admission = async (value: ReturnType<typeof request>) => ({ project_id: state.project_id, operation: "package.replace", kind: "document", request_id: value.request_id, request_hash: await sha256Text(canonicalJson(value)), actor: { actor_id: "operator", authority: "ingress" }, resources: [{ resource_id: value.candidate.package_id, resource_type: "package", zone: value.zone, version: `${value.candidate.version}:${value.candidate.manifest_sha256}` }], global_revision: 0, project_revision: 0, ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: 0 }, verdict: "allow" as const, results: [], gaps: [], deferred_rules: [] });
  const service = new ManagedDocumentService(store.runtime);
  const first = request(v1, "DOCREQ-DRIFT-REPLACE-0001", 0);
  await service.replacePackage(first, state, await admission(first));
  const v2 = await repository.freezePackage({ ...manifest, version: 2, predecessor: v1 });
  const second = request(v2, "DOCREQ-DRIFT-REPLACE-0002", 1);
  await service.replacePackage(second, state, await admission(second));
  let other: typeof v1 | undefined;
  if (withSecondPackage) {
    other = await repository.freezePackage({ ...manifest, creation_request_id: "DOCREQ-DRIFT-PACKAGE-0002", version: 1 });
    const third = request(other, "DOCREQ-DRIFT-REPLACE-0003", 2);
    await service.replacePackage(third, state, await admission(third));
  }
  const base = `/PROJECT_OS/WORKSPACE/PROJECTS/${state.project_id}-external-drift`;
  return { ...store, state, v1, v2, other, base };
}

describe("package external drift", () => {
  it("binds an observed predecessor deletion to the finalized expected package effect", async () => {
    const f = await fixture();
    const path = `${f.base}/WORKING/PACKAGES/${f.v1.package_id}/1/a.md`;

    const result = await new PackageExternalDriftObserver(f.runtime).observe(f.state, {
      kind: "deleted", name: "a.md", path
    });

    expect(result).toMatchObject({ handled: true, status: "expected_reconciled", code: "PACKAGE_EXPECTED_DELETE" });
    expect(result.resource).toMatchObject({ resource_id: f.v2.package_id, resource_type: "package", zone: "WORKING" });
  });

  it("uses finalized ledger refs for audit without reading package manifests, while normal reads still verify them", async () => {
    const f = await fixture();
    f.files.delete(packageManifestPath(f.v2));

    const audit = await new DocumentLedgerRepository(f.runtime).readCanonicalPackageNavigationForAudit(f.state.project_id);

    expect(audit.WORKING?.packages).toEqual([expect.objectContaining({ ref: f.v2 })]);
    await expect(new DocumentLedgerRepository(f.runtime).readPackageNavigation(f.state.project_id)).rejects.toThrow("package_manifest_binding");
  });

  it("reconstructs a frozen package resource snapshot from its finalized writer after canonical heads advance", async () => {
    const f = await fixture();
    const repository = new DocumentLedgerRepository(f.runtime);
    const snapshot = await repository.readPackageNavigationSnapshotForAudit(f.state.project_id, "DOCREQ-DRIFT-REPLACE-0002");
    const v3 = await repository.freezePackage({
      schema_version: "1.0", project_id: f.state.project_id,
      creation_request_id: "DOCREQ-DRIFT-PACKAGE-0001", version: 3, predecessor: f.v2,
      members: [{ relative_path: "a.md", document_id: `DOC-${"1".repeat(24)}`, document_version_id: `VER-REQ-${"1".repeat(24)}`, immutable_payload_path: await repository.storeTextPayload(f.state.project_id, await sha256Text("first"), "first"), content_sha256: await sha256Text("first"), size: 5 }],
      links: [], source_refs: ["accepted:package"], created_by: "operator", created_at: "2026-09-12T12:00:00Z"
    });
    const request = { operation: "package.replace" as const, request_id: "DOCREQ-DRIFT-REPLACE-0003", project_id: f.state.project_id, candidate: v3, zone: "WORKING" as const, expected_navigation_generation: 2, expected_project_revision: 0, created_at: "2026-09-12T12:00:00Z" };
    const admission = { project_id: f.state.project_id, operation: "package.replace", kind: "document", request_id: request.request_id, request_hash: await sha256Text(canonicalJson(request)), actor: { actor_id: "operator", authority: "ingress" }, resources: [{ resource_id: v3.package_id, resource_type: "package", zone: "WORKING", version: `${v3.version}:${v3.manifest_sha256}` }], global_revision: 0, project_revision: 0, ruleset: { digest: "a".repeat(64), rules: [], global_revision: 0, project_revision: 0 }, verdict: "allow" as const, results: [], gaps: [], deferred_rules: [] };
    await new ManagedDocumentService(f.runtime).replacePackage(request, f.state, admission);

    const pinned = await repository.readPackageNavigationSnapshotForAudit(f.state.project_id, snapshot.request_id);
    expect(pinned.navigation.WORKING?.packages.map((entry) => entry.ref.version)).toEqual([2]);
    expect((await repository.readCanonicalPackageNavigationForAudit(f.state.project_id)).WORKING?.packages.map((entry) => entry.ref.version)).toEqual([3]);
  });

  it("does not recognize a deletion from a finalized path alone when the prepared exact copy intent is absent", async () => {
    const f = await fixture();
    const path = `${f.base}/WORKING/PACKAGES/${f.v1.package_id}/1/a.md`;
    const prepare = new ExecutionJournal(f.runtime, f.state.project_id, "document-package-prepare", "DOCREQ-DRIFT-REPLACE-0002");
    f.files.delete(`${await prepare.root()}/admission.json`);

    const result = await new PackageExternalDriftObserver(f.runtime).observe(f.state, {
      kind: "deleted", name: "a.md", path
    });

    expect(result).toMatchObject({ handled: true, status: "unexpected_conflict" });
  });

  it("does not credit a disappearance without the exact immutable final delete receipt", async () => {
    const f = await fixture();
    const path = `${f.base}/WORKING/PACKAGES/${f.v1.package_id}/1/a.md`;
    const journal = new ExecutionJournal(f.runtime, f.state.project_id, "document", "DOCREQ-DRIFT-REPLACE-0002");
    const plan = (await journal.readAdmission())?.plan;
    const removal = plan?.steps.find((step) => step.action.kind === "delete_if_unchanged" && step.action.source.path === path);
    if (!removal) throw new Error("fixture delete step missing");
    const receiptPath = `${await journal.root()}/effects/${await executionHash(removal)}.json`;
    f.files.delete(receiptPath);

    const result = await new PackageExternalDriftObserver(f.runtime).observe(f.state, {
      kind: "deleted", name: "a.md", path
    });

    expect(result).toMatchObject({ handled: true, status: "unexpected_conflict", code: "PACKAGE_UNEXPECTED_DISAPPEARANCE" });
  });

  it("verifies copied bytes as SHA-256 without equating them to the Dropbox content hash", async () => {
    const f = await fixture();
    const path = `${f.base}/WORKING/PACKAGES/${f.v2.package_id}/2/a.md`;
    const metadata = await f.runtime.objects.getMetadata(path);
    if (!metadata) throw new Error("fixture metadata missing");

    const result = await new PackageExternalDriftObserver(f.runtime).observe(f.state, {
      kind: "file", name: "a.md", path,
      metadata: { ...metadata, integrityHash: { algorithm: "dropbox-content-hash", value: "provider-specific-not-sha256" } }
    });

    expect(result).toMatchObject({ handled: true, status: "expected_reconciled", code: "PACKAGE_EXPECTED_WRITE" });
  });

  it("attributes an unexpected member change to the package encoded by its exact path, not another head", async () => {
    const f = await fixture(true);
    const path = `${f.base}/WORKING/PACKAGES/${f.v2.package_id}/2/a.md`;
    const metadata = await f.runtime.objects.getMetadata(path);
    if (!metadata || !f.other) throw new Error("fixture package missing");

    const result = await new PackageExternalDriftObserver(f.runtime).observe(f.state, {
      kind: "file", name: "a.md", path,
      metadata: { ...metadata, revisionToken: "external-revision" }
    });

    expect(result).toMatchObject({ handled: true, status: "unexpected_conflict" });
    expect(result.resource).toMatchObject({
      resource_id: f.v2.package_id,
      resource_type: "package",
      version: `2:${f.v2.manifest_sha256}`
    });
    expect(result.resource?.resource_id).not.toBe(f.other.package_id);
  });

  it("marks a current package disappearance as conflict without restoring obsolete bytes", async () => {
    const f = await fixture();
    const path = `${f.base}/WORKING/PACKAGES/${f.v2.package_id}/2/a.md`;
    const effects = f.effects.length;
    f.files.delete(path);

    const result = await new PackageExternalDriftObserver(f.runtime).observe(f.state, {
      kind: "deleted", name: "a.md", path
    });

    expect(result).toMatchObject({ handled: true, status: "unexpected_conflict", code: "PACKAGE_UNEXPECTED_DISAPPEARANCE" });
    expect(f.effects).toHaveLength(effects);
    expect(f.files.has(path)).toBe(false);
  });

  it("recognizes a CURRENT index feed event only while the latest finalized write still matches physical bytes", async () => {
    const f = await fixture();
    const path = `${f.base}/WORKING/CURRENT.md`;
    const metadata = await f.runtime.objects.getMetadata(path);
    if (!metadata) throw new Error("fixture CURRENT index missing");

    const result = await new PackageExternalDriftObserver(f.runtime).observe(f.state, {
      kind: "file", name: "CURRENT.md", path, metadata
    });

    expect(result).toMatchObject({
      handled: true,
      status: "expected_reconciled",
      code: "PACKAGE_EXPECTED_WRITE",
      request_id: "DOCREQ-DRIFT-REPLACE-0002",
      resource: {
        resource_id: f.v2.package_id,
        resource_type: "package",
        zone: "WORKING",
        version: `2:${f.v2.manifest_sha256}`
      }
    });

    f.put(path, "# externally changed current index\n");
    const staleEvent = await new PackageExternalDriftObserver(f.runtime).observe(f.state, {
      kind: "file", name: "CURRENT.md", path, metadata
    });
    expect(staleEvent).toMatchObject({
      handled: true,
      status: "unexpected_conflict",
      code: "PACKAGE_UNEXPECTED_MUTATION",
      resources: [{ resource_id: f.v2.package_id, zone: "WORKING" }]
    });

    const canonicalIndex = `# ${f.v2.package_id} v${f.v2.version}\n\n- [[WORKING/PACKAGES/${f.v2.package_id}/${f.v2.version}/a.md]]\n`;
    f.put(path, canonicalIndex);
    const resumed = await new PackageExternalDriftObserver(f.runtime).observe(f.state, {
      kind: "file", name: "CURRENT.md", path, metadata
    }, staleEvent.snapshot_request_id);
    expect(resumed).toMatchObject({
      handled: true,
      status: "unexpected_conflict",
      code: "PACKAGE_UNEXPECTED_MUTATION",
      snapshot_request_id: staleEvent.snapshot_request_id,
      resources: [{ resource_id: f.v2.package_id, zone: "WORKING" }]
    });
  });

  it("attributes external CURRENT index changes to every current package in that zone", async () => {
    const f = await fixture(true);
    const other = f.other;
    if (!other) throw new Error("fixture second package missing");
    const path = `${f.base}/WORKING/CURRENT.md`;
    f.put(path, "# externally changed current index\n");
    const metadata = await f.runtime.objects.getMetadata(path);
    if (!metadata) throw new Error("fixture CURRENT index missing");

    const result = await new PackageExternalDriftObserver(f.runtime).observe(f.state, {
      kind: "file", name: "CURRENT.md", path, metadata
    });

    expect(result).toMatchObject({ handled: true, status: "unexpected_conflict", code: "PACKAGE_UNEXPECTED_MUTATION" });
    expect(result.resource).toBeUndefined();
    expect(result.resources).toHaveLength(2);
    expect(result.resources).toEqual(expect.arrayContaining([
      { resource_id: f.v2.package_id, resource_type: "package", zone: "WORKING", version: `2:${f.v2.manifest_sha256}` },
      { resource_id: other.package_id, resource_type: "package", zone: "WORKING", version: `1:${other.manifest_sha256}` }
    ]));
  });

  it.each(["oversize", "unreadable", "unstable"] as const)("fails closed on an %s package navigation ledger during CURRENT drift audit", async (fault) => {
    const f = await fixture();
    const ledgerPath = `/PROJECT_OS/.project-os/projects/${f.state.project_id}/documents/packages/navigation.json`;
    let ledgerTextReads = 0;
    if (fault === "oversize") {
      const ledger = f.files.get(ledgerPath)?.content;
      if (!ledger) throw new Error("fixture package navigation ledger missing");
      f.put(ledgerPath, `${ledger}${" ".repeat(128_001)}`);
      const readText = f.runtime.objects.readText;
      f.runtime.objects.readText = async (path) => {
        if (path === ledgerPath) ledgerTextReads += 1;
        return readText(path);
      };
    } else if (fault === "unreadable") {
      delete (f.runtime.objects as any).readBytes;
    } else {
      const readBytes = f.runtime.objects.readBytes!;
      f.runtime.objects.readBytes = async (path, limit) => {
        const bytes = await readBytes(path, limit);
        if (path === ledgerPath) {
          const current = f.files.get(path)?.content;
          if (current) f.put(path, current);
        }
        return bytes;
      };
    }
    const currentPath = `${f.base}/WORKING/CURRENT.md`;

    const result = await new PackageExternalDriftObserver(f.runtime).observe(f.state, {
      kind: "file", name: "CURRENT.md", path: currentPath
    });

    expect(result).toMatchObject({
      handled: true,
      status: "unexpected_conflict",
      code: "PACKAGE_NAVIGATION_UNAVAILABLE"
    });
    if (fault === "oversize") expect(ledgerTextReads).toBe(0);
  });

  it.each([
    ["version directory", (f: Awaited<ReturnType<typeof fixture>>) => `${f.base}/WORKING/PACKAGES/${f.v2.package_id}/2`],
    ["package-id directory", (f: Awaited<ReturnType<typeof fixture>>) => `${f.base}/WORKING/PACKAGES/${f.v2.package_id}`]
  ])("attributes deletion of the current package %s without restoring removed bytes", async (_label, pathFor) => {
    const f = await fixture();
    const path = pathFor(f);
    const memberPath = `${f.base}/WORKING/PACKAGES/${f.v2.package_id}/2/a.md`;
    f.files.delete(memberPath);
    const effects = f.effects.length;

    const result = await new PackageExternalDriftObserver(f.runtime).observe(f.state, {
      kind: "deleted", name: path.slice(path.lastIndexOf("/") + 1), path
    });

    expect(result).toMatchObject({
      handled: true,
      status: "unexpected_conflict",
      code: "PACKAGE_UNEXPECTED_DISAPPEARANCE",
      resource: {
        resource_id: f.v2.package_id,
        resource_type: "package",
        zone: "WORKING",
        version: `2:${f.v2.manifest_sha256}`
      }
    });
    expect(f.effects).toHaveLength(effects);
    expect(f.files.has(memberPath)).toBe(false);
  });

  it("records package disappearance as reconciliation conflict instead of letting the legacy restorer ignore it", async () => {
    const f = await fixture();
    const path = `${f.base}/WORKING/PACKAGES/${f.v2.package_id}/2/a.md`;
    f.files.delete(path);
    f.runtime.changeFeed = {
      listChanges: async () => ({
        entries: [{ kind: "deleted", name: "a.md", path }],
        cursor: "drift-cursor-1"
      })
    };
    const values = new Map<string, unknown>();
    const coordinator = new ManagedDocumentChangeCoordinator(f.runtime, {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value); },
      delete: async (key: string) => values.delete(key)
    });

    const summary = await coordinator.reconcile(f.state);

    expect(summary.conflicts).toBe(1);
    expect(summary.restored).toBe(0);
    expect(f.files.has(path)).toBe(false);
  });

  it("binds an observed package effect to its exact admitted resource before recording it", async () => {
    const f = await fixture();
    const path = `${f.base}/WORKING/PACKAGES/${f.v1.package_id}/1/a.md`;
    f.runtime.changeFeed = {
      listChanges: async () => ({
        entries: [{ kind: "deleted", name: "a.md", path }],
        cursor: "drift-cursor-admission-1"
      })
    };
    const values = new Map<string, unknown>();
    const observed: unknown[] = [];
    const invalidations: unknown[] = [];
    const scopedRuntimes: unknown[] = [];
    const coordinator = new ManagedDocumentChangeCoordinator(f.runtime, {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value); },
      delete: async (key: string) => values.delete(key)
    }, "observe", async (_state, operation) => { observed.push(operation); }, async (projectId, zone, resourceId, scopedRuntime) => {
      invalidations.push([projectId, zone, resourceId]);
      scopedRuntimes.push(scopedRuntime);
    });

    const summary = await coordinator.reconcile(f.state);

    expect(summary.expected_changes).toBe(1);
    expect(observed).toEqual([expect.objectContaining({
      project_id: f.state.project_id,
      operation: "package.drift.observe",
      resources: [expect.objectContaining({
        resource_id: f.v2.package_id,
        resource_type: "package",
        zone: "WORKING",
        version: `2:${f.v2.manifest_sha256}`
      })]
    })]);
    expect(invalidations).toEqual([[f.state.project_id, "WORKING", `package:${f.v2.package_id}`]]);
    expect(scopedRuntimes).toHaveLength(1);
    expect(scopedRuntimes[0]).toBe(f.runtime);
  });
});
