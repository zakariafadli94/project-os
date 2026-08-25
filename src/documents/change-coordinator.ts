import type { ProjectState } from "../domain/project-state";
import {
  DropboxCursorResetError,
  type DropboxChangeEntry,
  type DropboxChangePage,
  type DropboxFileMetadata,
  type DropboxTransport
} from "../dropbox/client";
import { workspaceProjectRoot } from "../dropbox/layout";
import { ResilientDropboxTransport } from "../dropbox/resilient-transport";
import { MutationGateClassifier } from "../mutation-gate/classifier";
import { MutationGateService, type MutationGateMode, type MutationGateProcessSummary } from "../mutation-gate/service";
import { ManagedDocumentBootstrapper, type BootstrapManagedStage } from "./bootstrap";
import {
  ManagedDocumentReconciler,
  type ManagedDocumentReconcileSummary
} from "./reconciler";

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
}

interface BootstrapCandidate {
  change: DropboxChangeEntry;
  stage: BootstrapManagedStage;
  priority: number;
}

export class ManagedDocumentChangeCoordinator {
  private readonly transport: ResilientDropboxTransport;
  private readonly reconciler: ManagedDocumentReconciler;
  private readonly bootstrapper: ManagedDocumentBootstrapper;
  private readonly mutationClassifier: MutationGateClassifier;
  private readonly mutationGate: MutationGateService;

  constructor(
    transport: DropboxTransport,
    private readonly cursorStore: ManagedDocumentCursorStore,
    mode: MutationGateMode = "observe"
  ) {
    this.transport = new ResilientDropboxTransport(transport);
    this.reconciler = new ManagedDocumentReconciler(transport);
    this.bootstrapper = new ManagedDocumentBootstrapper(transport);
    this.mutationClassifier = new MutationGateClassifier(transport);
    this.mutationGate = new MutationGateService(transport, mode);
  }

  async reconcile(state: ProjectState): Promise<ManagedDocumentChangeSummary> {
    if (state.status === "archived") {
      return emptySummary({ archived: true }, this.mutationGateMode());
    }
    if (!this.transport.listFolderChanges) {
      throw new Error("Dropbox transport does not support managed-document change cursors");
    }

    const root = workspaceProjectRoot(state.project_id, state.slug);
    const existingCursor = await this.cursorStore.get<string>(CURSOR_KEY);
    let cursorReset = false;
    let baseline = !existingCursor;
    let page: DropboxChangePage;

    try {
      page = existingCursor
        ? await this.transport.listFolderChanges(undefined, existingCursor)
        : await this.transport.listFolderChanges(root);
    } catch (error) {
      if (!(error instanceof DropboxCursorResetError)) throw error;
      cursorReset = true;
      baseline = true;
      await this.cursorStore.delete(CURSOR_KEY);
      page = await this.transport.listFolderChanges(root);
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

    return {
      ...summary,
      ...gateSummary,
      bootstrapped,
      cursor_reset: cursorReset,
      baseline,
      cursor_advanced: cursorAdvanced,
      archived: false
    };
  }

  private async bootstrapBaseline(state: ProjectState, changes: DropboxChangeEntry[]): Promise<number> {
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

  private bootstrapCandidate(state: ProjectState, change: DropboxChangeEntry): BootstrapCandidate | null {
    if (change.tag !== "file") return null;
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

  private async metadataFor(change: DropboxChangeEntry): Promise<DropboxFileMetadata | null> {
    if (change.id && change.rev && change.content_hash && change.size !== undefined) {
      return {
        id: change.id,
        path: change.path,
        rev: change.rev,
        content_hash: change.content_hash,
        size: change.size,
        ...(change.server_modified ? { server_modified: change.server_modified } : {})
      };
    }
    return this.transport.getMetadata(change.path);
  }

  private mutationGateMode(): MutationGateMode {
    // The service owns the mode; archived summaries need only preserve the
    // externally visible contract. Archived reconciliation never mutates.
    return "observe";
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
    archived: flags.archived
  };
}
