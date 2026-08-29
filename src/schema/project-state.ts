import { z } from "zod";
import { normalizeProjectState } from "../domain/project-state-normalizer";
import type { ProjectState } from "../domain/project-state";
import type { SchemaWriterStage } from "./writer-stage";
import { writesCoreV2 } from "./writer-stage";
import { unsupportedSchemaVersion } from "./version";

const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const timestamp = z.string().datetime({ offset: true });
const nonEmptyString = z.string().min(1);
const recordUnknown = z.record(z.string(), z.unknown());

const projectStateV1Schema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: projectId,
  name: z.string(),
  slug: z.string(),
  aliases: z.array(z.string()),
  objective: z.string(),
  framing: z.unknown().optional(),
  discovery: z.unknown().optional(),
  status: z.enum(["active", "paused", "completed", "archived"]),
  revision: z.number().int().nonnegative(),
  current_phase_id: z.string().nullable(),
  artifact_routes: recordUnknown.optional(),
  constraints: recordUnknown,
  tasks: recordUnknown,
  plan_phases: recordUnknown,
  decisions: recordUnknown,
  research: recordUnknown,
  deliverables: recordUnknown,
  last_event_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string()
});

const framingV2Schema = z.strictObject({
  scope: z.array(z.string()),
  out_of_scope: z.array(z.string()),
  success_criteria: z.array(z.string()),
  stakeholders: z.array(z.string()),
  open_questions: z.array(z.string())
});

const discoveryFindingV2Schema = z.strictObject({
  summary: z.string(),
  research_ids: z.array(z.string())
});

const discoveryV2Schema = z.strictObject({
  confirmed_findings: z.array(discoveryFindingV2Schema),
  provisional_findings: z.array(discoveryFindingV2Schema),
  unresolved_questions: z.array(z.string()),
  next_exploration: z.array(z.string())
});

const artifactRouteV2Schema = z.strictObject({
  route_id: nonEmptyString,
  source_prefix: nonEmptyString,
  target_prefix: nonEmptyString,
  archive_prefix: nonEmptyString.optional(),
  exclusive: z.boolean(),
  decision_ids: z.array(z.string()),
  created_at: timestamp,
  updated_at: timestamp
});

const constraintV2Schema = z.strictObject({
  constraint_id: nonEmptyString,
  title: z.string(),
  description: z.string(),
  created_at: timestamp
});

const taskV2Schema = z.strictObject({
  task_id: nonEmptyString,
  title: z.string(),
  description: z.string().optional(),
  phase_id: z.string().optional(),
  status: z.enum(["pending", "active", "blocked", "completed"]),
  blocked_reason: z.string().optional(),
  result: z.string().optional(),
  created_at: timestamp,
  updated_at: timestamp
});

const phaseV2Schema = z.strictObject({
  phase_id: nonEmptyString,
  title: z.string(),
  objective: z.string().optional(),
  next_actions: z.array(z.string()),
  status: z.enum(["pending", "active", "completed"]),
  created_at: timestamp,
  updated_at: timestamp
});

const decisionV2Schema = z.strictObject({
  decision_id: nonEmptyString,
  title: z.string(),
  decision: z.string(),
  reason: z.string(),
  impacts: z.array(z.string()),
  status: z.enum(["accepted", "superseded"]),
  superseded_by: z.string().optional(),
  superseded_reason: z.string().optional(),
  created_at: timestamp,
  updated_at: timestamp
});

const researchV2Schema = z.strictObject({
  research_id: nonEmptyString,
  title: z.string(),
  body: z.string(),
  source: z.string().optional(),
  created_at: timestamp
});

const deliverableV2Schema = z.strictObject({
  deliverable_id: nonEmptyString,
  title: z.string(),
  description: z.string().optional(),
  reference: z.string().optional(),
  outcome: z.string().optional(),
  owner: z.string().optional(),
  version: z.string().optional(),
  phase_id: z.string().optional(),
  decision_ids: z.array(z.string()),
  status: z.enum([
    "planned",
    "in_progress",
    "review",
    "accepted",
    "superseded",
    "abandoned",
    "legacy_completed"
  ]),
  acceptance_note: z.string().optional(),
  accepted_at: timestamp.optional(),
  superseded_by: z.string().optional(),
  superseded_reason: z.string().optional(),
  abandoned_reason: z.string().optional(),
  created_at: timestamp,
  updated_at: timestamp
});

const projectStateV2Schema = z.strictObject({
  schema_version: z.literal("2.0"),
  project_id: projectId,
  name: z.string(),
  slug: z.string(),
  aliases: z.array(z.string()),
  objective: z.string(),
  framing: framingV2Schema,
  discovery: discoveryV2Schema,
  status: z.enum(["active", "paused", "completed", "archived"]),
  revision: z.number().int().nonnegative(),
  current_phase_id: z.string().nullable(),
  artifact_routes: z.record(z.string(), artifactRouteV2Schema),
  constraints: z.record(z.string(), constraintV2Schema),
  tasks: z.record(z.string(), taskV2Schema),
  plan_phases: z.record(z.string(), phaseV2Schema),
  decisions: z.record(z.string(), decisionV2Schema),
  research: z.record(z.string(), researchV2Schema),
  deliverables: z.record(z.string(), deliverableV2Schema),
  last_event_id: z.string().nullable(),
  created_at: timestamp,
  updated_at: timestamp
});

export interface ProjectStateReadResult {
  sourceVersion: "1.0" | "2.0";
  state: ProjectState;
}

function requireRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("ProjectState must be an object");
  }
  return input as Record<string, unknown>;
}

export function migrateProjectStateV1ToCurrent(input: unknown): ProjectState {
  const parsed = projectStateV1Schema.parse(input);
  return normalizeProjectState(parsed);
}

function readProjectStateV2(input: unknown): ProjectState {
  const parsed = projectStateV2Schema.parse(input);
  const normalized = normalizeProjectState({ ...parsed, schema_version: "1.0" });
  return { ...normalized, schema_version: "2.0" };
}

export function readProjectState(input: unknown): ProjectStateReadResult {
  const raw = requireRecord(input);
  if (raw.schema_version === "1.0") {
    return {
      sourceVersion: "1.0",
      state: migrateProjectStateV1ToCurrent(raw)
    };
  }
  if (raw.schema_version === "2.0") {
    return {
      sourceVersion: "2.0",
      state: readProjectStateV2(raw)
    };
  }
  return unsupportedSchemaVersion("ProjectState", raw.schema_version);
}

export function encodeProjectState(
  state: ProjectState,
  stage: SchemaWriterStage
): unknown {
  if (!writesCoreV2(stage)) {
    if (state.schema_version === "2.0") {
      throw new Error("ProjectState V2 writer regression to V1 is forbidden");
    }
    return projectStateV1Schema.parse({ ...state, schema_version: "1.0" });
  }

  const encoded = { ...state, schema_version: "2.0" as const };
  return projectStateV2Schema.parse(encoded);
}
