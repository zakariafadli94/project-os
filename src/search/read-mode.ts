import type { Env } from "../env";

export function searchReadEnabled(env: Pick<Env, "PROJECT_OS_SEARCH_READ_MODE">): boolean {
  return env.PROJECT_OS_SEARCH_READ_MODE === "on";
}

export function searchReadDisabledResponse(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}
