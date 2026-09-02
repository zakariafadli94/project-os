import type { Env } from "../env";
import { parseReferralWriteRequest } from "../domain/referral-write";
import { normalizeProjectState } from "../domain/project-state-normalizer";
import { InputRecoveryService } from "../documents/input-recovery";
import { ReferralProvenanceRepository } from "../documents/referral-provenance";
import { DocumentLedgerRepository } from "../documents/repository";
import { machineStatePath } from "../persistence/layout";
import { resolveSchemaWriterStageForProject } from "../schema/writer-stage";
import { restartSearchDocumentEpoch } from "../search/project-sync-recovery";
import {
  initializeProjectSearchSyncSchema,
  ProjectSearchSyncStore
} from "../search/project-sync-store";
import { ProjectSearchSynchronizer } from "../search/project-synchronizer";
import { ProjectGuard as NeutralProjectGuard } from "./project-guard-neutral";

export * from "./project-guard-neutral";

interface StateRow {
  [key: string]: SqlStorageValue;
  state_json: string;
}

const SEARCH_SYNC_ALARM_DELAY_MS = 1_000;

export class ProjectGuard extends NeutralProjectGuard {
  private readonly referralProvenance: ReferralProvenanceRepository;
  private readonly inputRecovery: InputRecoveryService;
  private readonly searchSyncStore: ProjectSearchSyncStore | null;
  private readonly searchSynchronizer: ProjectSearchSynchronizer | null;
  private searchQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    const projectId = ctx.id.name ?? null;
    const writerStage = resolveSchemaWriterStageForProject(
      env.PROJECT_OS_SCHEMA_WRITER_STAGE,
      env.PROJECT_OS_SCHEMA_CANARY_PROJECT_ID,
      projectId,
      env.PROJECT_OS_SCHEMA_CORE_V2_FLOOR_PROJECT_IDS
    );
    super(ctx, {
      ...env,
      PROJECT_OS_SCHEMA_WRITER_STAGE: writerStage,
      PROJECT_OS_SCHEMA_CANARY_PROJECT_ID: undefined,
      PROJECT_OS_SCHEMA_CORE_V2_FLOOR_PROJECT_IDS: undefined
    });
    this.referralProvenance = new ReferralProvenanceRepository(this.persistence.objects);
    this.inputRecovery = new InputRecoveryService(this.persistence);

    if (this.layoutMode === "v2" && projectId) {
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
    if (request.method === "POST" && url.pathname === "/referral") {
      return this.handleReferral(request);
    }
    if (request.method === "POST" && url.pathname === "/recover-inputs") {
      return this.handleInputRecovery();
    }
    if (request.method === "GET" && url.pathname === "/search-sync-status") {
      return this.serializeSearch(() => this.handleSearchSyncStatus());
    }
    if (request.method === "POST" && url.pathname === "/reconcile-search") {
      return this.serializeSearch(() => this.handleSearchReconcile(request));
    }

    const response = await super.fetch(request);
    await this.serializeSearch(() => this.captureSearchSideEffects(request, response.clone()));
    return response;
  }

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.serializeSearch(async () => {
      const state = await this.loadSearchState();
      if (state && this.searchSynchronizer) {
        await this.searchSynchronizer.runNext(state);
      }
    });

    await super.alarm(alarmInfo);
    await this.serializeSearch(() => this.ensureSearchAlarm());
  }

  private async handleSearchSyncStatus(): Promise<Response> {
    const state = await this.loadSearchState();
    if (!state || !this.searchSyncStore) {
      return Response.json({ error: "project_not_initialized" }, { status: 404 });
    }

    this.searchSyncStore.requestCanonical(state.revision);
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
        if (keys.some((key) => key !== "force_full") || (parsed.force_full !== undefined && typeof parsed.force_full !== "boolean")) {
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

  private async captureSearchSideEffects(request: Request, response: Response): Promise<void> {
    if (!this.searchSyncStore || !response.ok) return;
    const pathname = new URL(request.url).pathname;
    if (!["/transaction", "/document", "/reconcile-documents", "/artifact"].includes(pathname)) return;

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

    // R0 exposes canonical recovery directly to subclasses. Search stays
    // downstream of canonical authority without using materialization as a
    // recovery side channel or adding a ProjectGuard -> MaterializationGuard hop.
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

  private async handleReferral(request: Request): Promise<Response> {
    let referral;
    try {
      referral = parseReferralWriteRequest(await request.json());
    } catch (error) {
      return Response.json({
        error: "invalid_referral_request",
        message: error instanceof Error ? error.message : "Invalid referral request"
      }, { status: 400 });
    }

    const boundProjectId = this.ctx.id.name;
    if (!boundProjectId || boundProjectId !== referral.target_project_id) {
      return Response.json({
        request_id: referral.request_id,
        source_project_id: referral.source_project_id,
        target_project_id: referral.target_project_id,
        relative_path: referral.relative_path,
        content_sha256: referral.content_sha256,
        status: "rejected",
        code: "PROJECT_BINDING_MISMATCH",
        message: "Durable Object binding does not match referral target_project_id"
      });
    }

    const state = await this.loadBoundState(boundProjectId);
    if (!state) {
      return Response.json({
        request_id: referral.request_id,
        source_project_id: referral.source_project_id,
        target_project_id: referral.target_project_id,
        relative_path: referral.relative_path,
        content_sha256: referral.content_sha256,
        status: "rejected",
        code: "PROJECT_NOT_INITIALIZED",
        message: "Target project state is not initialized"
      });
    }

    return Response.json(await this.referralProvenance.deliver(state, referral));
  }

  private async handleInputRecovery(): Promise<Response> {
    const boundProjectId = this.ctx.id.name;
    if (!boundProjectId) return Response.json({ error: "project_not_initialized" }, { status: 404 });
    const state = await this.loadBoundState(boundProjectId);
    if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });
    return Response.json({
      project_id: boundProjectId,
      ...await this.inputRecovery.recover(state)
    });
  }

  private async loadBoundState(projectId: string) {
    const row = this.ctx.storage.sql.exec<StateRow>(
      "SELECT state_json FROM project_state WHERE singleton = 1"
    ).toArray()[0];
    const rawState = row?.state_json ?? await this.persistence.objects.readText(machineStatePath(projectId));
    if (rawState === null) return null;
    const state = normalizeProjectState(JSON.parse(rawState));
    if (state.project_id !== projectId) {
      throw new Error(`ProjectGuard state binding mismatch: expected ${projectId}, got ${state.project_id}`);
    }
    return state;
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
