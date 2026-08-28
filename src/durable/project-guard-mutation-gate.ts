import type { ArtifactWriteReceipt, ArtifactWriteRequest } from "../domain/artifact-write";
import {
  parseMutationCandidateResolutionRequest,
  type MutationCandidateAdoptArtifactRequest,
  type MutationCandidateAdoptWorkingRequest
} from "../domain/mutation-candidate-resolution";
import type { ProjectState } from "../domain/project-state";
import { normalizeProjectState } from "../domain/project-state-normalizer";
import type { Env } from "../env";
import { ProviderOperationError } from "../persistence/provider/errors";
import { ArtifactContentConflictError, ProjectRepository } from "../persistence/repository";
import {
  MutationCandidateResolutionService,
  type CandidateResolutionDownstreamReceipt
} from "../mutation-gate/resolution-service";
import {
  createCandidateResolutionContext,
  MutationGateService,
  parseMutationGateMode
} from "../mutation-gate/service";
import { ProjectGuard as BaseProjectGuard } from "./project-guard";

interface StateRow {
  [key: string]: SqlStorageValue;
  state_json: string;
}

interface ArtifactRow {
  [key: string]: SqlStorageValue;
  request_json: string;
  receipt_json: string;
}

const OUTER_MUTATION_PATHS = new Set([
  "/transaction",
  "/artifact",
  "/document",
  "/reconcile-documents",
  "/materialize",
  "/reconcile-materialization"
]);

export class MutationGateProjectGuard extends BaseProjectGuard {
  private readonly gate: MutationGateService;
  private readonly gateMode: "observe" | "enforce";
  private readonly boundProjectId: string;
  private readonly resolutionService: MutationCandidateResolutionService;
  private readonly resolutionRepository: ProjectRepository;
  private outerQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.boundProjectId = this.ctx.id.name ?? "";
    this.gateMode = parseMutationGateMode(env.PROJECT_OS_MUTATION_GATE_MODE);
    this.gate = new MutationGateService(this.persistence, this.gateMode);
    this.resolutionService = new MutationCandidateResolutionService(this.persistence);
    this.resolutionRepository = new ProjectRepository(
      this.persistence,
      this.layoutMode,
      this.gateMode
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/mutation-candidates") {
      if (!this.boundProjectId) return Response.json({ error: "project_not_initialized" }, { status: 404 });
      return Response.json({
        project_id: this.boundProjectId,
        gate_mode: this.gateMode,
        candidates: await this.gate.list(this.boundProjectId)
      });
    }

    if (request.method === "GET" && url.pathname === "/mutation-candidate-status") {
      const candidateId = url.searchParams.get("candidate_id");
      if (!candidateId || !/^MUTCAND-[A-F0-9]{24}$/.test(candidateId)) {
        return Response.json({ error: "invalid_candidate_id" }, { status: 400 });
      }
      if (!this.boundProjectId) return Response.json({ error: "project_not_initialized" }, { status: 404 });
      const status = await this.gate.status(this.boundProjectId, candidateId);
      if (!status) return Response.json({ error: "candidate_not_found" }, { status: 404 });
      return Response.json(status);
    }

    if (request.method === "POST" && url.pathname === "/mutation-candidate-resolution") {
      return this.serializeMutation(() => this.handleCandidateResolution(request));
    }

    if (request.method === "POST" && OUTER_MUTATION_PATHS.has(url.pathname)) {
      return this.serializeMutation(async () => this.decorateResponse(request, await super.fetch(request)));
    }

