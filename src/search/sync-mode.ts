import type { Env } from "../env";

export function searchSyncEnabled(env: Pick<Env, "PROJECT_OS_SEARCH_SYNC_MODE">): boolean {
  return env.PROJECT_OS_SEARCH_SYNC_MODE === "on";
}
