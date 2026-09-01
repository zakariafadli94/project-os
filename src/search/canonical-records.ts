import type {
  ConstraintRecord,
  DecisionRecord,
  DeliverableRecord,
  PlanPhaseRecord,
  ProjectState,
  ResearchRecord,
  TaskRecord
} from "../domain/project-state";
import type { CanonicalSearchRecord, SearchEntityType } from "./contract";
import { hashSearchValue } from "./hash";

interface CanonicalRecordInput {
  entity_type: SearchEntityType;
  entity_id: string;
  record_id: string;
  title: string;
  status?: string;
  phase_id?: string;
  body_text: string;
  updated_at?: string;
}

export async function buildCanonicalSearchRecords(state: ProjectState): Promise<CanonicalSearchRecord[]> {
  const inputs: CanonicalRecordInput[] = [
    projectRecord(state),
    ...Object.values(state.plan_phases).map(phaseRecord),
    ...Object.values(state.tasks).map(taskRecord),
    ...Object.values(state.decisions).map(decisionRecord),
    ...Object.values(state.research).map(researchRecord),
    ...Object.values(state.constraints).map(constraintRecord),
    ...Object.values(state.deliverables).map(deliverableRecord)
  ];

  const records = await Promise.all(inputs.map((input) => finalizeRecord(state, input)));
  return records.sort((left, right) => left.record_id.localeCompare(right.record_id));
}

function projectRecord(state: ProjectState): CanonicalRecordInput {
  return {
    entity_type: "project",
    entity_id: state.project_id,
    record_id: `project:${state.project_id}`,
    title: state.name,
    status: state.status,
    body_text: searchableText(
      state.objective,
      state.aliases,
      state.framing.scope,
      state.framing.out_of_scope,
      state.framing.success_criteria,
      state.framing.stakeholders,
      state.framing.open_questions,
      state.discovery.confirmed_findings.flatMap((finding) => [finding.summary, finding.research_ids]),
      state.discovery.provisional_findings.flatMap((finding) => [finding.summary, finding.research_ids]),
      state.discovery.unresolved_questions,
      state.discovery.next_exploration
    ),
    updated_at: state.updated_at
  };
}

function phaseRecord(phase: PlanPhaseRecord): CanonicalRecordInput {
  return {
    entity_type: "phase",
    entity_id: phase.phase_id,
    record_id: `phase:${phase.phase_id}`,
    title: phase.title,
    status: phase.status,
    phase_id: phase.phase_id,
    body_text: searchableText(phase.objective, phase.next_actions),
    updated_at: phase.updated_at
  };
}

function taskRecord(task: TaskRecord): CanonicalRecordInput {
  return {
    entity_type: "task",
    entity_id: task.task_id,
    record_id: `task:${task.task_id}`,
    title: task.title,
    status: task.status,
    ...(task.phase_id ? { phase_id: task.phase_id } : {}),
    body_text: searchableText(task.description, task.blocked_reason, task.result),
    updated_at: task.updated_at
  };
}

function decisionRecord(decision: DecisionRecord): CanonicalRecordInput {
  return {
    entity_type: "decision",
    entity_id: decision.decision_id,
    record_id: `decision:${decision.decision_id}`,
    title: decision.title,
    status: decision.status,
    body_text: searchableText(
      decision.decision,
      decision.reason,
      decision.impacts,
      decision.superseded_by,
      decision.superseded_reason
    ),
    updated_at: decision.updated_at
  };
}

function researchRecord(research: ResearchRecord): CanonicalRecordInput {
  return {
    entity_type: "research",
    entity_id: research.research_id,
    record_id: `research:${research.research_id}`,
    title: research.title,
    body_text: searchableText(research.body, research.source),
    updated_at: research.created_at
  };
}

function constraintRecord(constraint: ConstraintRecord): CanonicalRecordInput {
  return {
    entity_type: "constraint",
    entity_id: constraint.constraint_id,
    record_id: `constraint:${constraint.constraint_id}`,
    title: constraint.title,
    body_text: searchableText(constraint.description),
    updated_at: constraint.created_at
  };
}

function deliverableRecord(deliverable: DeliverableRecord): CanonicalRecordInput {
  return {
    entity_type: "deliverable",
    entity_id: deliverable.deliverable_id,
    record_id: `deliverable:${deliverable.deliverable_id}`,
    title: deliverable.title,
    status: deliverable.status,
    ...(deliverable.phase_id ? { phase_id: deliverable.phase_id } : {}),
    body_text: searchableText(
      deliverable.description,
      deliverable.reference,
      deliverable.outcome,
      deliverable.owner,
      deliverable.version,
      deliverable.decision_ids,
      deliverable.acceptance_note,
      deliverable.accepted_at,
      deliverable.superseded_by,
      deliverable.superseded_reason,
      deliverable.abandoned_reason
    ),
    updated_at: deliverable.updated_at
  };
}

async function finalizeRecord(state: ProjectState, input: CanonicalRecordInput): Promise<CanonicalSearchRecord> {
  const semantic = {
    project_id: state.project_id,
    record_id: input.record_id,
    record_kind: "canonical_entity" as const,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    title: input.title,
    ...(input.status ? { status: input.status } : {}),
    ...(input.phase_id ? { phase_id: input.phase_id } : {}),
    body_text: input.body_text,
    ...(input.updated_at ? { updated_at: input.updated_at } : {})
  };

  return {
    ...semantic,
    content_hash: await hashSearchValue(semantic),
    canonical_revision: state.revision,
    authority_ref: {
      kind: "canonical_entity",
      project_id: state.project_id,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      canonical_revision: state.revision
    }
  };
}

function searchableText(...values: unknown[]): string {
  const parts: string[] = [];
  for (const value of values) appendSearchable(parts, value);
  return parts.join("\n");
}

function appendSearchable(parts: string[], value: unknown): void {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized) parts.push(normalized);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) appendSearchable(parts, item);
  }
}
