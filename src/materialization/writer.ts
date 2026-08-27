import type { ProjectionOutputEvidence } from "../domain/materialization";
import {
  asProjectOsPersistence,
  type PersistenceInput
} from "../persistence/compatibility/legacy-dropbox-runtime";
import { machineProjectRoot } from "../persistence/layout";
import type { ObjectPersistence } from "../persistence/provider/contract";
import { ProviderConflictError } from "../persistence/provider/errors";
import { MANAGED_NOTICE } from "../render/shared";
import { sha256Text } from "./hash";
import type { PlannedProjectionOutput, ProjectionPlan } from "./planner";

export type ProjectionWriteOutcome = "uploaded" | "content_hash" | "attempt_reuse";

export interface UnexpectedProjectionContent {
  key: string;
  path: string;
  currentContent: string;
  currentHash: string;
}

export class MaterializationOutputConflictError extends Error {
  constructor(
    public readonly key: string,
    public readonly path: string,
    message: string
  ) {
    super(message);
    this.name = "MaterializationOutputConflictError";
  }
}

export function parseProjectionConcurrency(value?: string): number {
  if (value === undefined || value === "") return 4;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 4) {
    throw new Error(`Invalid PROJECT_OS_PROJECTION_CONCURRENCY: ${value}`);
  }
  return parsed;
}

export interface WorkspaceProjectionWriterOptions {
  workspaceRoot: string;
  alreadyVerified?: ReadonlyMap<string, ProjectionOutputEvidence>;
  onOutputVerified?: (key: string, evidence: ProjectionOutputEvidence) => void | Promise<void>;
  onOutputOutcome?: (key: string, outcome: ProjectionWriteOutcome) => void | Promise<void>;
  onUnexpectedContent?: (entry: UnexpectedProjectionContent) => void | Promise<void>;
}

export class WorkspaceProjectionWriter {
  private readonly objects: ObjectPersistence;

