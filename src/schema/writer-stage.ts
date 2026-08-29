export type SchemaWriterStage = "v1_only" | "core_v2" | "provider_v2";

const WRITER_STAGE_RANK: Record<SchemaWriterStage, number> = {
  v1_only: 0,
  core_v2: 1,
  provider_v2: 2
};

const PROJECT_ID_PATTERN = /^PRJ-[0-9]{4,}$/;

export function parseSchemaWriterStage(value: string | undefined | null): SchemaWriterStage {
  if (value === undefined || value === null || value === "") {
    return "v1_only";
  }
  if (value === "v1_only" || value === "core_v2" || value === "provider_v2") {
    return value;
  }
  throw new Error(`Unsupported schema writer stage: ${value}`);
}

function parseCoreV2FloorProjectIds(value: string | undefined | null): Set<string> {
  if (value === undefined || value === null || value.trim() === "") return new Set();

  const ids = value.split(",").map((item) => item.trim()).filter(Boolean);
  for (const id of ids) {
    if (!PROJECT_ID_PATTERN.test(id)) {
      throw new Error(`Invalid schema core-v2 floor project id: ${id}`);
    }
  }
  return new Set(ids);
}

export function resolveSchemaWriterStageForProject(
  configuredValue: string | undefined | null,
  canaryProjectId: string | undefined | null,
  projectId: string | undefined | null,
  coreV2FloorProjectIds?: string | undefined | null
): SchemaWriterStage {
  const configured = parseSchemaWriterStage(configuredValue);
  const floorProjects = parseCoreV2FloorProjectIds(coreV2FloorProjectIds);

  const hasCanary = canaryProjectId !== undefined && canaryProjectId !== null && canaryProjectId !== "";
  if (hasCanary && !PROJECT_ID_PATTERN.test(canaryProjectId)) {
    throw new Error(`Invalid schema canary project id: ${canaryProjectId}`);
  }

  let resolved: SchemaWriterStage;
  if (!hasCanary) {
    resolved = configured;
  } else if (configured === "v1_only") {
    resolved = "v1_only";
  } else {
    resolved = projectId === canaryProjectId ? configured : "v1_only";
  }

  if (
    projectId !== undefined &&
    projectId !== null &&
    floorProjects.has(projectId) &&
    WRITER_STAGE_RANK[resolved] < WRITER_STAGE_RANK.core_v2
  ) {
    return "core_v2";
  }

  return resolved;
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
