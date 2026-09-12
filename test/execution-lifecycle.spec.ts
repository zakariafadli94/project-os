import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionJournal } from "../src/execution/journal";
import { ExecutionCoordinator, InternalExecutionFailure } from "../src/execution/coordinator";
import type { ExecutionAdmission, ExecutionAdapter, ExecutionPlan, ExecutionStep, StepObservation } from "../src/execution/contract";
import { parseRepairIntent } from "../src/execution/repair";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";
import { installDropboxMock } from "./helpers/mock-dropbox";

afterEach(() => vi.restoreAllMocks());
const hash = "a".repeat(64);
const admission = (project_id = "PRJ-9258"): ExecutionAdmission => ({
  project_id, operation: "artifact.write", request_id: "REQ-EXECUTION-001", kind: "artifact",
  request_hash: hash, actor: { actor_id: "verified-user", authority: "ingress" },
  global_revision: 1, project_revision: 2, ruleset: { digest: hash, rules: [], global_revision: 1, project_revision: 2 },
  verdict: "allow", results: [], gaps: [], deferred_rules: [], resources: [{ resource_id: "artifact-1", resource_type: "artifact", zone: "ARTIFACTS", version: hash }],
  resource_effect_scopes: [{ resource_id: "artifact-1", resource_version: hash, provider_id: "dropbox",
    sources: [{ logical_path: "ARTIFACTS/source.md", path: `/PROJECT_OS/WORKSPACE/PROJECTS/${project_id}-test/ARTIFACTS/source.md` }],
    destinations: [{ logical_path: "ARCHIVES/source.md", path: `/PROJECT_OS/WORKSPACE/PROJECTS/${project_id}-test/ARCHIVES/source.md` }],
    preservation_copies: [{ logical_path: "ARCHIVES/source.md", path: `/PROJECT_OS/WORKSPACE/PROJECTS/${project_id}-test/ARCHIVES/source.md` }]
  }]
});
const sourceIdentity = { object_id: "source-object", revision_token: "source-r1", content_sha256: hash };
const copyIdentity = { object_id: "copied-object", revision_token: "copy-r1", content_sha256: hash };
function makePlan(projectId = "PRJ-9258"): ExecutionPlan {
  const address = (logical_path: string) => ({ logical_path, path: `/PROJECT_OS/WORKSPACE/PROJECTS/${projectId}-test/${logical_path}` });
  const source = { ...address("ARTIFACTS/source.md"), expected: sourceIdentity };
  const destination = address("ARCHIVES/source.md");
  const base = { resource_id: "artifact-1", expected_version: hash, provider_id: "dropbox" };
  return { steps: [{ ...base, step_id: "copy", action: { kind: "copy_if_unchanged", source, destination, expected_destination: { state: "absent" }, desired: { content_sha256: hash } } }, { ...base, step_id: "remove", action: { kind: "delete_if_unchanged", source, verified_copy: { ...destination, expected: copyIdentity } } }], postchecks: ["destination_verified"], target_revision: 2 };
}
const plan = makePlan();
function stepObservation(step: ExecutionStep, done: boolean): StepObservation {
  const effect = step.action;
  if (effect.kind === "write_if_unchanged") throw new Error("fixture_unsupported_write");
  const source = { path: effect.source.path, logical_path: effect.source.logical_path };
  if (effect.kind === "copy_if_unchanged") return done
    ? { status: "verified", observed: { destination: { ...effect.destination, state: "present", identity: copyIdentity } }, evidence_refs: ["proof:copy"] }
    : { status: "ready", observed: { source: { ...source, state: "present", identity: sourceIdentity }, destination: { ...effect.destination, state: "absent" } }, evidence_refs: ["proof:precondition"] };
  const destination = { path: effect.verified_copy.path, logical_path: effect.verified_copy.logical_path, state: "present" as const, identity: copyIdentity };
  return { status: done ? "verified" : "ready", observed: { source: done ? { ...source, state: "absent" } : { ...source, state: "present", identity: sourceIdentity }, destination }, evidence_refs: ["proof:remove"] };
}
function setup(project = "PRJ-9258") {
  installDropboxMock();
  const runtime = persistenceFromDropbox(new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" }));
  const journal = new ExecutionJournal(runtime, project, "artifact", "REQ-EXECUTION-001");
  const present = new Set<string>();
  const adapter: ExecutionAdapter = {
    verify: vi.fn(async (step) => stepObservation(step, present.has(step.step_id))),
    execute: vi.fn(async (step) => { present.add(step.step_id); }),
    postcheck: vi.fn(async () => ({ verdict: "allow" as const, evidence_refs: ["proof:destination"] }))
  };
  return { runtime, journal, present, adapter, coordinator: new ExecutionCoordinator(journal) };
}

describe("durable governed execution", () => {
  it("cannot execute before committed canonical admission and distinguishes committed from finalized", async () => {
    const { journal, coordinator, adapter } = setup();
    await expect(coordinator.resume(plan, adapter)).rejects.toThrow("execution_admission_missing");
    expect(adapter.execute).not.toHaveBeenCalled();
    await journal.commit(admission(), plan);
    expect((await journal.status())?.status).toBe("committed");
    expect((await coordinator.resume(plan, adapter)).status).toBe("finalized");
    expect((await journal.status())?.completed_steps).toHaveLength(2);
  });

  it.each(["copy", "remove"])("recovers crash after %s without repeating an already-present effect", async (crashStep) => {
    const { runtime, journal, present, adapter } = setup();
    await journal.commit(admission(), plan);
    let once = true;
    adapter.execute = vi.fn(async (step) => { present.add(step.step_id); if (step.step_id === crashStep && once) { once = false; throw new InternalExecutionFailure("PROCESS_LOST", "effect"); } });
    await new ExecutionCoordinator(journal).resume(plan, adapter);
    const cold = new ExecutionCoordinator(new ExecutionJournal(runtime, "PRJ-9258", "artifact", "REQ-EXECUTION-001"));
    expect((await cold.resume(plan, adapter, { now: Date.now() + 600_000 })).status).toBe("finalized");
    expect(adapter.execute).toHaveBeenCalledTimes(2);
  });

  it("recovers immediately after commit and rejects changed payload or wider effect plan", async () => {
    const { journal, coordinator, adapter } = setup();
    await journal.commit(admission(), plan);
    await expect(journal.commit({ ...admission(), request_hash: "b".repeat(64) }, plan)).rejects.toThrow("execution_identity_conflict");
    await expect(coordinator.resume({ ...plan, steps: [...plan.steps, { ...plan.steps[0], step_id: "extra" }] }, adapter)).rejects.toThrow("execution_plan_conflict");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect((await coordinator.resume(plan, adapter)).status).toBe("finalized");
  });

  it("reverifies completed steps on resume and never silently repairs a changed previously verified effect", async () => {
    const { journal, coordinator, adapter, present } = setup();
    await journal.commit(admission(), plan);
    adapter.postcheck = async () => ({ verdict: "unavailable", evidence_refs: [] });
    expect((await coordinator.resume(plan, adapter)).status).toBe("finalizing");
    present.delete("copy");
    expect((await coordinator.resume(plan, adapter)).status).toBe("conflict");
    expect(adapter.execute).toHaveBeenCalledTimes(2);
  });

  it("opaque supersession refs cannot close obsolete work without resolved durable finalization", async () => {
    const { journal, coordinator, adapter } = setup();
    await journal.commit(admission(), plan);
    adapter.supersedingTarget = async () => ({ project_id: "PRJ-9258", revision: 3, covers_plan_hash: (await journal.status())!.effect_plan_hash, evidence_refs: ["proof:newer-head"] }) as never;
    const result = await coordinator.resume(plan, adapter);
    expect(result).toMatchObject({ status: "finalizing", code: "EXECUTION_SUPERSESSION_UNAVAILABLE", terminal: false });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("independently resolves a finalized successor and its frozen exact compatibility proof", async () => {
    const { runtime, journal, coordinator, adapter } = setup();
    await journal.commit(admission(), plan);
    const before = (await journal.status())!;
    const successor = new ExecutionJournal(runtime, "PRJ-9258", "artifact", "REQ-EXECUTION-002");
    const nextPlan = { ...plan, target_revision: 3, supersedes: { project_id: before.project_id, kind: before.kind, request_id: before.request_id, request_hash: before.request_hash, effect_plan_hash: before.effect_plan_hash, target_revision: 2, compatibility: "identical_effects_and_postchecks" } };
    await successor.commit({ ...admission(), request_id: "REQ-EXECUTION-002", request_hash: "b".repeat(64) }, nextPlan as never);
    const finalized = await new ExecutionCoordinator(successor).resume(nextPlan as never, adapter);
    expect((finalized as any).finalization_ref).toEqual(expect.any(String));
    vi.mocked(adapter.execute).mockClear();
    adapter.supersedingTarget = async () => ({ project_id: finalized.project_id, kind: finalized.kind, request_id: finalized.request_id, request_hash: finalized.request_hash, target_revision: 3, effect_plan_hash: finalized.effect_plan_hash, finalization_ref: (finalized as any).finalization_ref, compatibility_ref: `${await successor.root()}/admission.json#plan.supersedes` }) as never;
    const evidence = await runtime.objects.readText(finalized.finalization_ref!);
    await runtime.objects.delete(finalized.finalization_ref!);
    expect(await coordinator.resume(plan, adapter)).toMatchObject({ terminal: false, code: "EXECUTION_SUPERSESSION_UNAVAILABLE" });
    await runtime.objects.createText(finalized.finalization_ref!, evidence!);
    expect(await coordinator.resume(plan, adapter)).toMatchObject({ status: "conflict", code: "TARGET_SUPERSEDED", terminal: true });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("an unfinalized successor or incompatible frozen plan cannot supersede an operation", async () => {
    const { runtime, journal, coordinator, adapter } = setup();
    await journal.commit(admission(), plan);
    const successor = new ExecutionJournal(runtime, "PRJ-9258", "artifact", "REQ-EXECUTION-002");
    const nextPlan = { ...plan, target_revision: 3 };
    await successor.commit({ ...admission(), request_id: "REQ-EXECUTION-002" }, nextPlan);
    const next = (await successor.status())!;
    adapter.supersedingTarget = async () => ({ project_id: next.project_id, kind: next.kind, request_id: next.request_id, request_hash: next.request_hash, target_revision: 3, effect_plan_hash: next.effect_plan_hash, finalization_ref: "opaque:finalization", compatibility_ref: `${await successor.root()}/admission.json#plan.supersedes` }) as never;
    expect(await coordinator.resume(plan, adapter)).toMatchObject({ status: "finalizing", code: "EXECUTION_SUPERSESSION_UNAVAILABLE", terminal: false });
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("stops six identical internal failures without progress and preserves a visible durable incident", async () => {
    const { journal, coordinator, adapter } = setup();
    await journal.commit(admission(), plan);
    adapter.execute = vi.fn(async () => { throw new InternalExecutionFailure("INTERNAL_COPY", "effect"); });
    for (let i = 0; i < 6; i++) await coordinator.resume(plan, adapter, { now: 1_000_000 * (i + 1) });
    const stopped = await journal.status();
    expect(stopped).toMatchObject({ status: "failed", terminal: true, code: "IDENTICAL_INTERNAL_FAILURE_LIMIT", next_attempt_at: null });
    expect(stopped?.incident_ref).toBeTruthy();
    await coordinator.resume(plan, adapter, { now: 10_000_000 });
    expect(adapter.execute).toHaveBeenCalledTimes(6);
  });

  it("changed failure and real progress reset the no-progress streak; another project continues", async () => {
    const { runtime, journal, coordinator, adapter, present } = setup();
    await journal.commit(admission(), plan);
    let code = "INTERNAL_COPY";
    adapter.execute = vi.fn(async (step) => { if (present.has("progress")) { present.add(step.step_id); return; } throw new InternalExecutionFailure(code, "effect"); });
    for (let i = 0; i < 5; i++) await coordinator.resume(plan, adapter, { now: 1_000_000 * (i + 1) });
    code = "INTERNAL_DIFFERENT";
    expect((await coordinator.resume(plan, adapter, { now: 6_000_000 })).failure_streak?.count).toBe(1);
    present.add("progress");
    expect((await coordinator.resume(plan, adapter, { now: 7_000_000 })).status).toBe("finalized");
    const other = new ExecutionJournal(runtime, "PRJ-9259", "artifact", "REQ-EXECUTION-001");
    const otherPlan = makePlan("PRJ-9259");
    await other.commit(admission("PRJ-9259"), otherPlan);
    expect((await new ExecutionCoordinator(other).resume(otherPlan, adapter)).status).toBe("finalized");
  });

  it("refuses unsupported families' finalization without a postcheck adapter", async () => {
    const { journal } = setup();
    await journal.commit(admission(), null);
    expect(await journal.status()).toMatchObject({ status: "committed", terminal: false, code: "FINALIZATION_ADAPTER_UNAVAILABLE" });
  });

  it("a stopped operation can resume after new verified progress, never merely because time passed", async () => {
    const { journal, coordinator, adapter, present } = setup();
    await journal.commit(admission(), plan);
    adapter.execute = vi.fn(async () => { throw new InternalExecutionFailure("INTERNAL_COPY", "effect"); });
    for (let i = 0; i < 6; i++) await coordinator.resume(plan, adapter, { now: 1_000_000 * (i + 1) });
    present.add("copy");
    adapter.execute = vi.fn(async (step) => { present.add(step.step_id); });
    expect((await coordinator.resume(plan, adapter, { now: 7_000_000 })).status).toBe("finalized");
    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });

  it("a committed historical receipt means finalizing, not finalized", async () => {
    const { journal } = setup();
    await journal.commit(admission(), null);
    await journal.recordReceipt("committed", "canonical:receipt-1");
    expect(await journal.status()).toMatchObject({ status: "finalizing", terminal: false, receipt_ref: "canonical:receipt-1" });
  });

  it("a missing progress record after admission never bootstraps an ambiguous execution", async () => {
    const { journal, runtime, coordinator, adapter } = setup();
    await journal.commit(admission(), plan);
    await runtime.objects.delete(`${await journal.root()}/progress.json`);
    await expect(journal.commit(admission(), plan)).rejects.toThrow("execution_progress_unavailable");
    await expect(coordinator.resume(plan, adapter)).rejects.toThrow("execution_progress_unavailable");
    expect(adapter.execute).not.toHaveBeenCalled();
    await expect(journal.status()).rejects.toThrow("execution_progress_unavailable");
  });

  it.each([1, 2])("a lost checkpoint after step %s resumes by observation, not by repeating the effect", async (stepCount) => {
    const { journal, coordinator, adapter } = setup();
    await journal.commit(admission(), plan);
    const save = journal.save.bind(journal);
    let once = true;
    vi.spyOn(journal, "save").mockImplementation(async (progress, token) => {
      if (progress.completed_steps.length === stepCount && once) { once = false; throw new Error("checkpoint_lost"); }
      return save(progress, token);
    });
    await expect(coordinator.resume(plan, adapter)).rejects.toThrow("checkpoint_lost");
    expect((await coordinator.resume(plan, adapter, { now: Date.now() + 600_000 })).status).toBe("finalized");
    expect(adapter.execute).toHaveBeenCalledTimes(2);
  });

  it("a lost immutable finalization response cannot expose finalized or prevent safe resume", async () => {
    const { journal, coordinator, adapter } = setup();
    await journal.commit(admission(), plan);
    const finalize = journal.finalize.bind(journal);
    let once = true;
    vi.spyOn(journal, "finalize").mockImplementation(async (progress, frozenPlan) => {
      const ref = await finalize(progress, frozenPlan);
      if (once) { once = false; throw new Error("finalization_response_lost"); }
      return ref;
    });
    await expect(coordinator.resume(plan, adapter)).rejects.toThrow("finalization_response_lost");
    expect(await journal.status()).toMatchObject({ status: "finalizing", terminal: false });
    expect((await coordinator.resume(plan, adapter, { now: Date.now() + 600_000 })).status).toBe("finalized");
    expect(adapter.execute).toHaveBeenCalledTimes(2);
  });

  it("an unexpired reservation prevents a second coordinator from starting an effect", async () => {
    const { journal, coordinator, adapter } = setup();
    await journal.commit(admission(), plan);
    const original = adapter.execute;
    adapter.execute = vi.fn(async (step) => {
      const rival = { ...adapter, execute: vi.fn() };
      await new ExecutionCoordinator(journal).resume(plan, rival);
      expect(rival.execute).not.toHaveBeenCalled();
      await original(step);
    });
    expect((await coordinator.resume(plan, adapter)).status).toBe("finalized");
  });

  it("cannot finalize when a frozen plan omits a deferred rule postcheck", async () => {
    const { journal } = setup();
    const a = admission();
    a.deferred_rules = [{ rule_id: "RULE-POSTCHECK", version: 1, scope: { kind: "global" } }];
    await expect(journal.commit(a, plan)).rejects.toThrow("execution_required_postcheck_missing");
  });

  it("rejects a repair without exact resources or diagnosed drift", () => {
    const repair = { project_id: "PRJ-9258", operation: "project.repair", request_id: "REPAIR-0001", base_revision: 2, diagnosed_drift_refs: ["drift:1"], resources: admission().resources, action: { kind: "resume_committed", original_kind: "artifact", original_request_id: "REQ-EXECUTION-001", effect_plan_hash: hash } };
    expect(parseRepairIntent(repair)).toEqual(repair);
    expect(() => parseRepairIntent({ ...repair, resources: [] })).toThrow();
    expect(() => parseRepairIntent({ ...repair, diagnosed_drift_refs: [] })).toThrow();
    expect(() => parseRepairIntent({ ...repair, action: { kind: "arbitrary_write", path: "/any" } })).toThrow();
  });
});
