import type { DomainEvent } from "./event";
import { eventIdForRevision } from "./event";
import type { ProjectState } from "./project-state";
import type { Transaction } from "./transaction";

export type TransitionResult =
  | { kind: "commit"; state: ProjectState; event: DomainEvent }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "conflict"; code: string; message: string };

const EPOCH = "1970-01-01T00:00:00.000Z";

export function emptyProjectState(
  projectId: string,
  name: string,
  slug: string,
  objective = "",
  aliases: string[] = []
): ProjectState {
  return {
    schema_version: "1.0",
    project_id: projectId,
    name,
    slug,
    aliases: [...aliases],
    objective,
    status: "active",
    revision: 0,
    current_phase_id: null,
    constraints: {},
    tasks: {},
    plan_phases: {},
    decisions: {},
    research: {},
    deliverables: {},
    last_event_id: null,
    created_at: EPOCH,
    updated_at: EPOCH
  };
}

function rejected(code: string, message: string): TransitionResult {
  return { kind: "rejected", code, message };
}

function conflict(code: string, message: string): TransitionResult {
  return { kind: "conflict", code, message };
}

function commit(state: ProjectState, tx: Transaction): TransitionResult {
  const revision = state.revision + 1;
  const eventId = eventIdForRevision(revision);
  const next: ProjectState = {
    ...state,
    revision,
    last_event_id: eventId,
    updated_at: tx.created_at
  };
  const event: DomainEvent = {
    schema_version: "1.0",
    event_id: eventId,
    project_id: tx.project_id,
    revision,
    transaction_id: tx.transaction_id,
    type: tx.operation,
    timestamp: tx.created_at,
    payload: { ...tx.payload } as Record<string, unknown>
  };
  return { kind: "commit", state: next, event };
}

const exactRevisionOperations = new Set<Transaction["operation"]>([
  "project.pause",
  "project.resume",
  "project.complete",
  "project.archive",
  "decision.accept",
  "decision.supersede",
  "plan.phase.create",
  "plan.phase.update",
  "plan.phase.complete"
]);

