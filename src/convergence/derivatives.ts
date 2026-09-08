import type { CanonicalCommitRecord } from "../domain/commit-record";
import {
  machineEventPath,
  machineManifestPath,
  machineReceiptPath,
  machineStatePath
} from "../persistence/layout";
import type { ProjectRepository } from "../persistence/repository";
import type { EffectIntent, LayerHealth, Progress } from "./contract";
import { FencedEffects, observeText } from "./fenced-effects";

type DerivativeLayer = "event" | "receipt" | "state" | "manifest";

export async function repairDerivative(
  layer: DerivativeLayer,
  record: CanonicalCommitRecord,
  progress: Progress,
  effects: FencedEffects,
  repository: Pick<ProjectRepository, "canonicalDerivativeText">
): Promise<LayerHealth> {
  const path = derivativePath(layer, record);
  const content = repository.canonicalDerivativeText(layer, record);
  const observed = await observeTextForEffects(effects, path);
  const expected = await textEvidence(content, record.new_revision);

  if (observed?.content === content) return current(expected, observed, record.new_revision);
  const intent: EffectIntent = {
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
  };
  if (progress.effects[intent.id]?.state !== "prepared") return pending(expected, observed, "effect_requires_reservation");
  try {
    const after = await effects.replace(intent, content);
    return current(expected, after, record.new_revision);
  } catch (error) {
    return pending(expected, observed, error instanceof Error ? error.message : "effect_blocked");
  }
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
