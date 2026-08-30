import type { ProjectState } from "../domain/project-state";
import { MutationGateClassifier } from "../mutation-gate/classifier";
import { MutationGateService, type MutationGateMode, type MutationGateProcessSummary } from "../mutation-gate/service";
import { workspaceProjectRoot } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import {
  asProjectOsPersistence,
  type PersistenceInput
} from "../persistence/provider/runtime";
import type {
  ProviderChangeEntry,
  ProviderChangePage,
  ProviderObjectMetadata
} from "../persistence/provider/contract";
import { ProviderCursorResetError } from "../persistence/provider/errors";
import { ManagedDocumentBootstrapper, type BootstrapManagedStage } from "./bootstrap";
import { IntakeSweep, type IntakeSweepSummary } from "./intake-sweep";
import { ManagedDocumentReconciler } from "./reconciler-intake";
import type { ManagedDocumentReconcileSummary } from "./reconciler";

const CURSOR_KEY = "managed-document-change-cursor-v1";

export interface ManagedDocumentCursorStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface ManagedDocumentChangeSummary extends ManagedDocumentReconcileSummary, MutationGateProcessSummary {
  bootstrapped: number;
  cursor_reset: boolean;
  baseline: boolean;
  cursor_advanced: boolean;
  archived: boolean;
  sweep: IntakeSweepSummary;
}

interface BootstrapCandidate {
  change: ProviderChangeEntry;
  stage: BootstrapManagedStage;
  priority: number;
}

export class ManagedDocumentChangeCoordinator {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly reconciler: ManagedDocumentReconciler;
  private readonly bootstrapper: ManagedDocumentBootstrapper;
  private readonly mutationClassifier: MutationGateClassifier;
  private readonly mutationGate: MutationGateService;
  private readonly intakeSweep: IntakeSweep;

  constructor(
    input: PersistenceInput,
    private readonly cursorStore: ManagedDocumentCursorStore,
    private readonly gateMode: MutationGateMode = "observe"
  ) {
    this.runtime = asProjectOsPersistence(input);
    this.reconciler = new ManagedDocumentReconciler(this.runtime);
    this.bootstrapper = new ManagedDocumentBootstrapper(this.runtime);
    this.mutationClassifier = new MutationGateClassifier(this.runtime);
    this.mutationGate = new MutationGateService(this.runtime, gateMode);
    this.intakeSweep = new IntakeSweep(this.runtime);
  }

  async reconcile(state: ProjectState): Promise<ManagedDocumentChangeSummary> {
    if (state.status === "archived") {
      return emptySummary({ archived: true }, this.mutationGateMode());
    }

    const root = workspaceProjectRoot(state.project_id, state.slug);
    const existingCursor = await this.cursorStore.get<string>(CURSOR_KEY);
    let cursorReset = false;
    let baseline = !existingCursor;
    let page: ProviderChangePage;

    try {
      page = existingCursor
        ? await this.runtime.changeFeed.listChanges({ cursor: existingCursor })
        : await this.runtime.changeFeed.listChanges({ root });
    } catch (error) {
      if (!(error instanceof ProviderCursorResetError)) throw error;
      cursorReset = true;
      baseline = true;
      await this.cursorStore.delete(CURSOR_KEY);
      page = await this.runtime.changeFeed.listChanges({ root });
    }

    const detectionSource = cursorReset ? "cursor_reset" : baseline ? "baseline" : "incremental";
    // MutationGate runs before any bootstrap/reconciliation and before cursor
    // advancement so an unknown final-zone file cannot disappear behind a cursor.
    const gateSummary = await this.mutationGate.processChanges(state, page.entries, detectionSource);

    let bootstrapped = 0;
    if (baseline) {
      bootstrapped = await this.bootstrapBaseline(state, page.entries);
    }

    const summary = await this.reconciler.reconcileChanges(state, page.entries);
    const cursorAdvanced = page.cursor.length > 0 && page.cursor !== existingCursor;
    if (page.cursor.length > 0) await this.cursorStore.put(CURSOR_KEY, page.cursor);

    // The provider change cursor is the fast path, not the sole discovery
    // mechanism for INPUTS. Every document maintenance call directly sweeps the
    // bound INPUTS subtree through the same crash-safe intake engine.
    const sweep = await this.intakeSweep.sweep(state, new Date().toISOString());

    return {
      ...summary,
      ...gateSummary,
      bootstrapped,
      cursor_reset: cursorReset,
      baseline,
      cursor_advanced: cursorAdvanced,
      archived: false,
      sweep
    };
  }

