import type {
  ArtifactRouteRecord,
  ConstraintRecord,
  DecisionRecord,
  DeliverableRecord,
  DeliverableStatus,
  DiscoveryFinding,
  DiscoverySynthesis,
  PlanPhaseRecord,
  ProjectFraming,
  ProjectState,
  ResearchRecord,
  TaskRecord
} from "./project-state";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requireString(value, name);
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function requireNullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requireString(value, name);
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a string array`);
  }
  return [...value];
}

function optionalStringArray(value: unknown, name: string): string[] {
  return value === undefined ? [] : requireStringArray(value, name);
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${name} is invalid`);
  }
  return value as T;
}

function normalizeFraming(value: unknown): ProjectFraming {
  if (value === undefined) {
    return { scope: [], out_of_scope: [], success_criteria: [], stakeholders: [], open_questions: [] };
  }
  const input = requireRecord(value, "framing");
  return {
    scope: optionalStringArray(input.scope, "framing.scope"),
    out_of_scope: optionalStringArray(input.out_of_scope, "framing.out_of_scope"),
    success_criteria: optionalStringArray(input.success_criteria, "framing.success_criteria"),
    stakeholders: optionalStringArray(input.stakeholders, "framing.stakeholders"),
    open_questions: optionalStringArray(input.open_questions, "framing.open_questions")
  };
}

function normalizeFinding(value: unknown, name: string): DiscoveryFinding {
  const input = requireRecord(value, name);
  return {
    summary: requireString(input.summary, `${name}.summary`),
    research_ids: optionalStringArray(input.research_ids, `${name}.research_ids`)
  };
}

function normalizeFindingArray(value: unknown, name: string): DiscoveryFinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => normalizeFinding(item, `${name}[${index}]`));
}

function normalizeDiscovery(value: unknown): DiscoverySynthesis {
  if (value === undefined) {
    return { confirmed_findings: [], provisional_findings: [], unresolved_questions: [], next_exploration: [] };
  }
  const input = requireRecord(value, "discovery");
  return {
    confirmed_findings: normalizeFindingArray(input.confirmed_findings, "discovery.confirmed_findings"),
    provisional_findings: normalizeFindingArray(input.provisional_findings, "discovery.provisional_findings"),
    unresolved_questions: optionalStringArray(input.unresolved_questions, "discovery.unresolved_questions"),
    next_exploration: optionalStringArray(input.next_exploration, "discovery.next_exploration")
  };
}

function normalizeArtifactRoute(value: unknown, key: string): ArtifactRouteRecord {
  const name = `artifact_routes.${key}`;
  const input = requireRecord(value, name);
  const routeId = requireString(input.route_id, `${name}.route_id`);
  if (routeId !== key) throw new Error(`${name}.route_id must match its record key`);
  return {
    route_id: routeId,
    source_prefix: requireString(input.source_prefix, `${name}.source_prefix`),
    target_prefix: requireString(input.target_prefix, `${name}.target_prefix`),
    archive_prefix: optionalString(input.archive_prefix, `${name}.archive_prefix`),
    exclusive: requireBoolean(input.exclusive, `${name}.exclusive`),
    decision_ids: requireStringArray(input.decision_ids, `${name}.decision_ids`),
    created_at: requireString(input.created_at, `${name}.created_at`),
    updated_at: requireString(input.updated_at, `${name}.updated_at`)
  };
}

function normalizeConstraint(value: unknown, key: string): ConstraintRecord {
  const name = `constraints.${key}`;
  const input = requireRecord(value, name);
  const constraintId = requireString(input.constraint_id, `${name}.constraint_id`);
  if (constraintId !== key) throw new Error(`${name}.constraint_id must match its record key`);
  return {
    constraint_id: constraintId,
    title: requireString(input.title, `${name}.title`),
    description: requireString(input.description, `${name}.description`),
    created_at: requireString(input.created_at, `${name}.created_at`)
  };
}

