import { DocumentLedgerRepository } from "../documents/repository";
import type { Env } from "../env";
import { restartSearchDocumentEpoch } from "../search/project-sync-recovery";
import {
  initializeProjectSearchSyncSchema,
  ProjectSearchSyncStore
} from "../search/project-sync-store";
import { ProjectSearchSynchronizer } from "../search/project-synchronizer";
import { searchSyncEnabled } from "../search/sync-mode";
import type { RequestKind } from "../persistence/observation";
import { SubrequestResilientProjectGuard } from "./project-guard-subrequest-resilient";

const SEARCH_SIDE_EFFECT_PATHS = new Set([
  "/transaction",
  "/document",
  "/reconcile-documents",
  "/artifact"
]);
const OBSERVATION_PATHS = new Set([
  "/mutation-context",
  "/context",
  "/request-status",
  "/execution-status",
  "/receipt"
]);

/**
 * Adds the derived INDEX001 search synchronization boundary without changing
 * canonical ProjectGuard authority or pulling projection work back from the
 * isolated MaterializationGuard. Search wake/retry alarms live in SearchSyncGuard.
 */
export class SearchSyncProjectGuard extends SubrequestResilientProjectGuard {
  private readonly searchSyncStore: ProjectSearchSyncStore | null;
  private readonly searchSynchronizer: ProjectSearchSynchronizer | null;
  private searchQueue: Promise<void> = Promise.resolve();
  private searchQueueDepth = 0;
  private searchWakeInFlight: Promise<void> | null = null;

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
    // These reads do not mutate search state. Keep them outside the derived
    // search queue so a long finalization cannot delay admission/status reads.
    if (request.method === "GET" && OBSERVATION_PATHS.has(url.pathname)) {
      // A request may still be waiting in this outer queue before the base
      // guard knows about it. Never report false absence for such an intent.
      if (url.pathname !== "/mutation-context" && this.searchQueueDepth > 0) {
        const projectId = this.ctx.id.name;
        const kind = url.searchParams.get("kind");
        const requestId = url.searchParams.get("request_id");
        if (projectId && url.searchParams.has("project_id") && url.searchParams.get("project_id") !== projectId
          && ["/request-status", "/receipt"].includes(url.pathname)) {
          return Response.json({ error: url.pathname === "/receipt" ? "receipt_not_found" : "request_identity_mismatch" }, { status: 404 });
        }
        if (projectId && kind && requestId && ["transaction", "document", "artifact"].includes(kind)) {
          if (url.pathname === "/execution-status") {
            return this.readExecutionStatusWhileBusy(projectId, kind, requestId,
              this.observationCorrelationId(request, url));
          }
          if (url.pathname === "/request-status") {
            const observed = await this.readStoredRequestObservation(projectId, kind as RequestKind, requestId);
            if (observed) return observed;
            return this.readFinalizedRequestStatusWhileBusy(url, projectId, kind, requestId,
              this.observationCorrelationId(request, url));
          }
          if (url.pathname === "/receipt") {
            const observed = await this.readStoredRequestObservation(projectId, kind as RequestKind, requestId);
            if (observed) {
              const body = await observed.clone().json() as Record<string, unknown>;
              if (body.receipt && ["committed", "rejected", "conflict"].includes(String((body.receipt as Record<string, unknown>).status))) {
                return Response.json(body.receipt);
              }
            }
            const local = await this.handleReceiptRead(url);
            if (local.status !== 404) return local;
            try {
              const canonical = await this.readBoundedRequestStatusReceipt(projectId, kind as RequestKind, requestId);
              if (canonical) return Response.json(canonical);
            } catch {
              // Absence is not proven while outer work is queued.
            }
          }
          return this.unknownObservationResponse(projectId, kind, requestId,
            this.observationCorrelationId(request, url), "PROJECT_OS_READ_BUSY");
        }
        if (projectId && requestId && url.pathname === "/execution-status") {
          const correlationId = this.observationCorrelationId(request, url);
          return Response.json({ project_id: projectId, kind, request_id: requestId,
            status: "unknown", code: "PROJECT_OS_READ_BUSY", correlation_id: correlationId }, { status: 503, headers: { "Retry-After": "1" } });
        }
      }
      return super.fetch(request);
    }
    if (request.method === "GET" && url.pathname === "/search-sync-status") {
      return this.serializeSearch(() => this.handleSearchSyncStatus());
    }
    if (request.method === "POST" && url.pathname === "/reconcile-search") {
      return this.serializeSearch(() => this.handleSearchReconcile(request));
    }
    if (request.method === "POST" && url.pathname === "/drain-search") {
      return this.serializeSearch(() => this.handleSearchDrain());
    }

