export type SchemaWriterStage = "v1_only" | "core_v2" | "provider_v2";

const WRITER_STAGE_RANK: Record<SchemaWriterStage, number> = {
  v1_only: 0,
  core_v2: 1,
  provider_v2: 2
};

export function parseSchemaWriterStage(value: string | undefined | null): SchemaWriterStage {
  if (value === undefined || value === null || value === "") {
    return "v1_only";
  }
  if (value === "v1_only" || value === "core_v2" || value === "provider_v2") {
    return value;
  }
  throw new Error(`Unsupported schema writer stage: ${value}`);
}

export function resolveSchemaWriterStageForProject(
  configuredValue: string | undefined | null,
  canaryProjectId: string | undefined | null,
  projectId: string | undefined | null
): SchemaWriterStage {
  const configured = parseSchemaWriterStage(configuredValue);
  if (canaryProjectId === undefined || canaryProjectId === null || canaryProjectId === "") {
    return configured;
  }
  if (!/^PRJ-[0-9]{4,}$/.test(canaryProjectId)) {
    throw new Error(`Invalid schema canary project id: ${canaryProjectId}`);
  }
  if (configured === "v1_only") return "v1_only";
  return projectId === canaryProjectId ? configured : "v1_only";
}

export function assertWriterStageAtLeast(
  actual: SchemaWriterStage,
  required: SchemaWriterStage
): void {
  if (WRITER_STAGE_RANK[actual] < WRITER_STAGE_RANK[required]) {
    throw new Error(
      `Schema writer stage ${actual} does not satisfy required stage ${required}`
    );
  }
}

export function assertNoWriterStageRegression(
  previous: SchemaWriterStage,
  next: SchemaWriterStage
): void {
  if (WRITER_STAGE_RANK[next] < WRITER_STAGE_RANK[previous]) {
    throw new Error(
      `Schema writer stage regression is forbidden: ${previous} -> ${next}`
    );
  }
}

export function writesCoreV2(stage: SchemaWriterStage): boolean {
  return WRITER_STAGE_RANK[stage] >= WRITER_STAGE_RANK.core_v2;
}

export function writesProviderV2(stage: SchemaWriterStage): boolean {
  return WRITER_STAGE_RANK[stage] >= WRITER_STAGE_RANK.provider_v2;
}
