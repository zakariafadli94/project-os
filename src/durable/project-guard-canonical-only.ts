import { CURRENT_PROJECTION_VERSION } from "../domain/materialization";
import type { Env } from "../env";
import { requestMaterializationTargetSafely } from "../materialization/handoff";
import { SubrequestResilientProjectGuard } from "./project-guard-subrequest-resilient";

const PROJECTION_FORWARD_PATHS = new Map<string, string>([
  ["/materialization-status", "/status"],
  ["/reconcile-materialization", "/reconcile"],
  ["/materialize", "/materialize"]
]);

/**
 * Production cutover boundary between canonical mutation and projection I/O.
 *
 * The legacy base classes still contain compatibility implementation details,
 * but the exported ProjectGuard never executes projection routes or alarms
 * locally. Projection work is handed to the separately bound
 * MaterializationGuard so it receives an independent Durable Object I/O
 * context.
 */
export class CanonicalOnlyProjectGuard extends SubrequestResilientProjectGuard {
  constructor(ctx: DurableObjectState, private readonly runtimeEnv: Env) {
    super(ctx, runtimeEnv);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const forwardedPath = PROJECTION_FORWARD_PATHS.get(url.pathname);
    if (forwardedPath && isProjectionCompatibilityMethod(request.method, url.pathname)) {
      const projectId = this.ctx.id.name;
      if (!projectId) {
        return Response.json({ error: "project_not_initialized" }, { status: 404 });
      }
      return this.runtimeEnv.MATERIALIZATION_GUARD.getByName(projectId).fetch(
        new Request(`https://materialization-guard.internal${forwardedPath}`, request)
      );
    }

    const canonicalTransaction = request.method === "POST" && url.pathname === "/transaction";
    const response = await super.fetch(request);
    if (canonicalTransaction && response.ok) {
      await this.handoffCommittedReceipt(response.clone());
    }
    return response;
  }

  override async alarm(): Promise<void> {
    // Existing ProjectGuard instances can retain a pre-cutover alarm. Drain it
    // without touching Dropbox. All new projection alarms belong to the
    // separate MaterializationGuard Durable Object.
    await this.ctx.storage.deleteAlarm();
  }

  private async handoffCommittedReceipt(response: Response): Promise<void> {
    const projectId = this.ctx.id.name;
    if (!projectId) return;

    let receipt: unknown;
    try {
      receipt = await response.json();
    } catch {
      return;
    }
    if (!isCommittedRevisionReceipt(receipt)) return;

    await requestMaterializationTargetSafely(
      this.runtimeEnv,
      projectId,
      receipt.new_revision,
      CURRENT_PROJECTION_VERSION
    );
  }
}

function isProjectionCompatibilityMethod(method: string, path: string): boolean {
  if (path === "/materialization-status") return method === "GET";
  return method === "POST";
}

function isCommittedRevisionReceipt(value: unknown): value is {
  status: "committed";
  new_revision: number;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { status?: unknown; new_revision?: unknown };
  return candidate.status === "committed"
    && Number.isSafeInteger(candidate.new_revision)
    && (candidate.new_revision as number) >= 0;
}
