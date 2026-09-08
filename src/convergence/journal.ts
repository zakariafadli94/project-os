import { canonicalJson } from "../materialization/hash";
import {
  convergenceAttemptPath,
  convergenceProgressPath,
  machineConvergenceRoot
} from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { AttemptReservation, Progress } from "./contract";

export class ConvergenceJournal {
  constructor(
    private readonly runtime: ProjectOsPersistenceRuntime,
    private readonly projectId: string
  ) {}

  async load(): Promise<{ progress: Progress; token: string } | null> {
    const path = convergenceProgressPath(this.projectId);
    const raw = await this.runtime.objects.readText(path);
    if (raw === null) return null;
    const progress = parseProgress(raw, this.projectId);
    const metadata = await this.runtime.objects.getMetadata(path);
    if (!metadata?.revisionToken) throw new Error("journal_progress_token_unavailable");
    return { progress, token: metadata.revisionToken };
  }

  async save(progress: Progress, expectedToken: string | null): Promise<string> {
    assertProgress(progress, this.projectId);
    const path = convergenceProgressPath(this.projectId);
    const content = `${canonicalJson(progress)}\n`;

    if (expectedToken === null) {
      try {
        await this.runtime.objects.createText(path, content);
      } catch (error) {
        const existing = await this.runtime.objects.readText(path);
        if (existing !== content) throw error;
      }
      const metadata = await this.runtime.objects.getMetadata(path);
      if (!metadata?.revisionToken) throw new Error("journal_progress_token_unavailable");
      return metadata.revisionToken;
    }

    const metadata = await this.runtime.conditionalWrite.writeTextConditional(path, content, expectedToken);
    if (!metadata.revisionToken) throw new Error("journal_progress_token_unavailable");
    return metadata.revisionToken;
  }

  async reserve(attempt: AttemptReservation): Promise<void> {
    assertAttempt(attempt, this.projectId);
    const path = convergenceAttemptPath(this.projectId, attempt.obligation_id, attempt.attempt_number);
    const content = `${canonicalJson(attempt)}\n`;
    try {
      await this.runtime.objects.createText(path, content);
      return;
    } catch (error) {
      const existing = await this.runtime.objects.readText(path);
      if (existing === content) return;
      if (existing !== null) throw new Error("journal_integrity_conflict");
      throw error;
    }
  }

  async listAttempts(obligationId: string): Promise<AttemptReservation[]> {
    if (!/^[a-f0-9]{64}$/.test(obligationId)) throw new Error("invalid_convergence_obligation_id");
    const root = `${machineConvergenceRoot(this.projectId)}/attempts/${obligationId}`;
    const entries = await this.runtime.objects.listChildren(root);
    const attempts = await Promise.all(entries
      .filter((entry) => entry.kind === "file" && entry.path?.endsWith(".json"))
      .map(async (entry) => parseAttempt(await this.runtime.objects.readText(entry.path!), this.projectId)));
    return attempts.sort((left, right) => left.attempt_number - right.attempt_number);
  }
}

export function initialProgress(projectId: string, now: string, incarnation: string): Progress {
  return {
    schema_version: "1.0",
    project_id: projectId,
    incarnation,
    lease_until: now,
    canonical_observed_revision: 0,
    baseline_revision: 0,
    baseline_kind: "commit",
    event_verified_through: 0,
    receipt_verified_through: 0,
    missing_event_ids: [],
    missing_receipt_ids: [],
    active: null,
    requested: null,
    parked: [],
    obligations: {},
    effects: {},
    partial_outputs: {},
    cursors: {},
    last_queue: "human",
    next_alarm_at: null,
    alerts: {},
    first_observed_at: now,
    commit_accepted_at: null,
    last_error_code: null
  };
}

function parseProgress(raw: string, projectId: string): Progress {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("journal_progress_invalid_json");
  }
  assertProgress(value, projectId);
  return value;
}

function parseAttempt(raw: string | null, projectId: string): AttemptReservation {
  if (raw === null) throw new Error("journal_attempt_missing");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("journal_attempt_invalid_json");
  }
  assertAttempt(value, projectId);
  return value;
}

function assertProgress(value: unknown, projectId: string): asserts value is Progress {
  if (!value || typeof value !== "object") throw new Error("journal_progress_invalid");
  const progress = value as Partial<Progress>;
  if (progress.schema_version !== "1.0" || progress.project_id !== projectId || typeof progress.incarnation !== "string") {
    throw new Error("journal_progress_binding_mismatch");
  }
}

function assertAttempt(value: unknown, projectId: string): asserts value is AttemptReservation {
  if (!value || typeof value !== "object") throw new Error("journal_attempt_invalid");
  const attempt = value as Partial<AttemptReservation>;
  if (
    attempt.schema_version !== "1.0"
    || attempt.project_id !== projectId
    || !attempt.obligation_id?.match(/^[a-f0-9]{64}$/)
    || !Number.isSafeInteger(attempt.attempt_number)
    || !attempt.target
  ) {
    throw new Error("journal_attempt_binding_mismatch");
  }
}