    return this.decorateResponse(request, await super.fetch(request));
  }

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    return this.serializeMutation(() => super.alarm(alarmInfo));
  }

  private async handleCandidateResolution(request: Request): Promise<Response> {
    let resolution;
    try {
      resolution = parseMutationCandidateResolutionRequest(await request.json());
    } catch (error) {
      return Response.json({
        error: "invalid_mutation_candidate_resolution",
        message: error instanceof Error ? error.message : "Invalid mutation candidate resolution request"
      }, { status: 400 });
    }

    if (!this.boundProjectId) return Response.json({ error: "project_not_initialized" }, { status: 404 });
    if (this.boundProjectId !== resolution.project_id) {
      return Response.json({
        resolution_id: resolution.resolution_id,
        project_id: resolution.project_id,
        candidate_id: resolution.candidate_id,
        action: resolution.operation === "candidate.adopt_artifact"
          ? "adopt_as_artifact"
          : resolution.operation === "candidate.adopt_working"
            ? "adopt_as_working"
            : "reject",
        status: "rejected",
        code: "PROJECT_BINDING_MISMATCH",
        message: "Durable Object binding does not match candidate resolution project_id"
      });
    }

    try {
      const state = await this.loadResolutionState();
      if (!state) return Response.json({ error: "project_not_initialized" }, { status: 404 });

      const receipt = await this.resolutionService.resolve(resolution, state, {
        artifact: (adoption, currentState, candidatePath) =>
          this.executeArtifactAdoption(adoption, currentState, candidatePath),
        working: (adoption, currentState) =>
          this.executeWorkingAdoption(adoption, currentState)
      });
      return Response.json(receipt);
    } catch (error) {
      if (error instanceof ProviderOperationError && error.retryable) {
        return providerUnavailableResponse(error);
      }
      throw error;
    }
  }

  private async executeArtifactAdoption(
    adoption: MutationCandidateAdoptArtifactRequest,
    state: ProjectState,
    candidatePath: string
  ): Promise<ArtifactWriteReceipt> {
    const artifact = adoption.artifact_request;
    const serialized = JSON.stringify(artifact);
    const existing = this.findResolutionArtifact(artifact.request_id);
    if (existing) {
      if (existing.request_json !== serialized) {
        return artifactReceipt(
          artifact,
          "rejected",
          "IDEMPOTENCY_PAYLOAD_MISMATCH",
          "The same request_id was reused with different artifact content or path"
        );
      }
      return JSON.parse(existing.receipt_json) as ArtifactWriteReceipt;
    }

    const context = createCandidateResolutionContext(adoption.candidate_id, candidatePath);
    try {
      await this.resolutionRepository.writeArtifact(state, artifact, undefined, context);
    } catch (error) {
      if (error instanceof ArtifactContentConflictError) {
        return artifactReceipt(artifact, "conflict", "ARTIFACT_CONTENT_CONFLICT", error.message);
      }
      throw error;
    }

    const receipt = artifactReceipt(artifact, "committed");
    await this.resolutionRepository.writeArtifactReceipt(receipt);
    this.persistResolutionArtifact(artifact, receipt);
    return receipt;
  }

  private async executeWorkingAdoption(
    adoption: MutationCandidateAdoptWorkingRequest,
    _state: ProjectState
  ): Promise<CandidateResolutionDownstreamReceipt> {
    const response = await super.fetch(new Request("https://project-guard.internal/document", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(adoption.document_request)
    }));
    if (!response.ok) {
      return {
        status: "rejected",
        code: "DOWNSTREAM_DOCUMENT_ROUTE_FAILED",
        message: `ProjectGuard document route returned ${response.status}`
      };
    }
    return response.json<CandidateResolutionDownstreamReceipt>();
  }

  private async loadResolutionState(): Promise<ProjectState | null> {
    let state = this.localResolutionState();
    if (state) return state;

    // Force the base guard through its canonical recovery path without making
    // any business mutation, then read the recovered durable-object snapshot.
    await super.fetch(new Request("https://project-guard.internal/materialization-status", { method: "GET" }));
    state = this.localResolutionState();
    return state;
  }

  private localResolutionState(): ProjectState | null {
    const row = this.ctx.storage.sql.exec<StateRow>(
      "SELECT state_json FROM project_state WHERE singleton = 1"
    ).toArray()[0];
    return row ? normalizeProjectState(JSON.parse(row.state_json)) : null;
  }

  private findResolutionArtifact(requestId: string): ArtifactRow | null {
    return this.ctx.storage.sql.exec<ArtifactRow>(
      "SELECT request_json, receipt_json FROM artifact_requests WHERE request_id = ?",
      requestId
    ).toArray()[0] ?? null;
  }

  private persistResolutionArtifact(request: ArtifactWriteRequest, receipt: ArtifactWriteReceipt): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO artifact_requests (request_id, request_json, receipt_json) VALUES (?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET request_json = excluded.request_json, receipt_json = excluded.receipt_json`,
      request.request_id,
      JSON.stringify(request),
      JSON.stringify(receipt)
    );
  }

  private async decorateResponse(request: Request, response: Response): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/reconcile-documents" && response.ok) {
      const body = await response.json<Record<string, unknown>>();
      const candidates = typeof body.candidates === "number" ? body.candidates : 0;
      return Response.json({
        ...body,
        mutation_gate_mode: this.gateMode,
        policy_violations: this.gateMode === "enforce" ? candidates : 0
      });
    }

    if (request.method === "POST" && url.pathname === "/artifact" && response.ok) {
      const body = await response.json<Record<string, unknown>>();
      if (
        body.status === "conflict"
        && body.code === "ARTIFACT_CONTENT_CONFLICT"
        && typeof body.message === "string"
        && body.message.startsWith("Unresolved external mutation candidate")
      ) {
        return Response.json({ ...body, code: "UNRESOLVED_EXTERNAL_CANDIDATE" });
      }
      return Response.json(body);
    }

    return response;
  }

  private async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.outerQueue;
    let release!: () => void;
    this.outerQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function providerUnavailableResponse(error: ProviderOperationError): Response {
  const diagnostics = error.diagnostics;
  const body: Record<string, unknown> = {
    error: "persistence_provider_unavailable",
    provider_id: diagnostics?.providerId ?? "unknown"
  };
  if (diagnostics?.operation) body.provider_operation = diagnostics.operation;
  if (typeof diagnostics?.status === "number") body.provider_status = diagnostics.status;
  if (diagnostics?.code) body.provider_code = diagnostics.code;
  if (typeof diagnostics?.requestId === "string") body.provider_request_id = diagnostics.requestId;
  return Response.json(body, { status: 503 });
}

function artifactReceipt(
  request: ArtifactWriteRequest,
  status: ArtifactWriteReceipt["status"],
  code?: string,
  message?: string
): ArtifactWriteReceipt {
  return {
    request_id: request.request_id,
    project_id: request.project_id,
    relative_path: request.relative_path,
    content_sha256: request.content_sha256,
    status,
    ...(code ? { code } : {}),
    ...(message ? { message } : {})
  };
}
