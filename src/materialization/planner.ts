import type { CanonicalCommitRecord } from "../domain/commit-record";
import type { ProjectionOutputEvidence } from "../domain/materialization";
import type {
  ConstraintRecord,
  DecisionRecord,
  ProjectState,
  ResearchRecord,
  TaskRecord
} from "../domain/project-state";
import { renderBrief } from "../render/brief";
import { renderConstraint } from "../render/constraint";
import { renderDecision } from "../render/decision";
import { renderDiscovery } from "../render/discovery";
import { renderHandoff, renderLegacyHandoff } from "../render/handoff";
import { OPERATING_CONTRACT_VERSION, renderOperating } from "../render/operating";
import { renderPlan } from "../render/plan";
import { renderProject } from "../render/project";
import { renderResearch } from "../render/research";
import { renderRoadmap } from "../render/roadmap";
import { renderState } from "../render/state";
import { renderTask } from "../render/task";
import { sha256Canonical, sha256Text } from "./hash";

export interface ProjectionBaseline {
  projection_version: number;
  outputs: ReadonlyMap<string, ProjectionOutputEvidence>;
}

export interface PlannedProjectionOutput extends ProjectionOutputEvidence {
  key: string;
  content: string;
  critical: boolean;
  baseline?: ProjectionOutputEvidence;
}

export interface ProjectionPlan {
  project_id: string;
  target_revision: number;
  projection_version: number;
  source_transaction_id: string;
  source_event_id: string;
  changed_outputs: Map<string, PlannedProjectionOutput>;
  carried_forward: Map<string, ProjectionOutputEvidence>;
  removed_outputs: string[];
  removed_output_evidence?: Map<string, ProjectionOutputEvidence>;
  expected_output_keys: string[];
}

interface OutputDescriptor {
  key: string;
  relative_path: string;
  critical: boolean;
  semantic_input: unknown;
  render: () => string;
  entity: boolean;
}

const GLOBAL_PATHS = {
  BRIEF: "BRIEF.md",
  DISCOVERY: "DISCOVERY.md",
  ROADMAP: "ROADMAP.md",
  PROJECT: "PROJECT.md",
  PLAN: "PLAN.md",
  OPERATING: "OPERATING.md",
  STATE: "STATE.md",
  HANDOFF: "HANDOFF.md"
} as const;

const identity = (state: ProjectState) => ({
  project_id: state.project_id,
  slug: state.slug,
  name: state.name
});

const semanticProjectState = (state: ProjectState) => {
  const { schema_version: _durableSchemaVersion, ...semantic } = state;
  return semantic;
};

const briefInput = (state: ProjectState) => ({
  ...identity(state),
  objective: state.objective,
  framing: {
    scope: state.framing.scope,
    out_of_scope: state.framing.out_of_scope,
    stakeholders: state.framing.stakeholders,
    success_criteria: state.framing.success_criteria,
    open_questions: state.framing.open_questions
  },
  constraints: Object.values(state.constraints)
    .sort((a, b) => a.constraint_id.localeCompare(b.constraint_id))
    .map(({ constraint_id, title, description }) => ({ constraint_id, title, description }))
});

const discoveryInput = (state: ProjectState) => {
  const researchIds = new Set([
    ...state.discovery.confirmed_findings.flatMap((finding) => finding.research_ids),
    ...state.discovery.provisional_findings.flatMap((finding) => finding.research_ids)
  ]);
  return {
    ...identity(state),
    discovery: state.discovery,
    research_titles: [...researchIds]
      .sort()
      .map((id) => ({ id, title: state.research[id]?.title ?? id })),
    accepted_decisions: Object.values(state.decisions)
      .filter((decision) => decision.status === "accepted")
      .sort((a, b) => a.decision_id.localeCompare(b.decision_id))
      .map(({ decision_id, title }) => ({ decision_id, title }))
  };
};

const roadmapInput = (state: ProjectState) => ({
  ...identity(state),
  current_phase_id: state.current_phase_id,
  phases: Object.values(state.plan_phases)
    .sort((a, b) => a.phase_id.localeCompare(b.phase_id))
    .map(({ phase_id, title, objective, next_actions, status }) => ({
      phase_id,
      title,
      objective,
      next_actions,
      status
    })),
  tasks: Object.values(state.tasks)
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map(({ task_id, title, status, blocked_reason }) => ({ task_id, title, status, blocked_reason })),
  deliverables: Object.values(state.deliverables)
    .sort((a, b) => a.deliverable_id.localeCompare(b.deliverable_id))
    .map(({ deliverable_id, title, status }) => ({ deliverable_id, title, status }))
});

