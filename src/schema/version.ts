export const DURABLE_SCHEMA_VERSIONS = ["1.0", "2.0"] as const;

export type DurableSchemaVersion = (typeof DURABLE_SCHEMA_VERSIONS)[number];

function renderVersion(version: unknown): string {
  if (version === undefined || version === null || version === "") {
    return "missing";
  }
  if (typeof version === "string") {
    return version;
  }
  try {
    return JSON.stringify(version);
  } catch {
    return String(version);
  }
}

export function unsupportedSchemaVersion(family: string, version: unknown): never {
  throw new Error(
    `Unsupported schema version for ${family}: ${renderVersion(version)}`
  );
}

export function assertDurableSchemaVersion(
  version: unknown,
  family: string
): DurableSchemaVersion {
  if (version === "1.0" || version === "2.0") {
    return version;
  }
  return unsupportedSchemaVersion(family, version);
}