function normalizeTask(value: unknown, key: string): TaskRecord {
  const name = `tasks.${key}`;
  const input = requireRecord(value, name);
  const taskId = requireString(input.task_id, `${name}.task_id`);
  if (taskId !== key) throw new Error(`${name}.task_id must match its record key`);
  return {
    task_id: taskId,
    title: requireString(input.title, `${name}.title`),
    description: optionalString(input.description, `${name}.description`),
    phase_id: optionalString(input.phase_id, `${name}.phase_id`),
    status: requireEnum(input.status, ["pending", "active", "blocked", "completed"] as const, `${name}.status`),
    blocked_reason: optionalString(input.blocked_reason, `${name}.blocked_reason`),
    result: optionalString(input.result, `${name}.result`),
    created_at: requireString(input.created_at, `${name}.created_at`),
    updated_at: requireString(input.updated_at, `${name}.updated_at`)
  };
}

function normalizePhase(value: unknown, key: string): PlanPhaseRecord {
  const name = `plan_phases.${key}`;
  const input = requireRecord(value, name);
  const phaseId = requireString(input.phase_id, `${name}.phase_id`);
  if (phaseId !== key) throw new Error(`${name}.phase_id must match its record key`);
  return {
    phase_id: phaseId,
    title: requireString(input.title, `${name}.title`),
    objective: optionalString(input.objective, `${name}.objective`),
    next_actions: requireStringArray(input.next_actions, `${name}.next_actions`),
    status: requireEnum(input.status, ["pending", "active", "completed"] as const, `${name}.status`),
    created_at: requireString(input.created_at, `${name}.created_at`),
    updated_at: requireString(input.updated_at, `${name}.updated_at`)
  };
}

function normalizeDecision(value: unknown, key: string): DecisionRecord {
  const name = `decisions.${key}`;
  const input = requireRecord(value, name);
  const decisionId = requireString(input.decision_id, `${name}.decision_id`);
  if (decisionId !== key) throw new Error(`${name}.decision_id must match its record key`);
  return {
    decision_id: decisionId,
    title: requireString(input.title, `${name}.title`),
    decision: requireString(input.decision, `${name}.decision`),
    reason: requireString(input.reason, `${name}.reason`),
    impacts: requireStringArray(input.impacts, `${name}.impacts`),
    status: requireEnum(input.status, ["accepted", "superseded"] as const, `${name}.status`),
    superseded_by: optionalString(input.superseded_by, `${name}.superseded_by`),
    superseded_reason: optionalString(input.superseded_reason, `${name}.superseded_reason`),
    created_at: requireString(input.created_at, `${name}.created_at`),
    updated_at: requireString(input.updated_at, `${name}.updated_at`)
  };
}

function normalizeResearch(value: unknown, key: string): ResearchRecord {
  const name = `research.${key}`;
  const input = requireRecord(value, name);
  const researchId = requireString(input.research_id, `${name}.research_id`);
  if (researchId !== key) throw new Error(`${name}.research_id must match its record key`);
  return {
    research_id: researchId,
    title: requireString(input.title, `${name}.title`),
    body: requireString(input.body, `${name}.body`),
    source: optionalString(input.source, `${name}.source`),
    created_at: requireString(input.created_at, `${name}.created_at`)
  };
}

function normalizeDeliverableStatus(value: unknown): DeliverableStatus {
  if (value === "pending") return "planned";
  if (value === "completed") return "legacy_completed";
  return requireEnum(
    value,
    ["planned", "in_progress", "review", "accepted", "superseded", "abandoned", "legacy_completed"] as const,
    "deliverable.status"
  );
}

