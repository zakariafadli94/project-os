import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ObjectPersistence } from "../persistence/provider/contract";
import { parseSchemaWriterStage, type SchemaWriterStage } from "./writer-stage";

export type SchemaDurableEvidenceStage = Exclude<SchemaWriterStage, "v1_only">;
export type SchemaEvidenceObserver = (stage: SchemaDurableEvidenceStage) => void;

interface SchemaRuntimePolicy {
  writerStage: SchemaWriterStage;
  evidenceObserver?: SchemaEvidenceObserver;
}

const policies = new WeakMap<object, SchemaRuntimePolicy>();

export function withSchemaRuntimePolicy(
  runtime: ProjectOsPersistenceRuntime,
  writerStageInput: SchemaWriterStage | string | undefined | null
): ProjectOsPersistenceRuntime {
  const writerStage = parseSchemaWriterStage(writerStageInput);
  let wrapped!: ProjectOsPersistenceRuntime;
  const wrappedObjects = wrapObjects(
    runtime.objects,
    () => policies.get(wrapped),
    inspectDurableEvidence
  );
  wrapped = {
    ...runtime,
    objects: wrappedObjects
  };
  policies.set(wrapped, { writerStage });
  return wrapped;
}

export function configureSchemaEvidenceObserver(
  runtime: ProjectOsPersistenceRuntime,
  observer: SchemaEvidenceObserver
): void {
  const policy = policies.get(runtime);
  if (!policy) {
    policies.set(runtime, { writerStage: "v1_only", evidenceObserver: observer });
    return;
  }
  policies.set(runtime, { ...policy, evidenceObserver: observer });
}

export function schemaWriterStageFor(
  runtime: ProjectOsPersistenceRuntime,
  fallback?: SchemaWriterStage
): SchemaWriterStage {
  return policies.get(runtime)?.writerStage ?? fallback ?? "v1_only";
}

function wrapObjects(
  objects: ObjectPersistence,
  policy: () => SchemaRuntimePolicy | undefined,
  inspect: (path: string, content: string) => SchemaDurableEvidenceStage | null
): ObjectPersistence {
  const observe = (path: string, content: string | null): void => {
    if (content === null) return;
    const stage = inspect(path, content);
    if (stage) policy()?.evidenceObserver?.(stage);
  };

  return {
    readText: async (path) => {
      const content = await objects.readText(path);
      observe(path, content);
      return content;
    },
    createText: async (path, content) => {
      await objects.createText(path, content);
      observe(path, content);
    },
    upsertText: async (path, content) => {
      await objects.upsertText(path, content);
      observe(path, content);
    },
    getMetadata: (path) => objects.getMetadata(path),
    listChildren: (path) => objects.listChildren(path),
    move: (from, to) => objects.move(from, to),
    delete: (path) => objects.delete(path),
    ...(objects.deleteIfUnchanged ? {
      deleteIfUnchanged: (path, expected) => objects.deleteIfUnchanged!(path, expected)
    } : {})
  };
}

function inspectDurableEvidence(path: string, content: string): SchemaDurableEvidenceStage | null {
  if (!path.startsWith("/PROJECT_OS/.project-os/projects/")) return null;
  const parsed = parseJsonRecord(content);
  if (!parsed) return null;

  if (isProviderBearingPath(path)) {
    return parsed.schema_version === "2.0" ? "provider_v2" : null;
  }

  if (isCoreStatePath(path) || isCoreManifestPath(path)) {
    return parsed.schema_version === "2.0" ? "core_v2" : null;
  }

  if (isCanonicalCommitPath(path)) {
    const nested = parsed.state;
    return isRecord(nested) && nested.schema_version === "2.0" ? "core_v2" : null;
  }

  return null;
}

function isProviderBearingPath(path: string): boolean {
  return /\/documents\/(?:heads|versions)\//.test(path)
    || /\/documents\/provider-file-bindings\/v2\//.test(path)
    || /\/documents\/reference-fingerprints\/v2\//.test(path)
    || /\/mutation-gate\/(?:intents\/artifacts|candidates)\//.test(path);
}

function isCoreStatePath(path: string): boolean {
  return /\/projects\/PRJ-[0-9]+\/state\.json$/.test(path);
}

function isCoreManifestPath(path: string): boolean {
  return /\/projects\/PRJ-[0-9]+\/manifest\.json$/.test(path);
}

function isCanonicalCommitPath(path: string): boolean {
  return /\/projects\/PRJ-[0-9]+\/commits\/REV-[0-9]+\.json$/.test(path);
}

function parseJsonRecord(content: string): Record<string, unknown> | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(content);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
