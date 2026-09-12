import { ruleVersionSchema, ruleVersionKey, type RuleVersion } from "../domain/rule-governance";
import { sha256Text } from "../documents/hash";
import { canonicalJson, compareCodePoints, ruleReference, sameScope, verdict, type OperationContext, type RuleResource } from "./contract";

const intersects = (a: string[], b: string[]) => a.includes("*") || b.includes("*") || a.some(x => b.includes(x));
export function matchesResource(rule: RuleVersion, resource: RuleResource): boolean {
  return intersects(rule.resource_scope.resource_types, [resource.resource_type]) && intersects(rule.resource_scope.zones, [resource.zone]);
}
export function findRuleConflict(rules: RuleVersion[]): [RuleVersion, RuleVersion] | null {
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
    const a = rules[i], b = rules[j];
    if (a.scope.kind === "project" && b.scope.kind === "project" && a.scope.project_id !== b.scope.project_id) continue;
    if (!intersects(a.operations, b.operations) || !intersects(a.resource_scope.resource_types, b.resource_scope.resource_types) || !intersects(a.resource_scope.zones, b.resource_scope.zones)) continue;
    if (a.check_stage !== "both" && b.check_stage !== "both" && a.check_stage !== b.check_stage) continue;
    if (a.check_id === "allowed_destination" && b.check_id === a.check_id && Array.isArray(a.parameters.allowed_zones) && Array.isArray(b.parameters.allowed_zones) && !intersects(a.parameters.allowed_zones, b.parameters.allowed_zones)) return [a, b];
  }
  return null;
}
/** Snapshots come from the server's canonical readers, never a requested subset. */
export async function resolveEffectiveRules(context: OperationContext) {
  const isMap = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!context.global_governance || !Number.isSafeInteger(context.global_governance.revision) || context.global_governance.revision < 0 ||
    !isMap(context.global_governance.rules) || !isMap(context.global_governance.exceptions) || !isMap(context.state.local_rules) || !isMap(context.state.rule_exceptions)) throw new Error("Incomplete canonical governance snapshot");
  const rules: RuleVersion[] = [];
  const gaps: { rule: ReturnType<typeof ruleReference>; code: string; check_id: string }[] = [];
  for (const [map, scope] of [[context.global_governance.rules, { kind: "global" }], [context.state.local_rules, { kind: "project", project_id: context.project_id }]] as const) {
    for (const [key, value] of Object.entries(map)) {
      const parsed = ruleVersionSchema.safeParse(value);
      if (!parsed.success || key !== ruleVersionKey(parsed.data.rule_id, parsed.data.version) || !sameScope(parsed.data.scope, scope)) throw new Error("Invalid canonical rule identity/scope");
      const rule = parsed.data;
      if (!rule.operations.includes(context.operation) || !context.resources.some(resource => matchesResource(rule, resource))) continue;
      if (rule.status === "active") rules.push(rule);
      if (rule.status === "accepted_unenforced") gaps.push({ rule: ruleReference(rule), code: "ACCEPTED_UNENFORCED", check_id: rule.check_id });
    }
  }
  const sortKey = (r: ReturnType<typeof ruleReference>) => `${r.scope.kind === "global" ? "0" : "1"}:${r.rule_id}:${String(r.version).padStart(16, "0")}`;
  rules.sort((a, b) => compareCodePoints(sortKey(a), sortKey(b)));
  gaps.sort((a, b) => compareCodePoints(sortKey(a.rule), sortKey(b.rule)));
  const identities = new Set<string>();
  for (const rule of rules) {
    const key = canonicalJson([rule.scope, rule.rule_id]);
    if (identities.has(key)) throw new Error("Multiple active versions of one rule");
    identities.add(key);
  }
  const ruleset = {
    digest: await sha256Text(canonicalJson({ project: context.project_id, operation: context.operation, global_revision: context.global_governance?.revision, project_revision: context.state.revision, rules })),
    rules: rules.map(ruleReference), global_revision: context.global_governance?.revision ?? null, project_revision: context.state.revision
  };
  return { rules, ruleset, gaps };
}
export function conflictVerdict(pair: [RuleVersion, RuleVersion]) {
  return verdict("deny", "RULESET_CONFLICT", pair[0], "Compatible cumulative rule conditions", `${pair[0].rule_id}@${pair[0].version} conflicts with ${pair[1].rule_id}@${pair[1].version}`, "Resolve the contradictory rules through a qualified successor; local override cannot weaken global rules");
}
