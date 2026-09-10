import type { CapacityObservation } from "./rollout";

const MAX_PROVIDER_CALLS_PER_SLICE = 32;
const RESERVED_CHECKPOINT_CALLS = 4;
const USABLE_EFFECT_CALLS = MAX_PROVIDER_CALLS_PER_SLICE - RESERVED_CHECKPOINT_CALLS;
const MAX_SLICE_DURATION_MS = 10_000;

export interface VirtualCapacityInput {
  duration_minutes: number;
  project_count: number;
  commits_per_minute_per_project: number;
  outputs_per_project: number;
  changed_outputs_per_commit: number;
  bytes_per_commit: number;
  provider_concurrency: 1 | 2 | 3 | 4;
  fleet_concurrency: number;
  provider_call_latency_ms: number;
}

export interface VirtualCapacityReport {
  commits_simulated: number;
  slice_count: number;
  max_provider_calls_per_slice: number;
  max_queued_outputs: number;
  oldest_pending_seconds: number;
  p99_machine_ms: number;
  p999_machine_ms: number;
  p99_human_ms: number;
  p999_human_ms: number;
  fleet_visit_ms: number;
  continuation_available: boolean;
  within_qualified_envelope: boolean;
}

/**
 * Deterministic, provider-free qualification of the bounded-work scheduler.
 * It proves queue math and admission backpressure, not cloud latency; a real
 * 24-hour canary is still required before production activation.
 */
export function qualifyVirtualCapacity(input: VirtualCapacityInput): VirtualCapacityReport {
  assertInput(input);
  const callsPerCommit = input.changed_outputs_per_commit * 2 + 6;
  const slicesPerCommit = Math.ceil(callsPerCommit / USABLE_EFFECT_CALLS);
  const maxCallsPerSlice = Math.min(callsPerCommit, USABLE_EFFECT_CALLS);
  const serviceMs = Math.ceil(callsPerCommit / input.provider_concurrency) * input.provider_call_latency_ms;
  const intervalMs = 60_000 / input.commits_per_minute_per_project;
  const availableAt = Array.from({ length: input.project_count }, () => 0);
  const machineLatencies: number[] = [];
  const humanLatencies: number[] = [];
  let maxQueuedOutputs = 0;

  for (let minute = 0; minute < input.duration_minutes; minute += 1) {
    for (let commit = 0; commit < input.commits_per_minute_per_project; commit += 1) {
      const arrival = minute * 60_000 + commit * intervalMs;
      for (let project = 0; project < input.project_count; project += 1) {
        const queuedCommits = Math.max(0, Math.ceil((availableAt[project]! - arrival) / serviceMs));
        maxQueuedOutputs = Math.max(maxQueuedOutputs, queuedCommits * input.changed_outputs_per_commit);
        const completedAt = Math.max(arrival, availableAt[project]!) + serviceMs;
        availableAt[project] = completedAt;
        const machineLatency = completedAt - arrival;
        machineLatencies.push(machineLatency);
        // Human finalization is its own bounded slice and cannot share the
        // machine checkpoint; add the worst allowed single-slice wake.
        humanLatencies.push(machineLatency + MAX_SLICE_DURATION_MS);
      }
    }
  }

  const fleetVisitMs = Math.ceil(input.project_count / input.fleet_concurrency)
    * slicesPerCommit * MAX_SLICE_DURATION_MS;
  const envelopeValid = input.project_count <= 10
    && input.commits_per_minute_per_project <= 5
    && input.outputs_per_project <= 200
    && input.changed_outputs_per_commit <= 20
    && input.bytes_per_commit <= 1024 * 1024
    && input.fleet_concurrency <= 4;
  const p99Machine = percentile(machineLatencies, 0.99);
  const p999Machine = percentile(machineLatencies, 0.999);
  const p99Human = percentile(humanLatencies, 0.99);
  const p999Human = percentile(humanLatencies, 0.999);
  const within = envelopeValid
    && maxCallsPerSlice <= MAX_PROVIDER_CALLS_PER_SLICE
    && p999Machine <= 120_000
    && p99Human <= 120_000
    && p999Human <= 600_000
    && fleetVisitMs <= 300_000;

  return {
    commits_simulated: machineLatencies.length,
    slice_count: machineLatencies.length * slicesPerCommit,
    max_provider_calls_per_slice: maxCallsPerSlice,
    max_queued_outputs: maxQueuedOutputs,
    oldest_pending_seconds: Math.ceil(Math.max(...machineLatencies) / 1_000),
    p99_machine_ms: p99Machine,
    p999_machine_ms: p999Machine,
    p99_human_ms: p99Human,
    p999_human_ms: p999Human,
    fleet_visit_ms: fleetVisitMs,
    continuation_available: slicesPerCommit > 1,
    within_qualified_envelope: within
  };
}

export function toCapacityObservation(report: VirtualCapacityReport): CapacityObservation {
  return {
    queued_outputs: report.max_queued_outputs,
    oldest_pending_seconds: report.oldest_pending_seconds,
    continuation_available: report.continuation_available,
    within_qualified_envelope: report.within_qualified_envelope
  };
}

function assertInput(input: VirtualCapacityInput): void {
  const positive = [
    input.duration_minutes, input.project_count, input.commits_per_minute_per_project,
    input.outputs_per_project, input.changed_outputs_per_commit, input.bytes_per_commit,
    input.fleet_concurrency, input.provider_call_latency_ms
  ];
  if (positive.some((value) => !Number.isSafeInteger(value) || value < 1)
    || input.changed_outputs_per_commit > input.outputs_per_project
    || ![1, 2, 3, 4].includes(input.provider_concurrency)) {
    throw new Error("invalid_virtual_capacity_input");
  }
}

function percentile(values: readonly number[], percentileValue: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return 0;
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * percentileValue) - 1)]!;
}
