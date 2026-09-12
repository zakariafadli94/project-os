import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ExecutionAdmission, ExecutionPlan, ExecutionProgress, SupersedingTarget } from "./contract";
import { canonicalJson } from "../rules/contract";
import { sha256Text } from "../documents/hash";
import { machineConvergenceRoot } from "../persistence/layout";
import { z } from "zod";
import { assertEffectBindings, parseExecutionPlan } from "./effects";

const nonempty = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const refs = z.array(nonempty).min(1);
const successorSchema = z.strictObject({
  project_id: nonempty, kind: nonempty, request_id: nonempty, request_hash: hash,
  target_revision: z.number().int().nonnegative(), effect_plan_hash: hash, finalization_ref: nonempty, compatibility_ref: nonempty
});
const progressSchema = z.strictObject({
  schema_version: z.literal("1.0"), project_id: nonempty, request_id: nonempty, kind: nonempty,
  request_hash: hash, admission_ref: nonempty, effect_plan_hash: hash, sequence: z.number().int().nonnegative(),
  status: z.enum(["rejected", "committed", "finalizing", "finalized", "conflict", "failed"]), terminal: z.boolean(), code: nonempty.nullable(),
  completed_steps: z.array(z.strictObject({ step_id: nonempty, evidence_refs: refs, observation_hash: hash.optional(), precondition_refs: refs.optional() })),
  postchecks: z.array(z.strictObject({ check_id: nonempty, verdict: z.enum(["allow", "deny", "unavailable"]), evidence_refs: z.array(nonempty) })),
  failure_streak: z.strictObject({ fingerprint: hash, progress_digest: hash, count: z.number().int().positive() }).nullable(),
  next_attempt_at: z.string().datetime().nullable(), incident_ref: nonempty.nullable(),
  superseded_by: successorSchema.nullable(), finalization_ref: nonempty.nullable().optional(), receipt_ref: nonempty.nullable(),
  lease: z.strictObject({ owner: nonempty, until: z.string().datetime() }).nullable()
});
export const executionHash = (value: unknown): Promise<string> => sha256Text(canonicalJson(value));
export const requiredRulePostchecks = (admission: ExecutionAdmission): string[] => admission.deferred_rules.map((rule) => `rule:${canonicalJson(rule)}`);

export class ExecutionJournal {
  constructor(readonly runtime: ProjectOsPersistenceRuntime, readonly projectId: string, readonly kind: string, readonly requestId: string) {
    machineConvergenceRoot(projectId);
    if (!kind || !requestId || requestId.length > 512) throw new Error("execution_identity_invalid");
  }

  async root(): Promise<string> {
    return `${machineConvergenceRoot(this.projectId)}/executions/${await executionHash({ kind: this.kind, request_id: this.requestId })}`;
  }

  async commit(admission: ExecutionAdmission, plan: ExecutionPlan | null): Promise<void> {
    this.assertAdmission(admission);
    if (plan) {
      plan = parseExecutionPlan(plan);
      assertEffectBindings(plan, admission, this.runtime.providerId);
      const postchecks = plan.postchecks;
      if (requiredRulePostchecks(admission).some((id) => !postchecks.includes(id))) throw new Error("execution_required_postcheck_missing");
      if (!Number.isSafeInteger(plan.target_revision) || plan.target_revision < admission.project_revision
        || plan.steps.length === 0 || plan.postchecks.length === 0
        || new Set(plan.steps.map((s) => s.step_id)).size !== plan.steps.length
        || new Set(plan.postchecks).size !== plan.postchecks.length
        || plan.postchecks.some((s) => !s)
        || plan.steps.some((s) => !s.step_id || !s.action || !s.expected_version || !admission.resources.some((r) => r.resource_id === s.resource_id && (r.expected_version ?? r.version) === s.expected_version))) {
        throw new Error("execution_plan_invalid");
      }
    }
    const root = await this.root();
    const path = `${root}/admission.json`;
    const record = { schema_version: "1.0", admission, plan, effect_plan_hash: await executionHash(plan) };
    const existing = await this.readAdmission();
    if (existing) {
      if (existing.admission.request_hash !== admission.request_hash || existing.effect_plan_hash !== record.effect_plan_hash
        || existing.admission.operation !== admission.operation || canonicalJson(existing.admission.actor) !== canonicalJson(admission.actor)
        || canonicalJson(existing.admission.resources) !== canonicalJson(admission.resources)
        || canonicalJson(existing.admission.resource_effect_scopes) !== canonicalJson(admission.resource_effect_scopes)) throw new Error("execution_identity_conflict");
      if (!(await this.load())) throw new Error("execution_progress_unavailable");
      return;
    }
    await this.immutable(path, record);
    const progress: ExecutionProgress = {
      schema_version: "1.0", project_id: this.projectId, request_id: this.requestId, kind: this.kind,
      request_hash: admission.request_hash, admission_ref: path, effect_plan_hash: record.effect_plan_hash, sequence: 0,
      status: "committed", terminal: false, code: plan ? null : "FINALIZATION_ADAPTER_UNAVAILABLE",
      completed_steps: [], postchecks: [], failure_streak: null, next_attempt_at: null, incident_ref: null,
      superseded_by: null, finalization_ref: null, receipt_ref: null, lease: null
    };
    await this.immutable(`${root}/progress.json`, progress);
  }

