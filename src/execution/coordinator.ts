import type { ExecutionAdapter, ExecutionPlan, ExecutionProgress } from "./contract";
import { ExecutionJournal } from "./journal";
import { executionHash } from "./journal";
import { ProviderOperationError } from "../persistence/provider/errors";
import { nextRetryAt } from "../convergence/retry";
import { freezeExecutionPlan, inspectStepObservation } from "./effects";
export class InternalExecutionFailure extends Error {
  constructor(readonly code: string, readonly stage: string) { super(code); }
}
export class ExecutionCoordinator {
  constructor(readonly journal: ExecutionJournal) {}
  async resume(plan: ExecutionPlan, adapter: ExecutionAdapter, options: { now?: number } = {}): Promise<ExecutionProgress> {
    const record = await this.journal.readAdmission();
    if (!record) throw new Error("execution_admission_missing");
    if (!record.plan || record.effect_plan_hash !== await executionHash(plan)) throw new Error("execution_plan_conflict");
    plan = freezeExecutionPlan(record.plan);
    const saved = await this.journal.load();
    if (!saved) throw new Error("execution_progress_unavailable");
    const p = saved.progress;
    if (p.terminal) {
      if (p.code !== "IDENTICAL_INTERNAL_FAILURE_LIMIT") return p;
      // A stopped operation may be inspected, but never blindly re-executed.
      // Only a newly verified frozen step is real progress that can reopen it.
      let progressed = false;
      for (const step of plan.steps) {
        if (p.completed_steps.some((s) => s.step_id === step.step_id)) continue;
        const observation = await adapter.verify(step);
        if (inspectStepObservation(step, observation, record.admission) === "verified") { progressed = true; break; }
      }
      if (!progressed) return p;
      p.terminal = false;
      p.failure_streak = null;
    }
    const now = options.now ?? Date.now();
    if ((p.next_attempt_at && Date.parse(p.next_attempt_at) > now) || (p.lease && Date.parse(p.lease.until) > now)) return p;
    let token = saved.token;
    let journalFailure = false;
    const checkpoint = async () => {
      p.sequence++;
      try { token = await this.journal.save(p, token); }
      catch (error) { journalFailure = true; throw error; }
    };
    const finish = async () => { p.lease = null; await checkpoint(); return p; };
    p.lease = { owner: crypto.randomUUID(), until: new Date(now + 60_000).toISOString() };
    p.status = "finalizing";
    p.code = null;
    p.next_attempt_at = null;
    await checkpoint(); // reservation is canonical before an adapter can start any effect
    let stage = "supersession";
    let stepId = "";
    try {
      const newer = await adapter.supersedingTarget?.();
      if (newer) {
        const verified = await this.journal.verifySuccessor(newer, p, plan);
        if (!verified) { p.code = "EXECUTION_SUPERSESSION_UNAVAILABLE"; return finish(); }
        p.status = "conflict"; p.terminal = true; p.code = "TARGET_SUPERSEDED";
        p.superseded_by = verified;
        return finish();
      }
      for (const step of plan.steps) {
        stepId = step.step_id;
        stage = "observe";
        const observed = await adapter.verify(step);
        const observedStatus = inspectStepObservation(step, observed, record.admission);
        const completed = p.completed_steps.some((s) => s.step_id === step.step_id);
        if (observedStatus === "conflict" || (completed && observedStatus === "ready")) {
          p.status = "conflict"; p.terminal = true; p.code = "EXECUTION_RESOURCE_CHANGED"; return finish();
        }
        if (observedStatus === "unavailable") { p.code = "EXECUTION_OBSERVATION_UNAVAILABLE"; return finish(); }
        let verified = observed;
        if (observedStatus === "ready") {
          stage = "effect";
          await adapter.execute(step);
          stage = "verify";
          verified = await adapter.verify(step);
        }
        const verifiedStatus = inspectStepObservation(step, verified, record.admission);
        if (verifiedStatus === "conflict") { p.status = "conflict"; p.terminal = true; p.code = "EXECUTION_RESOURCE_CHANGED"; return finish(); }
        if (verifiedStatus !== "verified" || verified.status !== "verified") { p.code = "EXECUTION_POSTCONDITION_UNAVAILABLE"; return finish(); }
        if (!completed) {
          p.completed_steps.push({ step_id: step.step_id, evidence_refs: verified.evidence_refs, observation_hash: await executionHash(verified.observed), ...(observed.status === "ready" ? { precondition_refs: observed.evidence_refs } : {}) });
          p.failure_streak = null;
          await checkpoint();
        }
      }
      stage = "postcheck";
      p.postchecks = [];
      for (const check_id of plan.postchecks) {
        stepId = check_id;
        const result = await adapter.postcheck(check_id);
        if (result.verdict === "allow" && !result.evidence_refs.length) result.verdict = "unavailable";
        p.postchecks.push({ check_id, ...result });
      }
      if (p.postchecks.some((c) => c.verdict === "deny")) { p.status = "conflict"; p.terminal = true; p.code = "EXECUTION_POSTCHECK_DENIED"; }
      else if (p.postchecks.some((c) => c.verdict === "unavailable")) p.code = "EXECUTION_POSTCHECK_UNAVAILABLE";
      else {
        let reference: string;
        try { reference = await this.journal.finalize({ ...p, status: "finalized", terminal: true, code: null }, plan); }
        catch (error) { journalFailure = true; throw error; }
        p.status = "finalized"; p.terminal = true; p.code = null; p.finalization_ref = reference;
      }
      return finish();
    } catch (error) {
      // An uncertain checkpoint is not a proved business conflict. Leave the
      // canonical reservation intact; the next owner must re-observe effects.
      if (journalFailure) throw error;
      const progress = await executionHash(p.completed_steps.map((s) => s.step_id));
      if (error instanceof ProviderOperationError && error.retryable) {
        // Transient transport failures are not identical internal failures.
        p.code = "EXECUTION_PROVIDER_RETRY";
        p.next_attempt_at = nextRetryAt({ nowMs: now, failureCount: 1, jitter: 0, retryAfterMs: 0 }).at;
      } else if (error instanceof InternalExecutionFailure) {
        const fingerprint = await executionHash({ project_id: p.project_id, request_hash: p.request_hash, plan: p.effect_plan_hash, step: stepId, stage: error.stage || stage, code: error.code });
        const prior = p.failure_streak;
        const count = prior?.fingerprint === fingerprint && prior.progress_digest === progress ? prior.count + 1 : 1;
        p.failure_streak = { fingerprint, progress_digest: progress, count };
        if (count >= 6) {
          p.incident_ref = await this.journal.incident(p);
          p.status = "failed"; p.terminal = true; p.code = "IDENTICAL_INTERNAL_FAILURE_LIMIT"; p.next_attempt_at = null;
        } else {
          p.code = error.code;
          p.next_attempt_at = nextRetryAt({ nowMs: now, failureCount: count, jitter: 0, retryAfterMs: 0 }).at;
        }
      } else {
        p.status = "conflict"; p.terminal = true; p.code = "EXECUTION_UNCLASSIFIED_FAILURE";
      }
      return finish();
    }
  }
}