const projectInput = (state: ProjectState) => ({
  ...identity(state),
  status: state.status,
  objective: state.objective,
  aliases: state.aliases,
  constraints: Object.values(state.constraints)
    .sort((a, b) => a.constraint_id.localeCompare(b.constraint_id))
    .map(({ constraint_id, title, description }) => ({ constraint_id, title, description }))
});

const planInput = (state: ProjectState) => ({
  ...identity(state),
  phases: Object.values(state.plan_phases)
    .sort((a, b) => a.phase_id.localeCompare(b.phase_id))
    .map(({ phase_id, title, objective, next_actions, status }) => ({
      phase_id,
      title,
      objective,
      next_actions,
      status
    })),
  tasks: Object.values(state.tasks)
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map(({ task_id, title, status, phase_id }) => ({ task_id, title, status, phase_id }))
});

function entityPath(folder: string, id: string): string {
  return `${folder}/${id}.md`;
}

function inputForEntity(state: ProjectState, record: ConstraintRecord | DecisionRecord | ResearchRecord | TaskRecord): unknown {
  return { ...identity(state), record };
}

function globalDescriptors(state: ProjectState, targetRevision: number, projectionVersion: number): OutputDescriptor[] {
  const descriptors: OutputDescriptor[] = [
    {
      key: "global:BRIEF",
      relative_path: GLOBAL_PATHS.BRIEF,
      critical: false,
      semantic_input: briefInput(state),
      render: () => renderBrief(state),
      entity: false
    },
    {
      key: "global:DISCOVERY",
      relative_path: GLOBAL_PATHS.DISCOVERY,
      critical: false,
      semantic_input: discoveryInput(state),
      render: () => renderDiscovery(state),
      entity: false
    },
    {
      key: "global:ROADMAP",
      relative_path: GLOBAL_PATHS.ROADMAP,
      critical: false,
      semantic_input: roadmapInput(state),
      render: () => renderRoadmap(state),
      entity: false
    },
    {
      key: "global:PROJECT",
      relative_path: GLOBAL_PATHS.PROJECT,
      critical: false,
      semantic_input: projectInput(state),
      render: () => renderProject(state),
      entity: false
    },
    {
      key: "global:PLAN",
      relative_path: GLOBAL_PATHS.PLAN,
      critical: false,
      semantic_input: planInput(state),
      render: () => renderPlan(state),
      entity: false
    }
  ];

  if (projectionVersion >= 2) {
    descriptors.push({
      key: "global:OPERATING",
      relative_path: GLOBAL_PATHS.OPERATING,
      critical: false,
      semantic_input: {
        ...identity(state),
        target_revision: targetRevision,
        operating_contract_version: OPERATING_CONTRACT_VERSION
      },
      render: () => renderOperating(state),
      entity: false
    });
  }

  const semanticState = semanticProjectState(state);
  descriptors.push(
    {
      key: "global:STATE",
      relative_path: GLOBAL_PATHS.STATE,
      critical: true,
      semantic_input: { target_revision: targetRevision, state: semanticState },
      render: () => renderState(state),
      entity: false
    },
    {
      key: "global:HANDOFF",
      relative_path: GLOBAL_PATHS.HANDOFF,
      critical: true,
      semantic_input: projectionVersion >= 2
        ? { target_revision: targetRevision, state: semanticState, operating_contract_version: OPERATING_CONTRACT_VERSION }
        : { target_revision: targetRevision, state: semanticState },
      render: () => projectionVersion >= 2 ? renderHandoff(state) : renderLegacyHandoff(state),
      entity: false
    }
  );
  return descriptors;
}

