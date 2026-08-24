import type { ProjectionOutputEvidence } from "../domain/materialization";
import type { DropboxTransport } from "../dropbox/client";
import { ResilientDropboxTransport } from "../dropbox/resilient-transport";
import { MANAGED_NOTICE } from "../render/shared";
import { sha256Text } from "./hash";
import type { PlannedProjectionOutput, ProjectionPlan } from "./planner";

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
}

export class WorkspaceProjectionWriter {
  private readonly transport: DropboxTransport;

  constructor(transport: DropboxTransport, private readonly concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
      throw new Error(`Invalid projection writer concurrency: ${concurrency}`);
    }
    this.transport = new ResilientDropboxTransport(transport);
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
        await options.onOutputVerified?.(output.key, priorAttempt);
        continue;
      }
      (output.critical ? critical : nonCritical).push(output);
    }

    await this.runStage(nonCritical, root, verified, options.onOutputVerified);
    await this.runStage(critical, root, verified, options.onOutputVerified);
    return verified;
  }

  private async runStage(
    outputs: PlannedProjectionOutput[],
    root: string,
    verified: Map<string, ProjectionOutputEvidence>,
    callback?: (key: string, evidence: ProjectionOutputEvidence) => void | Promise<void>
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
          const evidence = await this.materializeOne(output, root);
          verified.set(output.key, evidence);
          await callback?.(output.key, evidence);
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
    output: PlannedProjectionOutput,
    root: string
  ): Promise<ProjectionOutputEvidence> {
    const path = joinWorkspacePath(root, output.relative_path);
    const current = await this.transport.download(path);
    const currentHash = current === null ? null : await sha256Text(current);
    const desired = evidenceFor(output);

    if (currentHash === output.content_hash) return desired;

    const baseline = output.baseline?.relative_path === output.relative_path
      ? output.baseline
      : undefined;

    if (baseline && current !== null && currentHash !== baseline.content_hash) {
      throw new MaterializationOutputConflictError(
        output.key,
        path,
        `Materialization output changed unexpectedly since the completed baseline: ${path}`
      );
    }

    if (!baseline && current !== null && !current.includes(MANAGED_NOTICE)) {
      throw new MaterializationOutputConflictError(
        output.key,
        path,
        `Refusing to overwrite an untracked non-managed materialization output: ${path}`
      );
    }

    await this.transport.upload(path, output.content, current === null ? "add" : "overwrite");

    if (output.critical) {
      const persisted = await this.transport.download(path);
      if (persisted === null || await sha256Text(persisted) !== output.content_hash) {
        throw new MaterializationOutputConflictError(
          output.key,
          path,
          `Critical materialization verification failed after write: ${path}`
        );
      }
    }

    return desired;
  }
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
