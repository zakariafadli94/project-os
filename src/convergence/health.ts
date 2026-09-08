import {
  LAYERS,
  type ConvergenceHealth,
  type Evidence,
  type HealthState,
  type LayerHealth,
  type ObligationState
} from "./contract";

export function publicState(state: ObligationState): HealthState {
  return state === "verified" ? "current" : state === "running" ? "pending" : state;
}

export function isConverged(health: ConvergenceHealth): boolean {
  return !health.due_without_alarm && LAYERS.every((layerName) => {
    const layer = health.layers[layerName];
    return !layer.applicable || (
      layer.state === "current"
      && layer.observation_complete
      && layer.missing_count === 0
      && layer.first_missing_id === null
      && layer.last_verified_at !== null
    );
  });
}

function unknownEvidence(): Evidence {
  return {
    revision: null,
    identity: null,
    hash: null,
    projection_version: null,
    root_hash: null
  };
}

function unknownLayer(): LayerHealth {
  return {
    state: "unknown",
    applicable: true,
    expected: unknownEvidence(),
    observed: unknownEvidence(),
    last_verified_at: null,
    first_pending_at: null,
    next_attempt_at: null,
    failure_count: 0,
    code: null,
    verified_through: null,
    missing_count: 0,
    first_missing_id: null,
    observation_complete: false
  };
}

export function unknownHealth(projectId: string, now: string): ConvergenceHealth {
  const layers = Object.fromEntries(LAYERS.map((layer) => [layer, unknownLayer()])) as ConvergenceHealth["layers"];
  return {
    schema_version: "1.0",
    project_id: projectId,
    layers,
    converged: false,
    due_without_alarm: false,
    first_observed_at: now,
    commit_accepted_at: null,
    commit_time_code: "commit_time_unknown"
  };
}
