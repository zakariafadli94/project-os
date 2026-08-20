import { z } from "zod";

const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const transactionId = z.string().regex(/^TXN-[A-Z0-9-]{10,}$/);
const stableId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-[A-Z0-9]{4,}$`));
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const nonEmpty = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });

export const operationValues = [
  "project.create",
  "project.pause",
  "project.resume",
  "project.complete",
  "project.archive",
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
  project_id: projectId.nullable(),
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

const decisionAccept = z.strictObject({
  ...common,
  operation: z.literal("decision.accept"),
  payload: z.strictObject({
    decision_id: stableId("DEC"),
    title: nonEmpty,
    decision: nonEmpty,
    reason: nonEmpty,
    impacts: z.array(nonEmpty).default([])
  })
});

const decisionSupersede = z.strictObject({
  ...common,
  operation: z.literal("decision.supersede"),
  payload: z.strictObject({
    decision_id: stableId("DEC"),
    replacement_decision_id: stableId("DEC"),
    reason: nonEmpty
  })
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
  deliverableAdd,
  deliverableComplete
]);

export type Transaction = z.infer<typeof transactionSchema>;
export type Operation = Transaction["operation"];

export function parseTransaction(input: unknown): Transaction {
  return transactionSchema.parse(input);
}
