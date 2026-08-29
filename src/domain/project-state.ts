export type ProjectStatus = "active" | "paused" | "completed" | "archived";
export type TaskStatus = "pending" | "active" | "blocked" | "completed";
export type PhaseStatus = "pending" | "active" | "completed";
export type DecisionStatus = "accepted" | "superseded";

export type DeliverableStatus =
  | "planned"
  | "in_progress"
  | "review"
  | "accepted"
  | "superseded"
  | "abandoned"
  | "legacy_completed";

export interface ProjectFraming {
  scope: string[];
  out_of_scope: string[];
  success_criteria: string[];
  stakeholders: string[];
  open_questions: string[];
}

export interface DiscoveryFinding {
  summary: string;
  research_ids: string[];
}

export interface DiscoverySynthesis {
  confirmed_findings: DiscoveryFinding[];
  provisional_findings: DiscoveryFinding[];
  unresolved_questions: string[];
  next_exploration: string[];
}

export interface ArtifactRouteRecord {
  route_id: string;
  source_prefix: string;
  target_prefix: string;
  archive_prefix?: string;
  exclusive: boolean;
  decision_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface ConstraintRecord {
  constraint_id: string;
  title: string;
  description: string;
  created_at: string;
}

export interface TaskRecord {
  task_id: string;
  title: string;
  description?: string;
  phase_id?: string;
  status: TaskStatus;
  blocked_reason?: string;
  result?: string;
  created_at: string;
  updated_at: string;
}

export interface PlanPhaseRecord {
  phase_id: string;
  title: string;
  objective?: string;
  next_actions: string[];
  status: PhaseStatus;
  created_at: string;
  updated_at: string;
}

export interface DecisionRecord {
  decision_id: string;
  title: string;
  decision: string;
  reason: string;
  impacts: string[];
  status: DecisionStatus;
  superseded_by?: string;
  superseded_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface ResearchRecord {
  research_id: string;
  title: string;
  body: string;
  source?: string;
  created_at: string;
}

export interface DeliverableRecord {
  deliverable_id: string;
  title: string;
  description?: string;
  reference?: string;
  outcome?: string;
  owner?: string;
  version?: string;
  phase_id?: string;
  decision_ids: string[];
  status: DeliverableStatus;
  acceptance_note?: string;
  accepted_at?: string;
  superseded_by?: string;
  superseded_reason?: string;
  abandoned_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectState {
  schema_version: "1.0" | "2.0";
  project_id: string;
  name: string;
  slug: string;
  aliases: string[];
  objective: string;
  framing: ProjectFraming;
  discovery: DiscoverySynthesis;
  status: ProjectStatus;
  revision: number;
  current_phase_id: string | null;
  artifact_routes: Record<string, ArtifactRouteRecord>;
  constraints: Record<string, ConstraintRecord>;
  tasks: Record<string, TaskRecord>;
  plan_phases: Record<string, PlanPhaseRecord>;
  decisions: Record<string, DecisionRecord>;
  research: Record<string, ResearchRecord>;
  deliverables: Record<string, DeliverableRecord>;
  last_event_id: string | null;
  created_at: string;
  updated_at: string;
}
