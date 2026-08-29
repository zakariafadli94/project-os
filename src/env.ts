import type { SchemaWriterStage } from "./schema/writer-stage";

export type Env = Omit<
  Cloudflare.Env,
  | "PROJECT_OS_LAYOUT_MODE"
  | "PROJECT_OS_CONTINUITY_MODE"
  | "PROJECT_OS_MUTATION_GATE_MODE"
  | "PROJECT_OS_SCHEMA_WRITER_STAGE"
  | "PROJECT_OS_SCHEMA_CANARY_PROJECT_ID"
> & {
  DROPBOX_APP_KEY: string;
  DROPBOX_APP_SECRET: string;
  DROPBOX_REFRESH_TOKEN: string;
  INGRESS_TOKEN: string;
  MUTATION_GATE_OPERATOR_TOKEN?: string;
  PROJECT_OS_LAYOUT_MODE?: "legacy" | "shadow" | "v2";
  PROJECT_OS_CONTINUITY_MODE?: "stable" | "automatic" | "rollback";
  PROJECT_OS_MUTATION_GATE_MODE?: "observe" | "enforce";
  PROJECT_OS_SCHEMA_WRITER_STAGE?: SchemaWriterStage;
  PROJECT_OS_SCHEMA_CANARY_PROJECT_ID?: string;
  PROJECT_OS_PROJECTION_CONCURRENCY?: string;
};
