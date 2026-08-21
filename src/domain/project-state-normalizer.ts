import type {
  DeliverableRecord,
  DeliverableStatus,
  DiscoveryFinding,
  DiscoverySynthesis,
  ProjectFraming,
  ProjectState
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

function normalizeDeliverableStatus(value: unknown): DeliverableStatus {
  if (value === "pending") return "planned";
  if (value === "completed") return "legacy_completed";
  const allowed: DeliverableStatus[] = [
    "planned",
    "in_progress",
    "review",
    "accepted",
    "superseded",
    "abandoned",
    "legacy_completed"
  ];
  if (allowed.includes(value as DeliverableStatus)) return value as DeliverableStatus;
  throw new Error(`Invalid deliverable status: ${String(value)}`);
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requireString(value, name);
}

function normalizeDeliverable(value: unknown, key: string): DeliverableRecord {
  const input = requireRecord(value, `deliverables.${key}`);
  return {
    deliverable_id: requireString(input.deliverable_id, `deliverables.${key}.deliverable_id`),
    title: requireString(input.title, `deliverables.${key}.title`),
    description: optionalString(input.description, `deliverables.${key}.description`),
    reference: optionalString(input.reference, `deliverables.${key}.reference`),
    outcome: optionalString(input.outcome, `deliverables.${key}.outcome`),
    owner: optionalString(input.owner, `deliverables.${key}.owner`),
    version: optionalString(input.version, `deliverables.${key}.version`),
    phase_id: optionalString(input.phase_id, `deliverables.${key}.phase_id`),
    decision_ids: optionalStringArray(input.decision_ids, `deliverables.${key}.decision_ids`),
    status: normalizeDeliverableStatus(input.status),
    acceptance_note: optionalString(input.acceptance_note, `deliverables.${key}.acceptance_note`),
    accepted_at: optionalString(input.accepted_at, `deliverables.${key}.accepted_at`),
    supersedes: optionalString(input.supersedes, `deliverables.${key}.supersedes`),
    superseded_by: optionalString(input.superseded_by, `deliverables.${key}.superseded_by`),
    superseded_reason: optionalString(input.superseded_reason, `deliverables.${key}.superseded_reason`),
    abandoned_reason: optionalString(input.abandoned_reason, `deliverables.${key}.abandoned_reason`),
    created_at: requireString(input.created_at, `deliverables.${key}.created_at`),
    updated_at: requireString(input.updated_at, `deliverables.${key}.updated_at`)
  };
}

function normalizeDeliverables(value: unknown): Record<string, DeliverableRecord> {
  const input = requireRecord(value, "deliverables");
  return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, normalizeDeliverable(item, key)]));
}

export function normalizeProjectState(input: unknown): ProjectState {
  const raw = requireRecord(input, "project state");
  if (raw.schema_version !== "1.0") throw new Error("Unsupported project state schema_version");

  const projectId = requireString(raw.project_id, "project_id");
  if (!/^PRJ-[0-9]{4,}$/.test(projectId)) throw new Error("Invalid project_id");

  const status = requireString(raw.status, "status");
  if (!["active", "paused", "completed", "archived"].includes(status)) throw new Error("Invalid project status");
  if (!Number.isInteger(raw.revision) || (raw.revision as number) < 0) throw new Error("revision must be a non-negative integer");

  const constraints = requireRecord(raw.constraints, "constraints");
  const tasks = requireRecord(raw.tasks, "tasks");
  const planPhases = requireRecord(raw.plan_phases, "plan_phases");
  const decisions = requireRecord(raw.decisions, "decisions");
  const research = requireRecord(raw.research, "research");

  return {
    schema_version: "1.0",
    project_id: projectId,
    name: requireString(raw.name, "name"),
    slug: requireString(raw.slug, "slug"),
    aliases: requireStringArray(raw.aliases, "aliases"),
    objective: requireString(raw.objective, "objective"),
    framing: normalizeFraming(raw.framing),
    discovery: normalizeDiscovery(raw.discovery),
    status: status as ProjectState["status"],
    revision: raw.revision as number,
    current_phase_id: requireNullableString(raw.current_phase_id, "current_phase_id"),
    constraints: structuredClone(constraints) as ProjectState["constraints"],
    tasks: structuredClone(tasks) as ProjectState["tasks"],
    plan_phases: structuredClone(planPhases) as ProjectState["plan_phases"],
    decisions: structuredClone(decisions) as ProjectState["decisions"],
    research: structuredClone(research) as ProjectState["research"],
    deliverables: normalizeDeliverables(raw.deliverables),
    last_event_id: requireNullableString(raw.last_event_id, "last_event_id"),
    created_at: requireString(raw.created_at, "created_at"),
    updated_at: requireString(raw.updated_at, "updated_at")
  };
}