  constructor(
    input: ObjectPersistence | PersistenceInput,
    private readonly concurrency: number
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
      throw new Error(`Invalid projection writer concurrency: ${concurrency}`);
    }
    this.objects = isObjectPersistence(input)
      ? input
      : asProjectOsPersistence(input).objects;
  }

  async materialize(
    plan: ProjectionPlan,
    options: WorkspaceProjectionWriterOptions
  ): Promise<Map<string, ProjectionOutputEvidence>> {
    const verified = new Map<string, ProjectionOutputEvidence>();
    const root = normalizeWorkspaceRoot(options.workspaceRoot);
    const nonCritical: PlannedProjectionOutput[] = [];
    const critical: PlannedProjectionOutput[] = [];

    for (const output of plan.changed_outputs.values()) {
      const priorAttempt = options.alreadyVerified?.get(output.key);
      if (priorAttempt && sameEvidence(priorAttempt, output)) {
        verified.set(output.key, priorAttempt);
        await options.onOutputOutcome?.(output.key, "attempt_reuse");
        await options.onOutputVerified?.(output.key, priorAttempt);
        continue;
      }
      (output.critical ? critical : nonCritical).push(output);
    }

    await this.runStage(plan.project_id, nonCritical, root, verified, options);
    await this.runStage(plan.project_id, critical, root, verified, options);
    return verified;
  }

  async verifyCritical(plan: ProjectionPlan, workspaceRoot: string): Promise<void> {
    const root = normalizeWorkspaceRoot(workspaceRoot);
    for (const output of plan.changed_outputs.values()) {
      if (!output.critical) continue;
      const path = joinWorkspacePath(root, output.relative_path);
      const persisted = await this.objects.readText(path);
      if (persisted === null || await sha256Text(persisted) !== output.content_hash) {
        throw new MaterializationOutputConflictError(
          output.key,
          path,
          `Critical materialization verification failed at final workspace location: ${path}`
        );
      }
    }
  }

  private async runStage(
    projectId: string,
    outputs: PlannedProjectionOutput[],
    root: string,
    verified: Map<string, ProjectionOutputEvidence>,
    options: WorkspaceProjectionWriterOptions
  ): Promise<void> {
    if (outputs.length === 0) return;
    let cursor = 0;
    const errors: unknown[] = [];
    const workerCount = Math.min(this.concurrency, outputs.length);

    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= outputs.length) return;
        try {
          const output = outputs[index];
          const result = await this.materializeOne(projectId, output, root, options);
          verified.set(output.key, result.evidence);
          await options.onOutputOutcome?.(output.key, result.outcome);
          await options.onOutputVerified?.(output.key, result.evidence);
        } catch (error) {
          errors.push(error);
          return;
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (errors.length > 0) throw errors[0];
  }

  private async materializeOne(
    projectId: string,
    output: PlannedProjectionOutput,
    root: string,
    options: WorkspaceProjectionWriterOptions
  ): Promise<{ evidence: ProjectionOutputEvidence; outcome: ProjectionWriteOutcome }> {
    const path = joinWorkspacePath(root, output.relative_path);
    const current = await this.objects.readText(path);
    const currentHash = current === null ? null : await sha256Text(current);
    const desired = evidenceFor(output);

    if (currentHash === output.content_hash) return { evidence: desired, outcome: "content_hash" };

    const baseline = output.baseline?.relative_path === output.relative_path
      ? output.baseline
      : undefined;

    if (baseline && current !== null && currentHash !== baseline.content_hash) {
      await this.preserveUnexpectedContent(projectId, {
        key: output.key,
        path,
        currentContent: current,
        currentHash: currentHash!
      }, options.onUnexpectedContent);
      throw new MaterializationOutputConflictError(
        output.key,
        path,
        `Materialization output changed unexpectedly since the completed baseline: ${path}`
      );
    }

    if (!baseline && current !== null && !current.includes(MANAGED_NOTICE)) {
      await this.preserveUnexpectedContent(projectId, {
        key: output.key,
        path,
        currentContent: current,
        currentHash: currentHash!
      }, options.onUnexpectedContent);
      throw new MaterializationOutputConflictError(
        output.key,
        path,
        `Refusing to overwrite an untracked non-managed materialization output: ${path}`
      );
    }

    if (current === null) await this.objects.createText(path, output.content);
    else await this.objects.upsertText(path, output.content);

    if (output.critical) {
      const persisted = await this.objects.readText(path);
      if (persisted === null || await sha256Text(persisted) !== output.content_hash) {
        throw new MaterializationOutputConflictError(
          output.key,
          path,
          `Critical materialization verification failed after write: ${path}`
        );
      }
    }

    return { evidence: desired, outcome: "uploaded" };
  }

  private async preserveUnexpectedContent(
    projectId: string,
    entry: UnexpectedProjectionContent,
    callback?: (entry: UnexpectedProjectionContent) => void | Promise<void>
  ): Promise<void> {
    const recoveryRoot = `${machineProjectRoot(projectId)}/recovery/projections`;
    const payloadPath = `${recoveryRoot}/payloads/sha256/${entry.currentHash}.md`;
    const outputKeyHash = await sha256Text(entry.key);
    const recordPath = `${recoveryRoot}/records/${outputKeyHash}-${entry.currentHash}.json`;
    const record = `${JSON.stringify({
      schema_version: "1.0",
      project_id: projectId,
      output_key: entry.key,
      source_path: entry.path,
      content_hash: entry.currentHash,
      payload_path: payloadPath
    }, null, 2)}\n`;

    await this.safeAdd(payloadPath, entry.currentContent);
    await this.safeAdd(recordPath, record);
    await callback?.(entry);
  }

  private async safeAdd(path: string, content: string): Promise<void> {
    try {
      await this.objects.createText(path, content);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.objects.readText(path);
      if (existing !== content) {
        throw new Error(`Projection recovery evidence conflict with different content: ${path}`);
      }
    }
  }
}

function isObjectPersistence(input: ObjectPersistence | PersistenceInput): input is ObjectPersistence {
  return typeof input === "object"
    && input !== null
    && "readText" in input
    && "createText" in input
    && "upsertText" in input;
}

function evidenceFor(output: PlannedProjectionOutput): ProjectionOutputEvidence {
  return {
    relative_path: output.relative_path,
    input_hash: output.input_hash,
    content_hash: output.content_hash,
    source_revision: output.source_revision
  };
}

function sameEvidence(evidence: ProjectionOutputEvidence, output: PlannedProjectionOutput): boolean {
  return evidence.relative_path === output.relative_path
    && evidence.input_hash === output.input_hash
    && evidence.content_hash === output.content_hash
    && evidence.source_revision === output.source_revision;
}

function normalizeWorkspaceRoot(value: string): string {
  if (!value.startsWith("/") || value === "/") throw new Error(`Invalid workspace root: ${value}`);
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function joinWorkspacePath(root: string, relativePath: string): string {
  if (
    !relativePath
    || relativePath.startsWith("/")
    || relativePath.includes("//")
    || relativePath.split("/").some((segment) => segment === "." || segment === ".." || segment === "")
  ) {
    throw new Error(`Unsafe projection relative path: ${relativePath}`);
  }
  return `${root}/${relativePath}`;
}
