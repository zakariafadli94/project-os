import { z } from "zod";
import type { ProjectState } from "../domain/project-state";
import type { DurableSchemaVersion } from "./version";
import { assertDurableSchemaVersion, unsupportedSchemaVersion } from "./version";
import type { SchemaWriterStage } from "./writer-stage";
import { writesCoreV2 } from "./writer-stage";

const timestamp = z.string().datetime({ offset: true });
const projectId = z.string().regex(/^PRJ-[0-9]{4,}$/);
const status = z.enum(["active", "paused", "completed", "archived"]);

const manifestV1Schema = z.strictObject({
  schema_version: z.literal("1.0"),
  project_id: projectId,
  slug: z.string().min(1),
  revision: z.number().int().nonnegative(),
  status,
  last_event_id: z.string().nullable(),
  updated_at: timestamp
});

const manifestV2Schema = z.strictObject({
  schema_version: z.literal("2.0"),
  project_id: projectId,
  slug: z.string().min(1),
  revision: z.number().int().nonnegative(),
  status,
  last_event_id: z.string().nullable(),
  project_state_schema_version: z.string().min(1),
  updated_at: timestamp
});

export interface CurrentManifest {
  schema_version: "1.0" | "2.0";
  project_id: string;
  slug: string;
  revision: number;
  status: "active" | "paused" | "completed" | "archived";
  last_event_id: string | null;
  project_state_schema_version: DurableSchemaVersion;
  updated_at: string;
}

function requireRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Machine manifest must be an object");
  }
  return input as Record<string, unknown>;
}

function assertStateBinding(
  manifest: CurrentManifest,
  expectedProjectStateSchemaVersion?: DurableSchemaVersion
): CurrentManifest {
  if (
    expectedProjectStateSchemaVersion !== undefined
    && manifest.project_state_schema_version !== expectedProjectStateSchemaVersion
  ) {
    throw new Error(
      `Machine manifest state-schema binding mismatch: manifest=${manifest.project_state_schema_version}, state=${expectedProjectStateSchemaVersion}`
    );
  }
  return manifest;
}

export function readManifest(
  input: unknown,
  expectedProjectStateSchemaVersion?: DurableSchemaVersion
): CurrentManifest {
  const raw = requireRecord(input);
  if (raw.schema_version === "1.0") {
    const parsed = manifestV1Schema.parse(raw);
    return assertStateBinding(
      {
        ...parsed,
        project_state_schema_version: "1.0"
      },
      expectedProjectStateSchemaVersion
    );
  }

  if (raw.schema_version === "2.0") {
    const parsed = manifestV2Schema.parse(raw);
    const projectStateVersion = assertDurableSchemaVersion(
      parsed.project_state_schema_version,
      "Manifest ProjectState pointer"
    );
    return assertStateBinding(
      {
        ...parsed,
        project_state_schema_version: projectStateVersion
      },
      expectedProjectStateSchemaVersion
    );
  }

  return unsupportedSchemaVersion("machine manifest", raw.schema_version);
}

export function encodeManifest(
  state: ProjectState,
  stage: SchemaWriterStage
): unknown {
  if (!writesCoreV2(stage)) {
    if (state.schema_version === "2.0") {
      throw new Error("Machine manifest cannot regress a ProjectState V2 snapshot to a V1 pointer");
    }
    return manifestV1Schema.parse({
      schema_version: "1.0",
      project_id: state.project_id,
      slug: state.slug,
      revision: state.revision,
      status: state.status,
      last_event_id: state.last_event_id,
      updated_at: state.updated_at
    });
  }

  return manifestV2Schema.parse({
    schema_version: "2.0",
    project_id: state.project_id,
    slug: state.slug,
    revision: state.revision,
    status: state.status,
    last_event_id: state.last_event_id,
    project_state_schema_version: "2.0",
    updated_at: state.updated_at
  });
}
