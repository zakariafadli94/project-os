import { z } from "zod";
import type { EffectAddress, ExecutionAdmission, ExecutionPlan, ExecutionStep, ExpectedObject, ObservedObject, StepObservation } from "./contract";
import { canonicalJson } from "../rules/contract";
import { ARCHIVE_ROOT, MACHINE_ROOT, WORKSPACE_ROOT } from "../persistence/layout";

const text = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relative = text.refine((p) => !p.startsWith("/") && !/[\\?#%]/.test(p) && p.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
const path = text.refine((p) => p.startsWith("/") && !/[\\?#%]/.test(p) && p.slice(1).split("/").every((part) => part !== "" && part !== "." && part !== ".."));
const address = z.strictObject({ path, logical_path: relative });
const resourceScopesSchema = z.array(z.strictObject({ resource_id: text, resource_version: text, provider_id: text,
  sources: z.array(address), destinations: z.array(address), preservation_copies: z.array(address)
})).min(1);
const identity = z.strictObject({ object_id: text, revision_token: text, content_sha256: hash });
const source = address.extend({ expected: identity });
const expected = z.discriminatedUnion("state", [z.strictObject({ state: z.literal("absent") }), z.strictObject({ state: z.literal("present"), identity })]);
const action = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("copy_if_unchanged"), source, destination: address, expected_destination: expected, desired: z.strictObject({ content_sha256: hash }) }),
  z.strictObject({ kind: z.literal("write_if_unchanged"), destination: address, expected_destination: expected, desired: z.strictObject({ content_sha256: hash, content_ref: z.string().regex(/^sha256:[a-f0-9]{64}$/) }) }),
  z.strictObject({ kind: z.literal("delete_if_unchanged"), source, verified_copy: source })
]);
const step = z.strictObject({ step_id: text, resource_id: text, expected_version: text, provider_id: text, action });
const planSchema = z.strictObject({ steps: z.array(step).min(1), postchecks: z.array(text).min(1), target_revision: z.number().int().nonnegative(),
  supersedes: z.strictObject({ project_id: text, kind: text, request_id: text, request_hash: hash, effect_plan_hash: hash, target_revision: z.number().int().nonnegative(), compatibility: z.literal("identical_effects_and_postchecks") }).optional()
});
const objectObservation = z.discriminatedUnion("state", [address.extend({ state: z.literal("absent") }), address.extend({ state: z.literal("present"), identity })]);
const observationSchema = z.strictObject({ status: z.enum(["ready", "verified"]), observed: z.strictObject({ source: objectObservation.optional(), destination: objectObservation.optional() }), evidence_refs: z.array(text).min(1) });

export function parseExecutionPlan(value: unknown): ExecutionPlan {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) throw new Error("execution_plan_invalid");
  for (const { action: effect } of parsed.data.steps) {
    if (effect.kind === "copy_if_unchanged" && (effect.source.path === effect.destination.path || effect.desired.content_sha256 !== effect.source.expected.content_sha256)) throw new Error("execution_plan_invalid");
    if (effect.kind === "delete_if_unchanged" && (effect.source.path === effect.verified_copy.path || effect.source.expected.content_sha256 !== effect.verified_copy.expected.content_sha256)) throw new Error("execution_plan_invalid");
    if (effect.kind === "write_if_unchanged" && effect.desired.content_ref !== `sha256:${effect.desired.content_sha256}`) throw new Error("execution_plan_invalid");
  }
  return parsed.data;
}

export function assertEffectBindings(plan: ExecutionPlan, admission: ExecutionAdmission, providerId: string): void {
  for (const step of plan.steps) {
    if (step.provider_id !== providerId) throw new Error("execution_plan_invalid");
    assertStepResourceScope(step, admission);
    const effect = step.action;
    const locations = effect.kind === "delete_if_unchanged" ? [effect.source, effect.verified_copy]
      : effect.kind === "copy_if_unchanged" ? [effect.source, effect.destination] : [effect.destination];
    for (const location of locations) {
      const projectScoped = location.path.startsWith(`${MACHINE_ROOT}/projects/${admission.project_id}/`)
        || location.path.startsWith(`${WORKSPACE_ROOT}/PROJECTS/${admission.project_id}-`)
        || location.path.startsWith(`${ARCHIVE_ROOT}/PROJECTS/${admission.project_id}-`);
      const ownStagingSource = "source" in effect && location === effect.source
        && location.path.startsWith(`${MACHINE_ROOT}/artifacts/staging/${admission.request_id}/`);
      if ((!projectScoped && !ownStagingSource) || !location.path.endsWith(`/${location.logical_path}`)) throw new Error("execution_plan_invalid");
    }
  }
}