export function applyTransaction(state: ProjectState | null, tx: Transaction): TransitionResult {
  if (tx.operation === "project.create") {
    if (state !== null) return rejected("PROJECT_EXISTS", "Project already exists");
    if (tx.base_revision !== 0) return conflict("REVISION_MISMATCH", "Project creation requires base revision 0");
    const created = emptyProjectState(
      tx.project_id,
      tx.payload.name,
      tx.payload.slug,
      tx.payload.objective,
      tx.payload.aliases
    );
    created.created_at = tx.created_at;
    created.updated_at = tx.created_at;
    return commit(created, tx);
  }

  if (state === null) return rejected("PROJECT_NOT_FOUND", "Project does not exist");
  if (state.project_id !== tx.project_id) return rejected("PROJECT_ID_MISMATCH", "Transaction project does not match state");
  if (tx.base_revision > state.revision) return conflict("REVISION_AHEAD", "Transaction base revision is ahead of canonical state");
  if (state.status === "archived") return rejected("PROJECT_ARCHIVED", "Archived projects are terminal in V1");
  if (state.status === "completed" && tx.operation !== "project.archive") {
    return rejected("PROJECT_COMPLETED", "Completed projects only support archival in V1");
  }

  const stale = tx.base_revision !== state.revision;
  if (stale && exactRevisionOperations.has(tx.operation)) {
    return conflict("STALE_REVISION", `${tx.operation} requires the current project revision`);
  }

  const next = structuredClone(state);

  switch (tx.operation) {
    case "project.pause":
      if (next.status !== "active") return rejected("INVALID_PROJECT_TRANSITION", "Only active projects can be paused");
      next.status = "paused";
      return commit(next, tx);

    case "project.resume":
      if (next.status !== "paused") return rejected("INVALID_PROJECT_TRANSITION", "Only paused projects can be resumed");
      next.status = "active";
      return commit(next, tx);

    case "project.complete":
      if (next.status !== "active" && next.status !== "paused") {
        return rejected("INVALID_PROJECT_TRANSITION", "Only active or paused projects can be completed");
      }
      next.status = "completed";
      return commit(next, tx);

    case "project.archive":
      if (next.status === "archived") return rejected("INVALID_PROJECT_TRANSITION", "Project is already archived");
      next.status = "archived";
      return commit(next, tx);

    case "task.create": {
      const p = tx.payload;
      if (next.tasks[p.task_id]) return rejected("TASK_EXISTS", `Task ${p.task_id} already exists`);
      if (p.phase_id && !next.plan_phases[p.phase_id]) return rejected("PHASE_NOT_FOUND", `Phase ${p.phase_id} does not exist`);
      next.tasks[p.task_id] = {
        task_id: p.task_id,
        title: p.title,
        description: p.description,
        phase_id: p.phase_id,
        status: "pending",
        created_at: tx.created_at,
        updated_at: tx.created_at
      };
      return commit(next, tx);
    }

    case "task.start": {
      const task = next.tasks[tx.payload.task_id];
      if (!task) return rejected("TASK_NOT_FOUND", `Task ${tx.payload.task_id} does not exist`);
      if (task.status !== "pending" && task.status !== "blocked") {
        return rejected("INVALID_TASK_TRANSITION", `Task ${task.task_id} cannot start from ${task.status}`);
      }
      task.status = "active";
      delete task.blocked_reason;
      task.updated_at = tx.created_at;
      return commit(next, tx);
    }

    case "task.complete": {
      const task = next.tasks[tx.payload.task_id];
      if (!task) return rejected("TASK_NOT_FOUND", `Task ${tx.payload.task_id} does not exist`);
      if (task.status === "completed") return rejected("TASK_ALREADY_COMPLETED", `Task ${task.task_id} is already completed`);
      task.status = "completed";
      task.result = tx.payload.result;
      delete task.blocked_reason;
      task.updated_at = tx.created_at;
      return commit(next, tx);
    }

    case "task.block": {
      const task = next.tasks[tx.payload.task_id];
      if (!task) return rejected("TASK_NOT_FOUND", `Task ${tx.payload.task_id} does not exist`);
      if (task.status === "completed") return rejected("TASK_ALREADY_COMPLETED", `Completed task ${task.task_id} is terminal`);
      task.status = "blocked";
      task.blocked_reason = tx.payload.reason;
      task.updated_at = tx.created_at;
      return commit(next, tx);
    }

    case "decision.accept": {
      const p = tx.payload;
      if (next.decisions[p.decision_id]) return rejected("DECISION_EXISTS", `Decision ${p.decision_id} already exists`);
      next.decisions[p.decision_id] = {
        decision_id: p.decision_id,
        title: p.title,
        decision: p.decision,
        reason: p.reason,
        impacts: [...p.impacts],
        status: "accepted",
        created_at: tx.created_at,
        updated_at: tx.created_at
      };
      return commit(next, tx);
    }

    case "decision.supersede": {
      const p = tx.payload;
      if (p.decision_id === p.replacement_decision_id) return rejected("INVALID_REPLACEMENT", "A decision cannot supersede itself");
      const original = next.decisions[p.decision_id];
      const replacement = next.decisions[p.replacement_decision_id];
      if (!original) return rejected("DECISION_NOT_FOUND", `Decision ${p.decision_id} does not exist`);
      if (!replacement) return rejected("REPLACEMENT_NOT_FOUND", `Replacement ${p.replacement_decision_id} does not exist`);
      if (original.status !== "accepted" || replacement.status !== "accepted") {
        return rejected("INVALID_DECISION_TRANSITION", "Both decisions must currently be accepted");
      }
      original.status = "superseded";
      original.superseded_by = replacement.decision_id;
      original.superseded_reason = p.reason;
      original.updated_at = tx.created_at;
      return commit(next, tx);
    }

    case "plan.phase.create": {
      const p = tx.payload;
      if (next.plan_phases[p.phase_id]) return rejected("PHASE_EXISTS", `Phase ${p.phase_id} already exists`);
      const first = Object.keys(next.plan_phases).length === 0;
      next.plan_phases[p.phase_id] = {
        phase_id: p.phase_id,
        title: p.title,
        objective: p.objective,
        next_actions: [],
        status: first ? "active" : "pending",
        created_at: tx.created_at,
        updated_at: tx.created_at
      };
      if (first) next.current_phase_id = p.phase_id;
      return commit(next, tx);
    }

    case "plan.phase.update": {
      const p = tx.payload;
      const phase = next.plan_phases[p.phase_id];
      if (!phase) return rejected("PHASE_NOT_FOUND", `Phase ${p.phase_id} does not exist`);
      if (phase.status === "completed") return rejected("PHASE_COMPLETED", `Completed phase ${p.phase_id} is terminal`);
      if (p.title !== undefined) phase.title = p.title;
      if (p.objective !== undefined) phase.objective = p.objective;
      if (p.next_actions !== undefined) phase.next_actions = [...p.next_actions];
      phase.updated_at = tx.created_at;
      return commit(next, tx);
    }

    case "plan.phase.complete": {
      const phase = next.plan_phases[tx.payload.phase_id];
      if (!phase) return rejected("PHASE_NOT_FOUND", `Phase ${tx.payload.phase_id} does not exist`);
      if (phase.status === "completed") return rejected("PHASE_COMPLETED", `Phase ${phase.phase_id} is already completed`);
      phase.status = "completed";
      phase.updated_at = tx.created_at;
      const nextPhase = Object.values(next.plan_phases)
        .filter((candidate) => candidate.status === "pending")
        .sort((a, b) => a.phase_id.localeCompare(b.phase_id))[0];
      if (nextPhase) {
        nextPhase.status = "active";
        nextPhase.updated_at = tx.created_at;
        next.current_phase_id = nextPhase.phase_id;
      } else {
        next.current_phase_id = null;
      }
      return commit(next, tx);
    }

    case "constraint.add": {
      const p = tx.payload;
      if (next.constraints[p.constraint_id]) return rejected("CONSTRAINT_EXISTS", `Constraint ${p.constraint_id} already exists`);
      next.constraints[p.constraint_id] = {
        constraint_id: p.constraint_id,
        title: p.title,
        description: p.description,
        created_at: tx.created_at
      };
      return commit(next, tx);
    }

    case "research.add": {
      const p = tx.payload;
      if (next.research[p.research_id]) return rejected("RESEARCH_EXISTS", `Research ${p.research_id} already exists`);
      next.research[p.research_id] = {
        research_id: p.research_id,
        title: p.title,
        body: p.body,
        source: p.source,
        created_at: tx.created_at
      };
      return commit(next, tx);
    }

    case "deliverable.add": {
      const p = tx.payload;
      if (next.deliverables[p.deliverable_id]) return rejected("DELIVERABLE_EXISTS", `Deliverable ${p.deliverable_id} already exists`);
      next.deliverables[p.deliverable_id] = {
        deliverable_id: p.deliverable_id,
        title: p.title,
        description: p.description,
        reference: p.reference,
        status: "pending",
        created_at: tx.created_at,
        updated_at: tx.created_at
      };
      return commit(next, tx);
    }

    case "deliverable.complete": {
      const item = next.deliverables[tx.payload.deliverable_id];
      if (!item) return rejected("DELIVERABLE_NOT_FOUND", `Deliverable ${tx.payload.deliverable_id} does not exist`);
      if (item.status === "completed") return rejected("DELIVERABLE_COMPLETED", `Deliverable ${item.deliverable_id} is already completed`);
      item.status = "completed";
      item.outcome = tx.payload.outcome;
      item.updated_at = tx.created_at;
      return commit(next, tx);
    }
  }
}
