import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionJournal, executionHash } from "../src/execution/journal";
import { inspectStepObservation } from "../src/execution/effects";
import { ExecutionCoordinator } from "../src/execution/coordinator";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";
import { installDropboxMock } from "./helpers/mock-dropbox";
const hash = "a".repeat(64);
const address = (logical_path: string) => ({ path: `/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9258-test/${logical_path}`, logical_path });
const identity = { object_id: "object-1", revision_token: "rev-1", content_sha256: hash };
const source = { ...address("ARTIFACTS/source.md"), expected: identity };
const destination = address("ARCHIVES/source.md");
const copy: any = { step_id: "copy", resource_id: "artifact-1", expected_version: hash, provider_id: "dropbox", action: { kind: "copy_if_unchanged", source, destination, expected_destination: { state: "absent" }, desired: { content_sha256: hash } } };
const present = (location: ReturnType<typeof address>, value = identity) => ({ ...location, state: "present", identity: value });
const absent = (location: ReturnType<typeof address>) => ({ ...location, state: "absent" });
afterEach(() => vi.restoreAllMocks());
function setup() {
  installDropboxMock();
  const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
  const journal = new ExecutionJournal(runtime, "PRJ-9258", "artifact", "REQ-EFFECTS-001");
  const admission: any = { project_id: "PRJ-9258", operation: "artifact.write", request_id: "REQ-EFFECTS-001", kind: "artifact", request_hash: hash, actor: { actor_id: "verified", authority: "ingress" }, global_revision: 1, project_revision: 2, ruleset: { digest: hash, rules: [], global_revision: 1, project_revision: 2 }, verdict: "allow", results: [], gaps: [], deferred_rules: [], resources: [{ resource_id: "artifact-1", resource_type: "artifact", zone: "ARTIFACTS", version: hash }] };
  admission.resource_effect_scopes = [{ resource_id: "artifact-1", resource_version: hash, provider_id: "dropbox", sources: [address("ARTIFACTS/source.md")], destinations: [destination, address("ARTIFACTS/written.md")], preservation_copies: [destination] }];
  const plan = { steps: [structuredClone(copy)], target_revision: 2, postchecks: ["destination_verified"] };
  return { runtime, journal, admission, plan, coordinator: new ExecutionCoordinator(journal) };
}
describe("frozen conditional effect identity", () => {
  it.each(["write_destination", "copy_source", "copy_destination", "delete_source", "delete_preservation"])("cannot use an admitted resource to affect another same-project file: %s", async (target) => {
    const { journal, admission, plan } = setup();
    const other = address("ARTIFACTS/another-resource.md");
    if (target === "write_destination") plan.steps[0].action = { kind: "write_if_unchanged", destination: other, expected_destination: { state: "absent" }, desired: { content_sha256: hash, content_ref: `sha256:${hash}` } };
    if (target === "copy_source") plan.steps[0].action.source = { ...other, expected: identity };
    if (target === "copy_destination") plan.steps[0].action.destination = other;
    if (target.startsWith("delete")) plan.steps[0].action = { kind: "delete_if_unchanged", source: target === "delete_source" ? { ...other, expected: identity } : source, verified_copy: { ...(target === "delete_preservation" ? other : destination), expected: identity } };
    await expect(journal.commit(admission, plan)).rejects.toThrow("execution_resource_scope_conflict");
    expect(await journal.status()).toBeNull();
  });
  it("cannot borrow another admitted resource's same-project destination", async () => {
    const { journal, admission, plan } = setup();
    const other = address("ARCHIVES/another-resource.md");
    admission.resources.push({ ...admission.resources[0], resource_id: "artifact-2" });
    admission.resource_effect_scopes.push({ ...admission.resource_effect_scopes[0], resource_id: "artifact-2", destinations: [other] });
    plan.steps[0].action.destination = other;
    await expect(journal.commit(admission, plan)).rejects.toThrow("execution_resource_scope_conflict");
  });
  it("a resource with no exact path scope cannot authorize a common effect plan", async () => {
    const { journal, admission, plan } = setup();
    delete admission.resource_effect_scopes;
    await expect(journal.commit(admission, plan)).rejects.toThrow("execution_resource_scope_unavailable");
  });
  it("same request replay cannot widen the admitted resource address scope", async () => {
    const { journal, admission, plan } = setup();
    await journal.commit(admission, plan);
    const widened = structuredClone(admission);
    widened.resource_effect_scopes[0].destinations.push(address("ARCHIVES/another-resource.md"));
    await expect(journal.commit(widened, plan)).rejects.toThrow("execution_identity_conflict");
  });
  it("cold resume validates persisted paths against the admitted resource before calling an adapter", async () => {
    const { runtime, journal, admission, plan, coordinator } = setup();
    await journal.commit(admission, plan);
    const root = await journal.root();
    const record = JSON.parse((await runtime.objects.readText(`${root}/admission.json`))!);
    record.plan.steps[0].action.destination = address("ARCHIVES/another-resource.md");
    record.effect_plan_hash = await executionHash(record.plan);
    const progress = JSON.parse((await runtime.objects.readText(`${root}/progress.json`))!);
    progress.effect_plan_hash = record.effect_plan_hash;
    await runtime.objects.upsertText(`${root}/admission.json`, JSON.stringify(record));
    await runtime.objects.upsertText(`${root}/progress.json`, JSON.stringify(progress));
    const adapter: any = { verify: vi.fn(), execute: vi.fn() };
    await expect(coordinator.resume(record.plan, adapter)).rejects.toThrow("execution_resource_scope_conflict");
    expect(adapter.verify).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });
  it("an otherwise matching physical observation cannot validate an address outside the exact resource scope", () => {
    const { admission, plan } = setup();
    const other = address("ARCHIVES/another-resource.md");
    plan.steps[0].action.destination = other;
    const observed = { status: "verified", observed: { destination: present(other) }, evidence_refs: ["provider:other-resource"] };
    expect(inspectStepObservation(plan.steps[0], observed, admission)).toBe("unavailable");
  });
  it.each(["destination", "source", "desired", "expected_destination"])("rejects an effect without its complete %s", async (key) => {
    const { journal, admission, plan } = setup();
    delete plan.steps[0].action[key];
    await expect(journal.commit(admission, plan)).rejects.toThrow("execution_plan_invalid");
  });
  it("rejects untyped actions, extra authority fields and unconstrained provider versions", async () => {
    const { journal, admission, plan } = setup();
    for (const action of ["copy", { ...copy.action, bypass: true }, { ...copy.action, source: { ...source, expected: { ...identity, revision_token: "" } } }]) {
      await expect(journal.commit(admission, { ...plan, steps: [{ ...copy, action }] })).rejects.toThrow("execution_plan_invalid");
    }
  });
  it("rejects opaque verified assertions with no matching physical observation", async () => {
    const { journal, admission, plan, coordinator } = setup();
    await journal.commit(admission, plan);
    const adapter: any = { verify: async () => ({ status: "verified", evidence_refs: ["opaque"] }), execute: vi.fn(), postcheck: async () => ({ verdict: "allow", evidence_refs: ["opaque"] }) };
    expect((await coordinator.resume(plan, adapter)).status).not.toBe("finalized");
    expect(adapter.execute).not.toHaveBeenCalled();
  });
  it.each(["path", "hash", "source_version"])("refuses %s mismatch before a copy effect", async (mismatch) => {
    const { journal, admission, plan, coordinator } = setup();
    await journal.commit(admission, plan);
    const observation: any = { source: present(address("ARTIFACTS/source.md")), destination: absent(destination) };
    if (mismatch === "path") observation.destination.path = address("ARCHIVES/other.md").path;
    if (mismatch === "hash") observation.source.identity = { ...identity, content_sha256: "b".repeat(64) };
    if (mismatch === "source_version") observation.source.identity = { ...identity, revision_token: "changed" };
    const adapter: any = { verify: async () => ({ status: "ready", observed: observation, evidence_refs: ["provider:observed"] }), execute: vi.fn(), postcheck: vi.fn() };
    expect((await coordinator.resume(plan, adapter)).status).toBe("conflict");
    expect(adapter.execute).not.toHaveBeenCalled();
  });
  it("only executes the deeply frozen conditional plan after matching preconditions", async () => {
    const { journal, admission, plan, coordinator } = setup();
    await journal.commit(admission, plan);
    let copied = false;
    const adapter: any = {
      verify: async () => copied ? { status: "verified", observed: { destination: present(destination) }, evidence_refs: ["provider:copied"] } : { status: "ready", observed: { source: present(address("ARTIFACTS/source.md")), destination: absent(destination) }, evidence_refs: ["provider:ready"] },
      execute: vi.fn(async (step) => { expect(Object.isFrozen(step.action.destination)).toBe(true); expect(() => { step.action.destination.path = "/widened"; }).toThrow(); copied = true; }),
      postcheck: async () => ({ verdict: "allow", evidence_refs: ["provider:postcheck"] })
    };
    expect((await coordinator.resume(plan, adapter)).status).toBe("finalized");
    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });
  it("plan replay cannot widen a destination or weaken a source precondition", async () => {
    const { journal, admission, plan, coordinator } = setup();
    await journal.commit(admission, plan);
    const adapter: any = { execute: vi.fn() };
    const changed = structuredClone(plan);
    changed.steps[0].action.destination = address("ARCHIVES/widened.md");
    await expect(coordinator.resume(changed, adapter)).rejects.toThrow("execution_plan_conflict");
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("a conditional write binds immutable content and the prior destination identity", async () => {
    const { journal, admission, coordinator } = setup();
    const target = address("ARTIFACTS/written.md");
    const prior = { ...identity, content_sha256: "b".repeat(64) };
    const plan: any = { target_revision: 2, postchecks: ["written"], steps: [{ ...copy, action: { kind: "write_if_unchanged", destination: target, expected_destination: { state: "present", identity: prior }, desired: { content_sha256: hash, content_ref: `sha256:${hash}` } } }] };
    await journal.commit(admission, plan);
    let written = false;
    const adapter: any = { verify: async () => ({ status: written ? "verified" : "ready", observed: { destination: present(target, written ? { ...identity, revision_token: "rev-2" } : prior) }, evidence_refs: ["provider:write"] }), execute: vi.fn(async () => { written = true; }), postcheck: async () => ({ verdict: "allow", evidence_refs: ["provider:verified-write"] }) };
    expect((await coordinator.resume(plan, adapter)).status).toBe("finalized");
    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "version_changed", "hash_changed"])("never conditionally deletes a source when the verified preservation copy is %s", async (condition) => {
    const { journal, admission, coordinator } = setup();
    const plan: any = { target_revision: 2, postchecks: ["archive"], steps: [{ ...copy, action: { kind: "delete_if_unchanged", source, verified_copy: { ...destination, expected: identity } } }] };
    await journal.commit(admission, plan);
    const observation = condition === "missing" ? absent(destination) : present(destination, { ...identity, ...(condition === "version_changed" ? { revision_token: "other" } : { content_sha256: "b".repeat(64) }) });
    const adapter: any = { verify: async () => ({ status: "ready", observed: { source: present(address("ARTIFACTS/source.md")), destination: observation }, evidence_refs: ["provider:delete-preconditions"] }), execute: vi.fn(), postcheck: vi.fn() };
    expect((await coordinator.resume(plan, adapter)).status).toBe("conflict");
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("wrong observed destination content cannot be marked verified after a provider effect", async () => {
    const { journal, admission, plan, coordinator } = setup();
    await journal.commit(admission, plan);
    let copied = false;
    const adapter: any = { verify: async () => copied ? { status: "verified", observed: { destination: present(destination, { ...identity, content_sha256: "b".repeat(64) }) }, evidence_refs: ["provider:wrong-copy"] } : { status: "ready", observed: { source: present(address("ARTIFACTS/source.md")), destination: absent(destination) }, evidence_refs: ["provider:ready"] }, execute: vi.fn(async () => { copied = true; }), postcheck: vi.fn() };
    expect(await coordinator.resume(plan, adapter)).toMatchObject({ status: "conflict", code: "EXECUTION_RESOURCE_CHANGED", completed_steps: [] });
    expect(adapter.postcheck).not.toHaveBeenCalled();
  });
});
