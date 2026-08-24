import type { ProjectState } from "../domain/project-state";
import {
  DropboxCursorResetError,
  type DropboxChangePage,
  type DropboxTransport
} from "../dropbox/client";
import { workspaceProjectRoot } from "../dropbox/layout";
import { ResilientDropboxTransport } from "../dropbox/resilient-transport";
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

export interface ManagedDocumentChangeSummary extends ManagedDocumentReconcileSummary {
  cursor_reset: boolean;
  baseline: boolean;
  cursor_advanced: boolean;
  archived: boolean;
}

export class ManagedDocumentChangeCoordinator {
  private readonly transport: ResilientDropboxTransport;
  private readonly reconciler: ManagedDocumentReconciler;

  constructor(
    transport: DropboxTransport,
    private readonly cursorStore: ManagedDocumentCursorStore
  ) {
    this.transport = new ResilientDropboxTransport(transport);
    this.reconciler = new ManagedDocumentReconciler(transport);
  }

  async reconcile(state: ProjectState): Promise<ManagedDocumentChangeSummary> {
    if (state.status === "archived") {
      return emptySummary({ archived: true });
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

    // Never advance the cursor until every observed change has been reconciled.
    // A crash/failure therefore replays the same provider page, which is safe because
    // version records are immutable and provider observations make replay idempotent.
    const summary = await this.reconciler.reconcileChanges(state, page.entries);
    const cursorAdvanced = page.cursor.length > 0 && page.cursor !== existingCursor;
    if (page.cursor.length > 0) await this.cursorStore.put(CURSOR_KEY, page.cursor);

    return {
      ...summary,
      cursor_reset: cursorReset,
      baseline,
      cursor_advanced: cursorAdvanced,
      archived: false
    };
  }
}

function emptySummary(flags: { archived: boolean }): ManagedDocumentChangeSummary {
  return {
    scanned: 0,
    ignored: 0,
    captured: 0,
    ingested: 0,
    duplicates: 0,
    restored: 0,
    conflicts: 0,
    cursor_reset: false,
    baseline: false,
    cursor_advanced: false,
    archived: flags.archived
  };
}