  async readAdmission(): Promise<{ admission: ExecutionAdmission; plan: ExecutionPlan | null; effect_plan_hash: string } | null> {
    const raw = await this.runtime.objects.readText(`${await this.root()}/admission.json`);
    if (raw === null) return null;
    const record = JSON.parse(raw);
    if (record.schema_version !== "1.0") throw new Error("execution_admission_invalid");
    this.assertAdmission(record.admission);
    if (record.plan !== null) {
      record.plan = parseExecutionPlan(record.plan);
      assertEffectBindings(record.plan, record.admission, this.runtime.providerId);
    }
    if (record.effect_plan_hash !== await executionHash(record.plan)) throw new Error("execution_plan_conflict");
    return record;
  }

  async load(): Promise<{ progress: ExecutionProgress; token: string } | null> {
    const path = `${await this.root()}/progress.json`;
    const first = await this.runtime.objects.getMetadata(path);
    const raw = await this.runtime.objects.readText(path);
    const last = await this.runtime.objects.getMetadata(path);
    if (raw === null && !first && !last) return null;
    if (!raw || !first?.revisionToken || first.objectId !== last?.objectId || first.revisionToken !== last?.revisionToken) throw new Error("execution_progress_unstable");
    const progress = progressSchema.parse(JSON.parse(raw));
    if (progress.project_id !== this.projectId || progress.request_id !== this.requestId || progress.kind !== this.kind) throw new Error("execution_identity_conflict");
    const record = await this.readAdmission();
    if (!record || progress.admission_ref !== `${await this.root()}/admission.json` || record.admission.request_hash !== progress.request_hash || record.effect_plan_hash !== progress.effect_plan_hash) throw new Error("execution_admission_missing");
    return { progress, token: first.revisionToken };
  }

  async status(): Promise<ExecutionProgress | null> {
    const saved = await this.load();
    if (!saved && await this.readAdmission()) throw new Error("execution_progress_unavailable");
    return saved?.progress ?? null;
  }

  /** A family receipt is evidence of its historical outcome, not proof that all
   * governed postconditions have been satisfied. Existing receipt bytes stay unchanged. */
  async recordReceipt(status: "committed" | "rejected" | "conflict", receiptRef: string): Promise<void> {
    if (!receiptRef) throw new Error("execution_receipt_ref_required");
    const saved = await this.load();
    if (!saved) return; // compatibility: legacy requests have no governed lifecycle
    const p = saved.progress;
    if (p.receipt_ref && p.receipt_ref !== receiptRef) throw new Error("execution_receipt_conflict");
    if (p.terminal) return;
    p.receipt_ref = receiptRef;
    p.status = status === "committed" ? "finalizing" : status;
    p.terminal = status !== "committed";
    p.sequence++;
    await this.save(p, saved.token);
  }

  async save(progress: ExecutionProgress, token: string): Promise<string> {
    progressSchema.parse(progress);
    const root = await this.root();
    await this.immutable(`${root}/history/${progress.sequence}-${await executionHash(progress)}.json`, progress);
    const metadata = await this.runtime.conditionalWrite.writeTextConditional(`${root}/progress.json`, canonicalJson(progress), token);
    if (!metadata.revisionToken) throw new Error("execution_progress_token_unavailable");
    return metadata.revisionToken;
  }

  async incident(progress: ExecutionProgress): Promise<string> {
    const path = `${await this.root()}/incidents/${await executionHash({ request_hash: progress.request_hash, failure: progress.failure_streak })}.json`;
    await this.immutable(path, { schema_version: "1.0", project_id: this.projectId, request_id: this.requestId, code: "IDENTICAL_INTERNAL_FAILURE_LIMIT", failure: progress.failure_streak, admission_ref: progress.admission_ref });
    return path;
  }

  async finalize(progress: ExecutionProgress, plan: ExecutionPlan): Promise<string> {
    const record = finalizationRecord(progress, plan);
    const path = `${await this.root()}/finalizations/${await executionHash(record)}.json`;
    await this.immutable(path, record);
    return path;
  }