/** A verified assertion is insufficient: compare actual typed provider
 * observations with every frozen path, version and content precondition. */
export function inspectStepObservation(step: ExecutionStep, value: unknown, admission: ExecutionAdmission): StepObservation["status"] {
  try { assertStepResourceScope(step, admission); }
  catch { return "unavailable"; }
  if (value && typeof value === "object" && "status" in value && (value.status === "unavailable" || value.status === "conflict")) return value.status;
  const parsed = observationSchema.safeParse(value);
  if (!parsed.success) return "unavailable";
  const { status, observed } = parsed.data;
  const effect = step.action;
  const expectedKeys = effect.kind === "delete_if_unchanged" || (effect.kind === "copy_if_unchanged" && status === "ready") ? ["destination", "source"] : ["destination"];
  if (canonicalJson(Object.keys(observed).sort()) !== canonicalJson(expectedKeys)) return "conflict";
  if (effect.kind === "delete_if_unchanged") {
    return matches(observed.source, effect.source, status === "verified" ? { state: "absent" } : { state: "present", identity: effect.source.expected })
      && matches(observed.destination, effect.verified_copy, { state: "present", identity: effect.verified_copy.expected }) ? status : "conflict";
  }
  if (status === "ready") {
    if (!matches(observed.destination, effect.destination, effect.expected_destination)) return "conflict";
    if (effect.kind === "copy_if_unchanged" && !matches(observed.source, effect.source, { state: "present", identity: effect.source.expected })) return "conflict";
    return status;
  }
  const destination = observed.destination;
  if (!destination || !sameAddress(destination, effect.destination) || destination.state !== "present" || destination.identity.content_sha256 !== effect.desired.content_sha256) return "conflict";
  if (effect.kind === "write_if_unchanged" && effect.expected_destination.state === "present" && destination.identity.object_id !== effect.expected_destination.identity.object_id) return "conflict";
  return status;
}

/** Project membership is not file authority. Match every role/address against
 * the independently admitted resource/version scope, never a scope inferred
 * from the proposed effect itself or borrowed from another resource. */
function assertStepResourceScope(step: ExecutionStep, admission: ExecutionAdmission): void {
  const parsed = resourceScopesSchema.safeParse(admission?.resource_effect_scopes);
  if (!parsed.success) throw new Error("execution_resource_scope_unavailable");
  const scopes = parsed.data;
  const keys = scopes.map((scope) => canonicalJson([scope.resource_id, scope.resource_version]));
  if (new Set(keys).size !== keys.length || scopes.some((scope) => !admission.resources.some((resource) =>
    resource.resource_id === scope.resource_id && (resource.expected_version ?? resource.version) === scope.resource_version
  ))) throw new Error("execution_resource_scope_conflict");
  const scope = scopes.find((entry) => entry.resource_id === step.resource_id && entry.resource_version === step.expected_version && entry.provider_id === step.provider_id);
  if (!scope) throw new Error("execution_resource_scope_conflict");
  const effect = step.action;
  const authorized = (location: EffectAddress, allowed: EffectAddress[]) => allowed.some((candidate) => sameAddress(location, candidate));
  if (("source" in effect && !authorized(effect.source, scope.sources))
    || ("destination" in effect && !authorized(effect.destination, scope.destinations))
    || (effect.kind === "delete_if_unchanged" && !authorized(effect.verified_copy, scope.preservation_copies))) throw new Error("execution_resource_scope_conflict");
}

export function freezeExecutionPlan(plan: ExecutionPlan): ExecutionPlan {
  return deepFreeze(parseExecutionPlan(plan));
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
function sameAddress(actual: EffectAddress, expected: EffectAddress): boolean { return actual.path === expected.path && actual.logical_path === expected.logical_path; }
function matches(actual: ObservedObject | undefined, address: EffectAddress, expected: ExpectedObject): boolean {
  return !!actual && sameAddress(actual, address) && actual.state === expected.state
    && (expected.state === "absent" || (actual.state === "present" && canonicalJson(actual.identity) === canonicalJson(expected.identity)));
}