  private async bootstrapBaseline(state: ProjectState, changes: ProviderChangeEntry[]): Promise<number> {
    const candidates = changes
      .map((change) => this.bootstrapCandidate(state, change))
      .filter((candidate): candidate is BootstrapCandidate => candidate !== null)
      .sort((a, b) => a.priority - b.priority || a.change.path.localeCompare(b.change.path));

    let adopted = 0;
    for (const candidate of candidates) {
      const metadata = await this.metadataFor(candidate.change);
      if (!metadata) continue;

      if (candidate.stage === "published") {
        const classification = await this.mutationClassifier.classify(state, candidate.change.path, metadata);
        if (classification.kind !== "not_final_zone") continue;
      }

      const result = await this.bootstrapper.bootstrapExistingManagedPath(
        state,
        candidate.change.path,
        metadata,
        candidate.stage
      );
      if (result.adopted) adopted += 1;
    }
    return adopted;
  }

  private bootstrapCandidate(state: ProjectState, change: ProviderChangeEntry): BootstrapCandidate | null {
    if (change.kind !== "file") return null;
    const root = `${workspaceProjectRoot(state.project_id, state.slug)}/`;
    if (!change.path.startsWith(root)) return null;
    const relative = change.path.slice(root.length);

    if (relative.startsWith("DELIVERABLES/") && relative.length > "DELIVERABLES/".length) {
      const managedRelative = relative.slice("DELIVERABLES/".length);
      if (isProjectedDeliverableMetadata(state, managedRelative)) return null;
      return { change, stage: "published", priority: 0 };
    }
    if (relative.startsWith("WORKING/") && relative.length > "WORKING/".length) {
      return { change, stage: "working", priority: 1 };
    }
    if (relative.startsWith("REVIEW/") && relative.length > "REVIEW/".length) {
      return { change, stage: "review", priority: 2 };
    }
    if (relative.startsWith("REFERENCES/") && relative.length > "REFERENCES/".length) {
      return { change, stage: "reference", priority: 3 };
    }
    return null;
  }

  private async metadataFor(change: ProviderChangeEntry): Promise<ProviderObjectMetadata | null> {
    if (change.metadata) return change.metadata;
    return this.runtime.objects.getMetadata(change.path);
  }

  private mutationGateMode(): MutationGateMode {
    return this.gateMode;
  }
}

function isProjectedDeliverableMetadata(state: ProjectState, relativePath: string): boolean {
  if (relativePath.includes("/") || !relativePath.endsWith(".md")) return false;
  return Object.prototype.hasOwnProperty.call(state.deliverables, relativePath.slice(0, -3));
}

function emptySummary(flags: { archived: boolean }, mode: MutationGateMode): ManagedDocumentChangeSummary {
  return {
    scanned: 0,
    ignored: 0,
    captured: 0,
    ingested: 0,
    duplicates: 0,
    restored: 0,
    conflicts: 0,
    candidates: 0,
    mutation_gate_mode: mode,
    policy_violations: 0,
    bootstrapped: 0,
    cursor_reset: false,
    baseline: false,
    cursor_advanced: false,
    archived: flags.archived,
    sweep: {
      archived: flags.archived,
      files_scanned: 0,
      ingested: 0,
      duplicates: 0,
      failed: 0
    }
  };
}
