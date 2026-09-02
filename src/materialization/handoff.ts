import type { Env } from "../env";

export async function requestMaterializationTargetSafely(
  env: Env,
  projectId: string,
  revision: number,
  projectionVersion: number
): Promise<void> {
  try {
    const response = await env.MATERIALIZATION_GUARD.getByName(projectId).fetch(
      "https://materialization-guard.internal/request-target",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          revision,
          projection_version: projectionVersion
        })
      }
    );
    if (!response.ok) {
      throw new Error(`MaterializationGuard returned ${response.status}`);
    }
  } catch (error) {
    console.error("Project OS materialization scheduling failed after canonical commit", {
      project_id: projectId,
      target_revision: revision,
      projection_version: projectionVersion,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
