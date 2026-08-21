import { z } from "zod";

const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const transactionId = z.string().regex(/^TXN-[A-Z0-9-]{10,}$/);
const stableId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-[A-Z0-9]{4,}$`));
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const nonEmpty = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });

export const AUTO_PROJECT_ID = "PRJ-AUTO" as const;

export const operationValues = [
  "project.create",
  "project.pause",
  "project.resume",
  "project.complete",
  "project.archive",
  "project.framing.update",
  "decision.accept",
  "decision.supersede",
  "task.create",
  "task.start",
  "task.complete",
  "task.block",
  "plan.phase.create",
  "plan.phase.update",
  "plan.phase.complete",
  "constraint.add",
  "research.add",
  "discovery.synthesis.update",
  "deliverable.create",
  "deliverable.start",
  "deliverable.revise",
  "deliverable.submit_review",
  "deliverable.accept",
  "deliverable.supersede",
  "deliverable.abandon",
  "deliverable.add",
  "deliverable.complete"
] as const;

const baseCommon = {
  schema_version: z.literal("1.0"),
  transaction_id: transactionId,
  base_revision: z.number().int().nonnegative(),
  created_at: timestamp
};
const common = { ...baseCommon, project_id: projectId };

const projectCreate = z.strictObject({
  ...baseCommon,
  project_id: z.union([projectId, z.literal(AUTO_PROJECT_ID)]),
  operation: z.literal("project.create"),
  payload: z.strictObject({
    name: nonEmpty,
    slug,
    aliases: z.array(nonEmpty).default([]),
    objective: nonEmpty
  })
});

const projectPause = z.strictObject({ ...common, operation: z.literal("project.pause"), payload: z.strictObject({ reason: nonEmpty }) });
const projectResume = z.strictObject({ ...common, operation: z.literal("project.resume"), payload: z.strictObject({ reason: nonEmpty.optional() }) });
const projectComplete = z.strictObject({ ...common, operation: z.literal("project.complete"), payload: z.strictObject({ summary: nonEmpty.optional() }) });
const projectArchive = z.strictObject({ ...common, operation: z.literal("project.archive"), payload: z.strictObject({ reason: nonEmpty }) });
const projectFramingUpdate = z.strictObject({
  ...common,
  operation: z.literal("project.framing.update"),
  payload: z.strictObject({
    objective: nonEmpty.optional(),
    scope: z.array(nonEmpty).optional(),
    out_of_scope: z.array(nonEmpty).optional(),
    success_criteria: z.array(nonEmpty).optional(),
    stakeholders: z.array(nonEmpty).optional(),
    open_questions: z.array(nonEmpty).optional()
  }).refine(
    (value) => Object.values(value).some((item) => item !== undefined),
    { message: "project.framing.update requires at least one change" }
  )
});

const decisionAccept = z.strictObject({
  ...common,
  operation: z.literal("decision.accept"),
  payload: z.strictObject({ decision_id: stableId("DEC"), title: nonEmpty, decision: nonEmpty, reason: nonEmpty, impacts: z.array(nonEmpty).default([]) })
});
const decisionSupersede = z.strictObject({
  ...common,
  operation: z.literal("decision.supersede"),
  payload: z.strictObject({ decision_id: stableId("DEC"), replacement_decision_id: stableId("DEC"), reason: nonEmpty })
});

const taskCreate = z.strictObject({
  ...common,
  operation: z.literal("task.create"),
  payload: z.strictObject({ task_id: stableId("TASK"), title: nonEmpty, description: nonEmpty.optional(), phase_id: stableId("PHASE").optional() })
});
const taskStart = z.strictObject({ ...common, operation: z.literal("task.start"), payload: z.strictObject({ task_id: stableId("TASK") }) });
const taskComplete = z.strictObject({ ...common, operation: z.literal("task.complete"), payload: z.strictObject({ task_id: stableId("TASK"), result: nonEmpty.optional() }) });
const taskBlock = z.strictObject({ ...common, operation: z.literal("task.block"), payload: z.strictObject({ task_id: stableId("TASK"), reason: nonEmpty }) });

const phaseCreate = z.strictObject({
  ...common,
  operation: z.literal("plan.phase.create"),
  payload: z.strictObject({ phase_id: stableId("PHASE"), title: nonEmpty, objective: nonEmpty.optional() })
});
const phaseUpdate = z.strictObject({
  ...common,
  operation: z.literal("plan.phase.update"),
  payload: z.strictObject({ phase_id: stableId("PHASE"), title: nonEmpty.optional(), objective: nonEmpty.optional(), next_actions: z.array(nonEmpty).optional() }).refine(
    (value) => value.title !== undefined || value.objective !== undefined || value.next_actions !== undefined,
    { message: "plan.phase.update requires at least one change" }
  )
});
const phaseComplete = z.strictObject({ ...common, operation: z.literal("plan.phase.complete"), payload: z.strictObject({ phase_id: stableId("PHASE") }) });

const constraintAdd = z.strictObject({
  ...common,
  operation: z.literal("constraint.add"),
  payload: z.strictObject({ constraint_id: stableId("CON"), title: nonEmpty, description: nonEmpty })
});
const researchAdd = z.strictObject({
  ...common,
  operation: z.literal("research.add"),
  payload: z.strictObject({ research_id: stableId("RES"), title: nonEmpty, body: nonEmpty, source: nonEmpty.optional() })
});

const discoveryFinding = z.strictObject({
  summary: nonEmpty,
  research_ids: z.array(stableId("RES")).default([])
});
const discoverySynthesisUpdate = z.strictObject({
  ...common,
  operation: z.literal("discovery.synthesis.update"),
  payload: z.strictObject({
    confirmed_findings: z.array(discoveryFinding).optional(),
    provisional_findings: z.array(discoveryFinding).optional(),
    unresolved_questions: z.array(nonEmpty).optional(),
    next_exploration: z.array(nonEmpty).optional()
  }).refine(
    (value) => Object.values(value).some((item) => item !== undefined),
    { message: "discovery.synthesis.update requires at least one change" }
  )
});

const deliverableCreate = z.strictObject({
  ...common,
  operation: z.literal("deliverable.create"),
  payload: z.strictObject({
    deliverable_id: stableId("DEL"),
    title: nonEmpty,
    version: nonEmpty,
    description: nonEmpty.optional(),
    reference: nonEmpty.optional(),
    owner: nonEmpty.optional(),
    phase_id: stableId("PHASE").optional(),
    decision_ids: z.array(stableId("DEC")).default([])
  })
});
const deliverableStart = z.strictObject({
  ...common,
  operation: z.literal("deliverable.start"),
  payload: z.strictObject({ deliverable_id: stableId("DEL") })
});
const deliverableRevise = z.strictObject({
  ...common,
  operation: z.literal("deliverable.revise"),
  payload: z.strictObject({
    deliverable_id: stableId("DEL"),
    version: nonEmpty,
    description: nonEmpty.optional(),
    reference: nonEmpty.optional()
  })
});
const deliverableSubmitReview = z.strictObject({
  ...common,
  operation: z.literal("deliverable.submit_review"),
  payload: z.strictObject({ deliverable_id: stableId("DEL") })
});
const deliverableAccept = z.strictObject({
  ...common,
  operation: z.literal("deliverable.accept"),
  payload: z.strictObject({ deliverable_id: stableId("DEL"), acceptance_note: nonEmpty })
});
const deliverableSupersede = z.strictObject({
  ...common,
  operation: z.literal("deliverable.supersede"),
  payload: z.strictObject({
    deliverable_id: stableId("DEL"),
    replacement_deliverable_id: stableId("DEL"),
    reason: nonEmpty
  })
});
const deliverableAbandon = z.strictObject({
  ...common,
  operation: z.literal("deliverable.abandon"),
  payload: z.strictObject({ deliverable_id: stableId("DEL"), reason: nonEmpty })
});

// Deprecated compatibility operations. New SOP-driven flows use the lifecycle above.
const deliverableAdd = z.strictObject({
  ...common,
  operation: z.literal("deliverable.add"),
  payload: z.strictObject({ deliverable_id: stableId("DEL"), title: nonEmpty, description: nonEmpty.optional(), reference: nonEmpty.optional() })
});
const deliverableComplete = z.strictObject({
  ...common,
  operation: z.literal("deliverable.complete"),
  payload: z.strictObject({ deliverable_id: stableId("DEL"), outcome: nonEmpty.optional() })
});

export const transactionSchema = z.discriminatedUnion("operation", [
  projectCreate,
  projectPause,
  projectResume,
  projectComplete,
  projectArchive,
  projectFramingUpdate,
  decisionAccept,
  decisionSupersede,
  taskCreate,
  taskStart,
  taskComplete,
  taskBlock,
  phaseCreate,
  phaseUpdate,
  phaseComplete,
  constraintAdd,
  researchAdd,
  discoverySynthesisUpdate,
  deliverableCreate,
  deliverableStart,
  deliverableRevise,
  deliverableSubmitReview,
  deliverableAccept,
  deliverableSupersede,
  deliverableAbandon,
  deliverableAdd,
  deliverableComplete
]);

export type Transaction = z.infer<typeof transactionSchema>;
export type Operation = Transaction["operation"];

export function parseTransaction(input: unknown): Transaction {
  return transactionSchema.parse(input);
}