  /** Read the actual successor's canonical records, not an adapter's assurance.
   * Compatibility is a frozen predecessor binding plus identical effects and
   * postchecks. No arbitrary evidence URL is read and no client proof is trusted. */
  async verifySuccessor(value: unknown, predecessor: ExecutionProgress, plan: ExecutionPlan): Promise<SupersedingTarget | null> {
    const parsed = successorSchema.safeParse(value);
    if (!parsed.success) return null;
    const candidate = parsed.data;
    if (candidate.project_id !== predecessor.project_id || candidate.target_revision <= plan.target_revision) return null;
    const successor = new ExecutionJournal(this.runtime, candidate.project_id, candidate.kind, candidate.request_id);
    try {
      const next = await successor.load();
      const admitted = await successor.readAdmission();
      if (!next || !admitted?.plan || next.progress.status !== "finalized" || !next.progress.terminal
        || next.progress.request_hash !== candidate.request_hash || next.progress.effect_plan_hash !== candidate.effect_plan_hash
        || next.progress.finalization_ref !== candidate.finalization_ref || admitted.plan.target_revision !== candidate.target_revision
        || candidate.compatibility_ref !== `${await successor.root()}/admission.json#plan.supersedes`) return null;
      const expectedPredecessor = { project_id: predecessor.project_id, kind: predecessor.kind, request_id: predecessor.request_id,
        request_hash: predecessor.request_hash, effect_plan_hash: predecessor.effect_plan_hash, target_revision: plan.target_revision,
        compatibility: "identical_effects_and_postchecks" };
      if (canonicalJson(admitted.plan.supersedes) !== canonicalJson(expectedPredecessor)
        || canonicalJson(admitted.plan.steps) !== canonicalJson(plan.steps)
        || canonicalJson(admitted.plan.postchecks) !== canonicalJson(plan.postchecks)) return null;
      const expectedRecord = finalizationRecord(next.progress, admitted.plan);
      const expectedRef = `${await successor.root()}/finalizations/${await executionHash(expectedRecord)}.json`;
      if (candidate.finalization_ref !== expectedRef) return null;
      const raw = await this.runtime.objects.readText(expectedRef);
      if (raw === null || canonicalJson(JSON.parse(raw)) !== canonicalJson(expectedRecord)) return null;
      return candidate;
    } catch { return null; }
  }

  private async immutable(path: string, value: unknown): Promise<void> {
    const content = canonicalJson(value);
    try { await this.runtime.objects.createText(path, content); }
    catch (error) { if (await this.runtime.objects.readText(path) !== content) throw error; }
  }

  private assertAdmission(value: ExecutionAdmission): void {
    if (!value || value.project_id !== this.projectId || value.request_id !== this.requestId || value.kind !== this.kind
      || !value.operation || !/^[a-f0-9]{64}$/.test(value.request_hash) || !value.actor?.actor_id || !value.actor.authority
      || value.verdict !== "allow" || !Array.isArray(value.resources) || !value.resources.length
      || value.resources.some((r) => !r.resource_id || !r.version || !r.zone || !r.resource_type)
      || !Number.isSafeInteger(value.project_revision) || value.project_revision < 0
      || !Number.isSafeInteger(value.global_revision) || value.global_revision < 0
      || value.ruleset?.global_revision !== value.global_revision || value.ruleset?.project_revision !== value.project_revision
      || !/^[a-f0-9]{64}$/.test(value.ruleset?.digest) || !Array.isArray(value.ruleset.rules)
      || !Array.isArray(value.results) || !Array.isArray(value.gaps) || !Array.isArray(value.deferred_rules)) throw new Error("execution_admission_invalid");
    if (value.operation === "project.repair" && !value.diagnosed_drift_refs?.length) throw new Error("repair_diagnosed_drift_required");
  }
}

function finalizationRecord(progress: ExecutionProgress, plan: ExecutionPlan) {
  if (progress.status !== "finalized" || !progress.terminal
    || progress.completed_steps.length !== plan.steps.length
    || plan.steps.some((step) => !progress.completed_steps.some((done) => done.step_id === step.step_id && done.evidence_refs.length > 0))
    || progress.postchecks.length !== plan.postchecks.length
    || plan.postchecks.some((id) => !progress.postchecks.some((check) => check.check_id === id && check.verdict === "allow" && check.evidence_refs.length > 0))) throw new Error("execution_finalization_unproven");
  return { schema_version: "1.0", project_id: progress.project_id, kind: progress.kind, request_id: progress.request_id,
    request_hash: progress.request_hash, effect_plan_hash: progress.effect_plan_hash, target_revision: plan.target_revision,
    completed_steps: progress.completed_steps, postchecks: progress.postchecks };
}
