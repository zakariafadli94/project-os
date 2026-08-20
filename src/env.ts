import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export interface Env {
  PROJECT_GUARD: DurableObjectNamespace;
  REGISTRY_GUARD: DurableObjectNamespace;
  DROPBOX_APP_KEY: string;
  DROPBOX_APP_SECRET: string;
  DROPBOX_REFRESH_TOKEN: string;
  INGRESS_TOKEN: string;
}
