import { DocumentLedgerRepository } from "../documents/repository";
import type { Env } from "../env";
import { restartSearchDocumentEpoch } from "../search/project-sync-recovery";
import {
  initializeProjectSearchSyncSchema,
  ProjectSearchSyncStore
} from "../search/project-sync-store";
import { ProjectSearchSynchronizer } from "../search/project-synchronizer";
import { SubrequestResilientProjectGuard } from "./project-guard-subrequest-resilient";

const SEARCH_SYNC_ALARM_DELAY_MS = 1_000;
const SEARCH_SIDE_EFFECT_PATHS = new Set([
  "/transaction",
  "/document",
  "/reconcile-documents",
  "/artifact"
]);

/**
 * Adds the derived INDEX001 search synchronization boundary without changing
 * canonical ProjectGuard authority or pulling projection work back from the
 * isolated MaterializationGuard.
 */
export class SearchSyncProjectGuard extends SubrequestResilientProjectGuard {
  private readonly searchSyncStore: ProjectSearchSyncStore | null;
  private readonly searchSynchronizer: ProjectSearchSynchronizer | null;
  private searchQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const projectId = ctx.id.name ?? null;
    if (this.layoutMode === "v2" && projectId && projectId !== "PRJ-AUTO") {
      initializeProjectSearchSyncSchema(this.ctx.storage);
      this.searchSyncStore = new ProjectSearchSyncStore(this.ctx.storage);
      const searchIndex = this.env.SEARCH_INDEX_GUARD.getByName("global");
      this.searchSynchronizer = new ProjectSearchSynchronizer(
        projectId,
        this.searchSyncStore,
        new DocumentLedgerRepository(this.persistence),
        (url, init) => searchIndex.fetch(url, init)
      );
    } else {
      this.searchSyncStore = null;
      this.searchSynchronizer = null;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/search-sync-status") {
      return this.serializeSearch(() => this.handleSearchSyncStatus());
    }
    if (request.method === "POST" && url.pathname === "/reconcile-search") {
      return this.serializeSearch(() => this.handleSearchReconcile(request));
    }

    return this.serializeSearch(async () => {
      const response = await super.fetch(request);
      if (SEARCH_SIDE_EFFECT_PATHS.has(url.pathname)) {
        await this.captureSearchSideEffects(url.pathname, response.clone());
      }
      return response;
    });
  }

  override async alarm(): Promise<void> {
    await this.serializeSearch(async () => {
      const state = await this.loadSearchState();
      if (state && this.searchSynchronizer) {
        await this.searchSynchronizer.runNext(state);
      }
    });

    // Base ProjectGuard owns no projection execution. Its alarm cleanup remains
    // separate from MaterializationGuard and we re-arm only derived search work.
    await super.alarm();
    await this.serializeSearch(() => this.ensureSearchAlarm());
  }

  private async handleSearchSyncStatus(): Promise<Response> {
    const state = await this.loadSearchState();
    if (!state || !this.searchSyncStore) {
      return Response.json({ error: "project_not_initialized" }, { status: 404 });
    }

    this.searchSyncStore.requestCanonical(state.revision);
    await this.ensureSearchAlarm();
    return Response.json({
      project_id: state.project_id,
      canonical_revision: state.revision,
      ...this.searchSyncStore.status()
    });
  }

  private async handleSearchReconcile(request: Request): Promise<Response> {
    const state = await this.loadSearchState();
    if (!state || !this.searchSyncStore) {
      return Response.json({ error: "project_not_initialized" }, { status: 404 });
    }

    let forceFull = false;
    try {
      const raw = await request.text();
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const keys = Object.keys(parsed);
        if (
          keys.some((key) => key !== "force_full")
          || (parsed.force_full !== undefined && typeof parsed.force_full !== "boolean")
        ) {
          return Response.json({ error: "invalid_reconcile_search_request" }, { status: 400 });
        }
        forceFull = parsed.force_full === true;
      }
    } catch {
      return Response.json({ error: "invalid_reconcile_search_request" }, { status: 400 });
    }

    this.searchSyncStore.requestCanonical(state.revision);
    if (forceFull) {
      this.forceCanonicalSearchReplay(state.revision);
      restartSearchDocumentEpoch(this.ctx.storage);
    }
    await this.ensureSearchAlarm();
    return Response.json({
      project_id: state.project_id,
      canonical_revision: state.revision,
      ...this.searchSyncStore.status()
    });
  }

  private async captureSearchSideEffects(pathname: string, response: Response): Promise<void> {
    if (!this.searchSyncStore || !response.ok) return;
    try {
      const body = await response.json<Record<string, unknown>>();
      if (pathname === "/transaction") {
        if (body.status === "committed" && Number.isSafeInteger(body.new_revision)) {
          this.searchSyncStore.requestCanonical(body.new_revision as number);
        }
      } else if (pathname === "/document") {
        if (body.status === "committed" && isDocumentId(body.document_id) && isSourceRequestId(body.request_id)) {
          this.searchSyncStore.requestDocumentsOnce(`document:${body.request_id}`, [body.document_id]);
        }
      } else if (pathname === "/reconcile-documents") {
        const changed = Array.isArray(body.changed_document_ids)
          ? body.changed_document_ids.filter(isDocumentId)
          : [];
        if (changed.length > 0) this.searchSyncStore.requestDocuments(changed);
      } else if (pathname === "/artifact") {
        if (body.status === "committed" && isSourceRequestId(body.request_id)) {
          this.searchSyncStore.requestFullDocumentSnapshotOnce(`artifact:${body.request_id}`);
        }
      }
      await this.ensureSearchAlarm();
    } catch (error) {
      console.error("Project OS search synchronization scheduling failed", {
        project_id: this.ctx.id.name ?? null,
        source_path: pathname,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async loadSearchState() {
    const boundProjectId = this.ctx.id.name;
    if (!boundProjectId) return null;
    const state = await this.loadOrRecoverState();
    if (!state) return null;
    if (state.project_id !== boundProjectId) {
      throw new Error(`ProjectGuard state binding mismatch: expected ${boundProjectId}, got ${state.project_id}`);
    }
    return state;
  }

  private forceCanonicalSearchReplay(revision: number): void {
    if (!this.searchSyncStore || revision <= 0) return;
    const status = this.searchSyncStore.status();
    if (status.canonical_revision_indexed < revision) return;
    this.ctx.storage.sql.exec(
      `UPDATE search_sync_control
       SET canonical_revision_indexed = ?, last_error = NULL
       WHERE singleton = 1`,
      revision - 1
    );
  }

  private async ensureSearchAlarm(): Promise<void> {
    if (!this.searchSyncStore?.needsWork()) return;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + SEARCH_SYNC_ALARM_DELAY_MS);
    }
  }

  private async serializeSearch<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.searchQueue;
    let release!: () => void;
    this.searchQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function isDocumentId(value: unknown): value is string {
  return typeof value === "string" && /^DOC-[A-F0-9]{24}$/.test(value);
}

function isSourceRequestId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 200
    && !/[\u0000-\u001F\u007F]/.test(value);
}