    return this.serializeSearch(async () => {
      const response = await super.fetch(request);
      if (SEARCH_SIDE_EFFECT_PATHS.has(url.pathname)) {
        await this.captureSearchSideEffects(url.pathname, response.clone());
      }
      return response;
    });
  }

  private async handleSearchSyncStatus(): Promise<Response> {
    const state = await this.loadSearchState();
    if (!state || !this.searchSyncStore) {
      return Response.json({ error: "project_not_initialized" }, { status: 404 });
    }

    return Response.json({
      project_id: state.project_id,
      canonical_revision: state.revision,
      sync_enabled: searchSyncEnabled(this.env),
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

    if (searchSyncEnabled(this.env)) {
      this.searchSyncStore.requestCanonical(state.revision);
      if (forceFull) {
        this.forceCanonicalSearchReplay(state.revision);
        restartSearchDocumentEpoch(this.ctx.storage);
      }
      await this.ensureSearchWakeupSafely();
    }
    return Response.json({
      project_id: state.project_id,
      canonical_revision: state.revision,
      sync_enabled: searchSyncEnabled(this.env),
      ...this.searchSyncStore.status()
    });
  }

  private async handleSearchDrain(): Promise<Response> {
    const state = await this.loadSearchState();
    if (!state || !this.searchSyncStore || !this.searchSynchronizer) {
      return Response.json({ error: "project_not_initialized" }, { status: 404 });
    }

    if (!searchSyncEnabled(this.env)) {
      return Response.json({
        project_id: state.project_id,
        canonical_revision: state.revision,
        sync_enabled: false,
        ...this.searchSyncStore.status(),
        more_work: false
      });
    }

    const result = await this.searchSynchronizer.runNext(state);
    return Response.json({
      project_id: state.project_id,
      canonical_revision: state.revision,
      sync_enabled: true,
      ...result,
      ...this.searchSyncStore.status(),
      more_work: this.searchSyncStore.needsWork()
    });
  }

  private async captureSearchSideEffects(pathname: string, response: Response): Promise<void> {
    if (!this.searchSyncStore || !response.ok || !searchSyncEnabled(this.env)) return;
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
      if (this.searchSyncStore.needsWork()) {
        this.ctx.waitUntil(this.startSearchWakeup());
      }
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
    await this.fastForwardFromLatestCanonicalCommit();
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

  private async ensureSearchWakeupSafely(): Promise<void> {
    if (!searchSyncEnabled(this.env) || !this.searchSyncStore?.needsWork()) return;
    await this.startSearchWakeup();
  }

  private startSearchWakeup(): Promise<void> {
    if (!searchSyncEnabled(this.env) || !this.searchSyncStore?.needsWork()) {
      return Promise.resolve();
    }
    if (this.searchWakeInFlight) return this.searchWakeInFlight;

    const attempt = (async () => {
      try {
        const projectId = this.ctx.id.name;
        if (!projectId || projectId === "PRJ-AUTO") return;
        const response = await this.env.SEARCH_SYNC_GUARD.getByName(projectId).fetch(
          "https://search-sync.internal/wake",
          { method: "POST" }
        );
        if (!response.ok) throw new Error(`SearchSyncGuard wake returned ${response.status}`);
      } catch (error) {
        console.error("Project OS search synchronization wake failed", {
          project_id: this.ctx.id.name ?? null,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    })();

    this.searchWakeInFlight = attempt.then(() => {
      if (this.searchWakeInFlight) this.searchWakeInFlight = null;
    });
    return this.searchWakeInFlight;
  }

  private async serializeSearch<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.searchQueue;
    let release!: () => void;
    this.searchQueue = new Promise<void>((resolve) => { release = resolve; });
    this.searchQueueDepth += 1;
    await previous;
    try {
      return await operation();
    } finally {
      this.searchQueueDepth -= 1;
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