function normalizeDeliverable(value: unknown, key: string): DeliverableRecord {
  const name = `deliverables.${key}`;
  const input = requireRecord(value, name);
  const deliverableId = requireString(input.deliverable_id, `${name}.deliverable_id`);
  if (deliverableId !== key) throw new Error(`${name}.deliverable_id must match its record key`);
  return {
    deliverable_id: deliverableId,
    title: requireString(input.title, `${name}.title`),
    description: optionalString(input.description, `${name}.description`),
    reference: optionalString(input.reference, `${name}.reference`),
    outcome: optionalString(input.outcome, `${name}.outcome`),
    owner: optionalString(input.owner, `${name}.owner`),
    version: optionalString(input.version, `${name}.version`),
    phase_id: optionalString(input.phase_id, `${name}.phase_id`),
    decision_ids: optionalStringArray(input.decision_ids, `${name}.decision_ids`),
    status: normalizeDeliverableStatus(input.status),
    acceptance_note: optionalString(input.acceptance_note, `${name}.acceptance_note`),
    accepted_at: optionalString(input.accepted_at, `${name}.accepted_at`),
    superseded_by: optionalString(input.superseded_by, `${name}.superseded_by`),
    superseded_reason: optionalString(input.superseded_reason, `${name}.superseded_reason`),
    abandoned_reason: optionalString(input.abandoned_reason, `${name}.abandoned_reason`),
    created_at: requireString(input.created_at, `${name}.created_at`),
    updated_at: requireString(input.updated_at, `${name}.updated_at`)
  };
}

function normalizeRecordMap<T>(
  value: unknown,
  name: string,
  normalizer: (item: unknown, key: string) => T
): Record<string, T> {
  const input = requireRecord(value, name);
  return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, normalizer(item, key)]));
}

function normalizeOptionalRecordMap<T>(
  value: unknown,
  name: string,
  normalizer: (item: unknown, key: string) => T
): Record<string, T> {
  if (value === undefined) return {};
  return normalizeRecordMap(value, name, normalizer);
}

export function normalizeProjectState(input: unknown): ProjectState {
  const raw = requireRecord(input, "project state");
  const schemaVersion = requireEnum(raw.schema_version, ["1.0", "2.0"] as const, "schema_version");

  const projectId = requireString(raw.project_id, "project_id");
  if (!/^PRJ-[0-9]{4,}$/.test(projectId)) throw new Error("Invalid project_id");

  const status = requireEnum(raw.status, ["active", "paused", "completed", "archived"] as const, "status");
  if (!Number.isInteger(raw.revision) || (raw.revision as number) < 0) throw new Error("revision must be a non-negative integer");

  const planPhases = normalizeRecordMap(raw.plan_phases, "plan_phases", normalizePhase);
  const currentPhaseId = requireNullableString(raw.current_phase_id, "current_phase_id");
  if (currentPhaseId !== null && !planPhases[currentPhaseId]) {
    throw new Error("current_phase_id must reference an existing plan phase");
  }

  return {
    schema_version: schemaVersion,
    project_id: projectId,
    name: requireString(raw.name, "name"),
    slug: requireString(raw.slug, "slug"),
    aliases: requireStringArray(raw.aliases, "aliases"),
    objective: requireString(raw.objective, "objective"),
    framing: normalizeFraming(raw.framing),
    discovery: normalizeDiscovery(raw.discovery),
    status,
    revision: raw.revision as number,
    current_phase_id: currentPhaseId,
    artifact_routes: normalizeOptionalRecordMap(raw.artifact_routes, "artifact_routes", normalizeArtifactRoute),
    constraints: normalizeRecordMap(raw.constraints, "constraints", normalizeConstraint),
    tasks: normalizeRecordMap(raw.tasks, "tasks", normalizeTask),
    plan_phases: planPhases,
    decisions: normalizeRecordMap(raw.decisions, "decisions", normalizeDecision),
    research: normalizeRecordMap(raw.research, "research", normalizeResearch),
    deliverables: normalizeRecordMap(raw.deliverables, "deliverables", normalizeDeliverable),
    last_event_id: requireNullableString(raw.last_event_id, "last_event_id"),
    created_at: requireString(raw.created_at, "created_at"),
    updated_at: requireString(raw.updated_at, "updated_at")
  };
}
