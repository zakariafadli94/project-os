import { describe, expect, it } from "vitest";
import { PackageExternalDriftObserver } from "../src/documents/external-drift";
import { ManagedDocumentChangeCoordinator } from "../src/documents/change-coordinator";
import { DocumentLedgerRepository } from "../src/documents/repository";
import { ManagedDocumentService } from "../src/documents/service";
import { emptyProjectState } from "../src/domain/transitions";
import { sha256Text } from "../src/documents/hash";
import { canonicalJson } from "../src/rules/contract";
import { ExecutionJournal, executionHash } from "../src/execution/journal";
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
    const coordinator = new ManagedDocumentChangeCoordinator(f.runtime, {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value); },
      delete: async (key: string) => values.delete(key)
    }, "observe", async (_state, operation) => { observed.push(operation); });

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
  });
});
