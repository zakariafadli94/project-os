import type { Env } from "../env";
import { withSchemaRuntimePolicy } from "../schema/runtime-policy";
import {
  requireProjectOsPersistence,
  type ProjectOsPersistenceRuntime
} from "./provider/capabilities";
import { withProviderResilience } from "./provider/resilience";
import { createDropboxPersistence } from "./providers/dropbox/adapter";
import { DropboxClient } from "./providers/dropbox/client";

export function createProductionPersistence(env: Env): ProjectOsPersistenceRuntime {
  const raw = new DropboxClient({
    appKey: env.DROPBOX_APP_KEY,
    appSecret: env.DROPBOX_APP_SECRET,
    refreshToken: env.DROPBOX_REFRESH_TOKEN
  });
  const runtime = requireProjectOsPersistence(withProviderResilience(createDropboxPersistence(raw)));
  return withSchemaRuntimePolicy(runtime, env.PROJECT_OS_SCHEMA_WRITER_STAGE);
}
