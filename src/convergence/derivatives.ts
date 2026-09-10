import type { CanonicalCommitRecord } from "../domain/commit-record";
import {
  machineEventPath,
  machineManifestPath,
  machineReceiptPath,
  machineStatePath
} from "../persistence/layout";
import type { ProjectRepository } from "../persistence/repository";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { EffectIntent, LayerHealth } from "./contract";
import { FencedEffects, observeText } from "./fenced-effects";

type DerivativeLayer = "event" | "receipt" | "state" | "manifest";

export interface DerivativeRepairInspection {
  current: LayerHealth | null;
  intent: EffectIntent | null;
}

/**
 * Captures the exact path, desired bytes and provider precondition that a
 * later durable effect is allowed to use. The engine checkpoints this intent
 * before it reserves an attempt or performs any mutation.
 */
export async function inspectDerivativeRepair(
  layer: DerivativeLayer,
  record: CanonicalCommitRecord,
  effects: FencedEffects,
  repository: Pick<ProjectRepository, "canonicalDerivativeText">
): Promise<DerivativeRepairInspection> {
  const path = derivativePath(layer, record);
  const content = repository.canonicalDerivativeText(layer, record);
  const observed = await observeTextForEffects(effects, path);
  const expected = await textEvidence(content, record.new_revision);

  if (observed?.content === content) return { current: current(expected, observed, record.new_revision), intent: null };
  return { current: null, intent: {
    id: `${layer}:${record.new_revision}`,
    path,
    destination: path,
    kind: observed ? "replace" : "create",
    object_id: observed?.object_id ?? null,
    expected_token: observed?.token ?? null,
    desired_hash: expected.hash,
    authorized_previous_hash: observed?.hash ?? null,
    state: "prepared",
    verified_token: null
  } };
}

export async function repairDerivative(
  layer: DerivativeLayer,
  record: CanonicalCommitRecord,
  effects: FencedEffects,
  repository: Pick<ProjectRepository, "canonicalDerivativeText">,
  intent: EffectIntent
): Promise<LayerHealth> {
  const path = derivativePath(layer, record);
  const content = repository.canonicalDerivativeText(layer, record);
  const expected = await textEvidence(content, record.new_revision);
  if (
    intent.id !== `${layer}:${record.new_revision}`
    || intent.path !== path
    || intent.desired_hash !== expected.hash
  ) return pending(expected, null, "effect_intent_mismatch");
  try {
    const after = await effects.replace(intent, content);
    return current(expected, after, record.new_revision);
  } catch (error) {
    return pending(expected, null, error instanceof Error ? error.message : "effect_blocked");
  }
}

/** Reads one machine derivative without reserving or performing an effect. */
export async function observeDerivative(
  layer: DerivativeLayer,
  record: CanonicalCommitRecord,
  runtime: ProjectOsPersistenceRuntime,
  repository: Pick<ProjectRepository, "canonicalDerivativeText">
): Promise<LayerHealth> {
  const path = derivativePath(layer, record);
  const content = repository.canonicalDerivativeText(layer, record);
  const observed = await observeText(runtime, path);
  const expected = await textEvidence(content, record.new_revision);
  return observed?.content === content
    ? current(expected, observed, record.new_revision)
    : pending(expected, observed, "derivative_not_current");
}

function derivativePath(layer: DerivativeLayer, record: CanonicalCommitRecord): string {
  if (layer === "event") return machineEventPath(record.project_id, record.event.event_id);
  if (layer === "receipt") return machineReceiptPath(record.receipt.transaction_id);
  if (layer === "state") return machineStatePath(record.project_id);
  return machineManifestPath(record.project_id);
}

async function observeTextForEffects(effects: FencedEffects, path: string) {
  return effects.observe(path);
}

async function textEvidence(content: string, revision: number) {
  const { sha256Text } = await import("../materialization/hash");
  return { revision, identity: null, hash: await sha256Text(content), projection_version: null, root_hash: null };
}

function current(expected: Awaited<ReturnType<typeof textEvidence>>, observed: { hash: string; object_id: string; token: string }, revision: number): LayerHealth {
  return {
    state: "current", applicable: true, expected,
    observed: { ...expected, identity: observed.object_id, hash: observed.hash },
    last_verified_at: new Date().toISOString(), first_pending_at: null, next_attempt_at: null,
    failure_count: 0, code: null, verified_through: revision, missing_count: 0,
    first_missing_id: null, observation_complete: true
  };
}

function pending(expected: Awaited<ReturnType<typeof textEvidence>>, observed: { hash: string; object_id: string; token: string } | null, code: string): LayerHealth {
  return {
    state: "pending", applicable: true, expected,
    observed: observed
      ? { ...expected, identity: observed.object_id, hash: observed.hash }
      : { revision: null, identity: null, hash: null, projection_version: null, root_hash: null },
    last_verified_at: null, first_pending_at: null, next_attempt_at: null,
    failure_count: 0, code, verified_through: null, missing_count: 1,
    first_missing_id: null, observation_complete: true
  };
}