function entityDescriptors(state: ProjectState): OutputDescriptor[] {
  const descriptors: OutputDescriptor[] = [];
  for (const id of Object.keys(state.decisions).sort()) {
    const record = state.decisions[id];
    descriptors.push({
      key: `decision:${id}`,
      relative_path: entityPath("DECISIONS", id),
      critical: false,
      semantic_input: inputForEntity(state, record),
      render: () => renderDecision(state, record),
      entity: true
    });
  }
  for (const id of Object.keys(state.constraints).sort()) {
    const record = state.constraints[id];
    descriptors.push({
      key: `constraint:${id}`,
      relative_path: entityPath("CONSTRAINTS", id),
      critical: false,
      semantic_input: inputForEntity(state, record),
      render: () => renderConstraint(state, record),
      entity: true
    });
  }
  for (const id of Object.keys(state.tasks).sort()) {
    const record = state.tasks[id];
    descriptors.push({
      key: `task:${id}`,
      relative_path: entityPath("TASKS", id),
      critical: false,
      semantic_input: inputForEntity(state, record),
      render: () => renderTask(state, record),
      entity: true
    });
  }
  for (const id of Object.keys(state.research).sort()) {
    const record = state.research[id];
    descriptors.push({
      key: `research:${id}`,
      relative_path: entityPath("RESEARCH", id),
      critical: false,
      semantic_input: inputForEntity(state, record),
      render: () => renderResearch(state, record),
      entity: true
    });
  }
  return descriptors;
}

function affectedEntityKeys(record: CanonicalCommitRecord): Set<string> {
  const tx = record.transaction;
  switch (tx.operation) {
    case "decision.accept":
    case "decision.supersede":
      return new Set([`decision:${tx.payload.decision_id}`]);
    case "task.create":
    case "task.start":
    case "task.complete":
    case "task.block":
      return new Set([`task:${tx.payload.task_id}`]);
    case "constraint.add":
      return new Set([`constraint:${tx.payload.constraint_id}`]);
    case "research.add":
      return new Set([`research:${tx.payload.research_id}`]);
    default:
      return new Set();
  }
}

async function semanticHash(value: unknown, projectionVersion: number): Promise<string> {
  return sha256Canonical({ projection_version: projectionVersion, semantic_input: value });
}

export async function planProjection(
  record: CanonicalCommitRecord,
  baseline: ProjectionBaseline | null,
  projectionVersion: number
): Promise<ProjectionPlan> {
  if (!Number.isSafeInteger(projectionVersion) || projectionVersion < 1) {
    throw new Error(`Invalid projection version: ${projectionVersion}`);
  }

  const state = record.state;
  const changed_outputs = new Map<string, PlannedProjectionOutput>();
  const carried_forward = new Map<string, ProjectionOutputEvidence>();
  const globals = globalDescriptors(state, record.new_revision, projectionVersion);
  const entities = entityDescriptors(state);
  const descriptors = [...globals, ...entities];
  const expected = new Set(descriptors.map((item) => item.key));
  const full = baseline === null || baseline.projection_version !== projectionVersion;
  const affected = affectedEntityKeys(record);

  for (const descriptor of descriptors) {
    const previous = baseline?.outputs.get(descriptor.key);
    const shouldFingerprint = !descriptor.entity
      || full
      || affected.has(descriptor.key)
      || previous === undefined
      || previous.relative_path !== descriptor.relative_path;

    if (!shouldFingerprint && previous) {
      carried_forward.set(descriptor.key, previous);
      continue;
    }

    const input_hash = await semanticHash(descriptor.semantic_input, projectionVersion);
    if (!descriptor.critical && !full && previous && previous.input_hash === input_hash && previous.relative_path === descriptor.relative_path) {
      carried_forward.set(descriptor.key, previous);
      continue;
    }

    const content = descriptor.render();
    const content_hash = await sha256Text(content);
    changed_outputs.set(descriptor.key, {
      key: descriptor.key,
      relative_path: descriptor.relative_path,
      input_hash,
      content_hash,
      source_revision: record.new_revision,
      content,
      critical: descriptor.critical,
      ...(previous ? { baseline: previous } : {})
    });
  }

  const removed_outputs = baseline
    ? [...baseline.outputs.keys()].filter((key) => !expected.has(key)).sort()
    : [];
  const removed_output_evidence = new Map<string, ProjectionOutputEvidence>();
  for (const key of removed_outputs) {
    const evidence = baseline?.outputs.get(key);
    if (evidence) removed_output_evidence.set(key, evidence);
  }

  return {
    project_id: record.project_id,
    target_revision: record.new_revision,
    projection_version: projectionVersion,
    source_transaction_id: record.transaction.transaction_id,
    source_event_id: record.event.event_id,
    changed_outputs,
    carried_forward,
    removed_outputs,
    removed_output_evidence,
    expected_output_keys: [...expected]
  };
}