import { DurableObject } from "cloudflare:workers";
import { CURRENT_PROJECTION_VERSION } from "../domain/materialization";
import type { Env } from "../env";
import { MaterializationCoordinator } from "../materialization/coordinator";
import { initializeMaterializationSchema, MaterializationLedger } from "../materialization/ledger";
import { parseProjectionConcurrency, WorkspaceProjectionWriter } from "../materialization/writer";
import { parseLayoutMode } from "../persistence/layout";
import { createProductionPersistence } from "../persistence/production-factory";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { ProjectRepository } from "../persistence/repository";

const MATERIALIZATION_ALARM_DELAY_MS = 1_000;

export interface MaterializationTargetRequestBody {
  project_id: string;
  revision: number;
  projection_version: number;
}

export class MaterializationGuard extends DurableObject<Env> {
  private readonly projectId: string;
  private readonly persistence: ProjectOsPersistenceRuntime;
  private readonly repository: ProjectRepository;
  private readonly ledger: MaterializationLedger;
  private readonly coordinator: MaterializationCoordinator;
  private queue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const projectId = ctx.id.name;
    if (!projectId || !/^PRJ-[0-9]{4,}$/.test(projectId)) {
      throw new Error("MaterializationGuard requires a named PRJ-xxxx Durable Object instance");
    }
    this.projectId = projectId;
    initializeMaterializationSchema(ctx.storage);
    this.persistence = createProductionPersistence(env);
    this.repository = new ProjectRepository(this.persistence, parseLayoutMode(env.PROJECT_OS_LAYOUT_MODE));
    this.ledger = new MaterializationLedger(ctx.storage);
    this.coordinator = new MaterializationCoordinator({
      projectId,
      repository: this.repository,
      ledger: this.ledger,
      writer: new WorkspaceProjectionWriter(
        this.persistence.objects,
        parseProjectionConcurrency(env.PROJECT_OS_PROJECTION_CONCURRENCY)
      ),
      projectionVersion: CURRENT_PROJECTION_VERSION
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/request-target") {
      return this.serialize(() => this.handleRequestTarget(request));
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    // Projection execution moves here in the next TDD task. The alarm exists
    // now only so /request-target can durably schedule future work.
  }

  private async handleRequestTarget(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_materialization_target" }, { status: 400 });
    }

    if (!isMaterializationTargetRequestBody(body)) {
      return Response.json({ error: "invalid_materialization_target" }, { status: 400 });
    }
    if (body.project_id !== this.projectId) {
      return Response.json({ error: "project_binding_mismatch" }, { status: 409 });
    }

    this.coordinator.requestTarget(body.revision, body.projection_version);
    await this.ensureAlarm();
    return Response.json({
      project_id: this.projectId,
      requested: this.coordinator.status().requested
    });
  }

  private async ensureAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + MATERIALIZATION_ALARM_DELAY_MS);
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function isMaterializationTargetRequestBody(value: unknown): value is MaterializationTargetRequestBody {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MaterializationTargetRequestBody>;
  return typeof candidate.project_id === "string"
    && /^PRJ-[0-9]{4,}$/.test(candidate.project_id)
    && Number.isSafeInteger(candidate.revision)
    && (candidate.revision as number) >= 0
    && Number.isSafeInteger(candidate.projection_version)
    && (candidate.projection_version as number) >= 1;
}
