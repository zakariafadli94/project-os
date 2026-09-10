import type { ProjectionOutputEvidence } from "../domain/materialization";
import type { SliceBudget } from "../convergence/contract";
import { observeText, type ObservedText } from "../convergence/fenced-effects";
import {
  asProjectOsPersistence,
  type PersistenceInput
} from "../persistence/provider/runtime";
import { machineProjectRoot } from "../persistence/layout";
import type { ObjectPersistence } from "../persistence/provider/contract";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
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
  private readonly runtime: ProjectOsPersistenceRuntime | null;

  constructor(
    input: ObjectPersistence | PersistenceInput,
    private readonly concurrency: number
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
      throw new Error(`Invalid projection writer concurrency: ${concurrency}`);
    }
    if (isObjectPersistence(input)) {
      this.objects = input;
      this.runtime = null;
    } else {
      this.runtime = asProjectOsPersistence(input);
      this.objects = this.runtime.objects;
    }
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
        await this.reverifyReusedOutput(plan.project_id, output, root, priorAttempt, options);
        verified.set(output.key, priorAttempt);
        await options.onOutputOutcome?.(output.key, "attempt_reuse");
        await options.onOutputVerified?.(output.key, priorAttempt);
        continue;
      }
      (output.critical ? critical : nonCritical).push(output);
    }

    await this.runStage(plan.project_id, critical, root, verified, options);
    await this.runStage(plan.project_id, nonCritical, root, verified, options);
    await this.removeObsoleteDeliverableProjections(plan, root, options);
    return verified;
  }

  /**
   * Performs only the effects that still leave room for the durable
   * checkpoint. The persistence runtime owns the actual provider-call
   * accounting; this method makes the decision before it starts an output.
   */
  async materializeSlice(
    plan: ProjectionPlan,
    options: WorkspaceProjectionWriterOptions,
    budget: SliceBudget
  ): Promise<{ verified: Map<string, ProjectionOutputEvidence>; nextKey: string | null }> {
    const verified = new Map<string, ProjectionOutputEvidence>();
    const root = normalizeWorkspaceRoot(options.workspaceRoot);
    const ordered = [...plan.changed_outputs.values()].sort((left, right) =>
      Number(right.critical) - Number(left.critical) || left.key.localeCompare(right.key)
    );

    for (const output of ordered) {
      const priorAttempt = options.alreadyVerified?.get(output.key);
      if (priorAttempt && sameEvidence(priorAttempt, output)) {
        // This slice cannot repeatedly spend its bounded provider budget on
        // outputs completed by earlier slices: doing so can starve every new
        // output behind the critical pair. The coordinator re-observes the
        // complete output index once all slices are done, immediately before
        // it creates a completed generation or publishes its head.
        verified.set(output.key, priorAttempt);
        await options.onOutputOutcome?.(output.key, "attempt_reuse");
        await options.onOutputVerified?.(output.key, priorAttempt);
        continue;
      }

      const requiredCalls = this.runtime ? (output.critical ? 7 : 4) : (output.critical ? 3 : 2);
      // Keep room for both critical-pair reads and the head read after
      // publication, in addition to the journal checkpoint reserve owned by
      // the enclosing convergence slice.
      if (!budget.canStartEffect(requiredCalls + 5)) {
        return { verified, nextKey: output.key };
      }

      const result = await this.materializeOne(plan.project_id, output, root, options);
      verified.set(output.key, result.evidence);
      await options.onOutputOutcome?.(output.key, result.outcome);
      await options.onOutputVerified?.(output.key, result.evidence);
    }

    if (plan.removed_outputs.length > 0) {
      // A runtime-backed removal makes a stable observation and a conditional
      // delete; reserve all four provider calls before it starts.
      if (!budget.canStartEffect(this.runtime ? 4 : 2)) return { verified, nextKey: "__removed_outputs__" };
      await this.removeObsoleteDeliverableProjections(plan, root, options);
    }
    return { verified, nextKey: null };
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

  async verifyOutputs(
    outputs: ReadonlyMap<string, ProjectionOutputEvidence>,
    workspaceRoot: string
  ): Promise<void> {
    const root = normalizeWorkspaceRoot(workspaceRoot);
    const entries = [...outputs.entries()];
    let cursor = 0;
    const failures: unknown[] = [];
    const worker = async () => {
      for (;;) {
        if (failures.length > 0) return;
        const current = entries[cursor];
        cursor += 1;
        if (!current) return;
        const [key, evidence] = current;
        const path = joinWorkspacePath(root, evidence.relative_path);
        try {
          const persisted = await this.objects.readText(path);
          if (persisted === null || await sha256Text(persisted) !== evidence.content_hash) {
            throw new MaterializationOutputConflictError(
              key,
              path,
              `Completed materialization verification failed at final workspace location: ${path}`
            );
          }
        } catch (error) {
          failures.push(error);
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, entries.length) }, () => worker()));
    if (failures.length > 0) throw failures[0];
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

  private async removeObsoleteDeliverableProjections(
    plan: ProjectionPlan,
    root: string,
    options: WorkspaceProjectionWriterOptions
  ): Promise<void> {
    const removableKeys = plan.removed_outputs.filter((key) => key.startsWith("deliverable:"));
    if (removableKeys.length === 0) return;
    if (!plan.removed_output_evidence) {
      throw new Error("Removed deliverable projections require completed baseline evidence");
    }

    for (const key of removableKeys) {
      const evidence = plan.removed_output_evidence.get(key);
      if (!evidence) {
        throw new Error(`Removed deliverable projection is missing completed baseline evidence: ${key}`);
      }
      const path = joinWorkspacePath(root, evidence.relative_path);
      const observed = await this.observeForWrite(path);
      if (observed === null) continue;
      const currentHash = observed.hash;
      if (currentHash !== evidence.content_hash) {
        await this.preserveUnexpectedContent(plan.project_id, {
          key,
          path,
          currentContent: observed.content,
          currentHash
        }, options.onUnexpectedContent);
        throw new MaterializationOutputConflictError(
          key,
          path,
          `Refusing to delete an obsolete deliverable projection whose bytes changed since the completed baseline: ${path}`
        );
      }
      if (this.runtime) {
        if (!this.runtime.objects.deleteIfUnchanged) {
          throw new Error(`Conditional delete is unavailable for obsolete projection: ${path}`);
        }
        const outcome = await this.runtime.objects.deleteIfUnchanged(path, {
          objectId: observed.object_id,
          revisionToken: observed.token
        });
        if (outcome === "deleted" || outcome === "missing") continue;
        const changed = await this.observeForWrite(path);
        if (changed !== null) {
          await this.preserveUnexpectedContent(plan.project_id, {
            key,
            path,
            currentContent: changed.content,
            currentHash: changed.hash
          }, options.onUnexpectedContent);
        }
        throw new MaterializationOutputConflictError(
          key,
          path,
          `Refusing to delete an obsolete deliverable projection whose bytes changed after observation: ${path}`
        );
      }
      await this.objects.delete(path);
    }
  }

  private async reverifyReusedOutput(
    projectId: string,
    output: PlannedProjectionOutput,
    root: string,
    evidence: ProjectionOutputEvidence,
    options: WorkspaceProjectionWriterOptions
  ): Promise<void> {
    const path = joinWorkspacePath(root, output.relative_path);
    const observed = await this.observeForWrite(path);
    if (observed !== null && observed.hash === evidence.content_hash) return;
    if (observed !== null) {
      await this.preserveUnexpectedContent(projectId, {
        key: output.key,
        path,
        currentContent: observed.content,
        currentHash: observed.hash
      }, options.onUnexpectedContent);
    }
    throw new MaterializationOutputConflictError(
      output.key,
      path,
      `Materialization output changed after its prior attempt was verified: ${path}`
    );
  }

  private async materializeOne(
    projectId: string,
    output: PlannedProjectionOutput,
    root: string,
    options: WorkspaceProjectionWriterOptions
  ): Promise<{ evidence: ProjectionOutputEvidence; outcome: ProjectionWriteOutcome }> {
    const path = joinWorkspacePath(root, output.relative_path);
    const observed = await this.observeForWrite(path);
    const current = observed?.content ?? null;
    const currentHash = observed?.hash ?? null;
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

    if (current === null) {
      await this.createOrVerify(path, output.content);
    } else if (this.runtime && observed) {
      await this.runtime.conditionalWrite.writeTextConditional(path, output.content, observed.token);
    } else {
      await this.objects.upsertText(path, output.content);
    }

    if (output.critical) {
      const persisted = await this.observeForWrite(path);
      if (persisted === null || persisted.hash !== output.content_hash) {
        throw new MaterializationOutputConflictError(
          output.key,
          path,
          `Critical materialization verification failed after write: ${path}`
        );
      }
    }

    return { evidence: desired, outcome: "uploaded" };
  }

  private async observeForWrite(path: string): Promise<ObservedText | { content: string; hash: string; object_id: string; token: string } | null> {
    if (this.runtime) return observeText(this.runtime, path);
    const content = await this.objects.readText(path);
    if (content === null) return null;
    return {
      content,
      hash: await sha256Text(content),
      object_id: "legacy-object",
      token: "legacy-token"
    };
  }

  private async createOrVerify(path: string, content: string): Promise<void> {
    try {
      await this.objects.createText(path, content);
    } catch (error) {
      const observed = await this.observeForWrite(path);
      if (!observed || observed.hash !== await sha256Text(content)) throw error;
    }
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
