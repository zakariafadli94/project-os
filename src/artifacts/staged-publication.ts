import type { StagedArtifactWriteRequest } from "../domain/artifact-write";
import type { ResolvedArtifactDestination } from "../persistence/artifact-routing";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import {
  machineArtifactReplacementBackupPath,
  machineArtifactRollbackEvidencePath
} from "../persistence/layout";
import { ProviderConflictError } from "../persistence/provider/errors";
import { sha256Text } from "../documents/hash";

export class StagedArtifactConflictError extends Error {
  constructor(path: string) {
    super(`Staged artifact destination conflict: ${path}`);
    this.name = "StagedArtifactConflictError";
  }
}

export class StagedArtifactSourceMismatchError extends Error {
  constructor(reason: string) {
    super(`Staged artifact source mismatch: ${reason}`);
    this.name = "StagedArtifactSourceMismatchError";
  }
}

export class StagedArtifactPublisher {
  constructor(private readonly runtime: ProjectOsPersistenceRuntime) {}

  async publish(
    request: StagedArtifactWriteRequest,
    destination: ResolvedArtifactDestination
  ): Promise<"written" | "idempotent"> {
    const source = await this.runtime.objects.getMetadata(request.source.path);
    this.assertSource(request, source);

    const existing = await this.runtime.objects.getMetadata(destination.path);
    if (existing && samePayload(source!, existing)) return "idempotent";
    if (existing && request.mode === "create") throw new StagedArtifactConflictError(destination.path);
    const priorRollback = request.mode === "replace"
      ? await this.readRollbackEvidence(request, destination.path)
      : null;

    let rollbackBackup: {
      path: string;
      metadata: ProviderObjectMetadata;
      cleanupOnSuccess: boolean;
    } | null = null;
    let published: ProviderObjectMetadata | null = null;
    try {
      if (existing) {
        if (destination.archive_path) {
          const archivePath = priorRollback?.backup.path
            ?? await versionedArchivePath(destination.archive_path, existing);
          if (priorRollback && !isVersionedArchivePathFor(destination.archive_path, archivePath)) {
            throw new StagedArtifactConflictError(archivePath);
          }
          rollbackBackup = { path: archivePath, metadata: { ...existing, path: archivePath }, cleanupOnSuccess: false };
          const archived = await this.runtime.objects.getMetadata(archivePath);
          if (priorRollback && (!archived || !matchesStagedArtifactRollbackBackup(priorRollback, archived))) {
            throw new StagedArtifactConflictError(archivePath);
          }
          if (archived && !samePayload(existing, archived)) throw new StagedArtifactConflictError(archivePath);
          if (!archived) await this.runtime.serverSideCopy.copyObject(destination.path, archivePath);
          const verifiedArchive = await this.runtime.objects.getMetadata(archivePath);
          if (!verifiedArchive || !samePayload(existing, verifiedArchive)) {
            throw new StagedArtifactSourceMismatchError("replacement archive evidence does not match destination");
          }
          rollbackBackup = { path: archivePath, metadata: verifiedArchive, cleanupOnSuccess: false };
          await this.ensureRollbackEvidence(request, destination.path, verifiedArchive);
          await this.deleteObserved(existing);
        } else {
          const backupPath = machineArtifactReplacementBackupPath(request.request_id);
          if (priorRollback && priorRollback.backup.path !== backupPath) {
            throw new StagedArtifactConflictError(priorRollback.backup.path);
          }
          rollbackBackup = { path: backupPath, metadata: { ...existing, path: backupPath }, cleanupOnSuccess: true };
          const backup = await this.runtime.objects.getMetadata(backupPath);
          if (priorRollback && (!backup || !matchesStagedArtifactRollbackBackup(priorRollback, backup))) {
            throw new StagedArtifactConflictError(backupPath);
          }
          if (backup && !samePayload(existing, backup)) throw new StagedArtifactConflictError(backupPath);
          if (!backup) await this.runtime.serverSideCopy.copyObject(destination.path, backupPath);
          const verifiedBackup = await this.runtime.objects.getMetadata(backupPath);
          if (!verifiedBackup || !samePayload(existing, verifiedBackup)) {
            throw new StagedArtifactSourceMismatchError("replacement backup evidence does not match destination");
          }
          rollbackBackup = { path: backupPath, metadata: verifiedBackup, cleanupOnSuccess: true };
          await this.ensureRollbackEvidence(request, destination.path, verifiedBackup);
          await this.deleteObserved(existing);
        }
      }

      published = await this.runtime.serverSideCopy.copyObject(request.source.path, destination.path);
      this.assertSource(request, await this.runtime.objects.getMetadata(request.source.path));
      const visible = await this.runtime.objects.getMetadata(destination.path);
      if (!visible || !sameObservation(published, visible) || !samePayload(source!, visible)) {
        throw new StagedArtifactSourceMismatchError("final provider evidence does not match source");
      }
    } catch (error) {
      const currentDestination = await this.runtime.objects.getMetadata(destination.path);
      const originalStillVisible = Boolean(
        existing && currentDestination && sameObservation(existing, currentDestination)
      );
      if (!originalStillVisible) {
        await this.removeFailedPublication(destination.path, source!, published);
        if (rollbackBackup) await this.restoreBackup(request, destination.path, rollbackBackup);
      }
      throw error;
    }
    if (rollbackBackup?.cleanupOnSuccess) await this.deleteObserved(rollbackBackup.metadata);
    return "written";
  }

  private assertSource(request: StagedArtifactWriteRequest, metadata: ProviderObjectMetadata | null): void {
    const mismatch = stagedSourceMismatch(request, metadata);
    if (mismatch) throw new StagedArtifactSourceMismatchError(mismatch);
  }

  private async restoreBackup(
    request: StagedArtifactWriteRequest,
    destinationPath: string,
    backup: { path: string; metadata: ProviderObjectMetadata; cleanupOnSuccess: boolean }
  ): Promise<void> {
    const currentBackup = await this.runtime.objects.getMetadata(backup.path);
    if (!currentBackup || !sameObservation(backup.metadata, currentBackup)) {
      throw new Error(`Could not verify staged artifact replacement backup: ${backup.path}`);
    }
    await this.ensureRollbackEvidence(request, destinationPath, currentBackup);
    await this.runtime.serverSideCopy.copyObject(backup.path, destinationPath);
    const restored = await this.runtime.objects.getMetadata(destinationPath);
    if (!restored || !samePayload(currentBackup, restored)) {
      throw new Error(`Could not restore staged artifact replacement backup: ${destinationPath}`);
    }
  }

  private async ensureRollbackEvidence(
    request: StagedArtifactWriteRequest,
    destinationPath: string,
    backup: ProviderObjectMetadata
  ): Promise<void> {
    const evidence = stagedArtifactRollbackEvidence(request, destinationPath, backup, this.runtime.providerId);
    const path = machineArtifactRollbackEvidencePath(request.request_id);
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    try {
      await this.runtime.objects.createText(path, serialized);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.runtime.objects.readText(path);
      if (existing !== serialized) {
        throw new Error(`Conflicting staged artifact rollback evidence: ${path}`);
      }
    }
  }

  private async readRollbackEvidence(
    request: StagedArtifactWriteRequest,
    destinationPath: string
  ): Promise<StagedArtifactRollbackEvidence | null> {
    const path = machineArtifactRollbackEvidencePath(request.request_id);
    const raw = await this.runtime.objects.readText(path);
    if (raw === null) return null;
    const evidence = parseStagedArtifactRollbackEvidence(JSON.parse(raw));
    if (
      evidence.project_id !== request.project_id
      || evidence.request_id !== request.request_id
      || evidence.destination_path !== destinationPath
      || evidence.provider_id !== this.runtime.providerId
    ) throw new Error(`Conflicting staged artifact rollback evidence: ${path}`);
    return evidence;
  }

  private async removeFailedPublication(
    destinationPath: string,
    expectedSource: ProviderObjectMetadata,
    published: ProviderObjectMetadata | null
  ): Promise<void> {
    const current = await this.runtime.objects.getMetadata(destinationPath);
    if (!current) return;
    const safeToRemove = published
      ? sameObservation(published, current)
      : samePayload(expectedSource, current);
    if (!safeToRemove) {
      throw new Error(`Refusing to remove concurrently changed artifact destination: ${destinationPath}`);
    }
    await this.deleteObserved(current);
  }

  private async deleteObserved(metadata: ProviderObjectMetadata): Promise<void> {
    if (!metadata.objectId || !metadata.revisionToken || !this.runtime.objects.deleteIfUnchanged) {
      throw new Error("Staged binary publication requires revision-conditioned delete capability");
    }
    const outcome = await this.runtime.objects.deleteIfUnchanged(metadata.path, {
      objectId: metadata.objectId,
      revisionToken: metadata.revisionToken
    });
    if (outcome === "changed") {
      throw new Error(`Refusing to delete changed provider object: ${metadata.path}`);
    }
  }
}

export function stagedSourceMismatch(
  request: StagedArtifactWriteRequest,
  metadata: ProviderObjectMetadata | null
): string | null {
  if (!metadata) return "source does not exist";
  const expected = request.source;
  if (metadata.path !== expected.path) return "path";
  if (metadata.objectId !== expected.object_id) return "object id";
  if (metadata.revisionToken !== expected.revision_token) return "revision token";
  if (metadata.size !== expected.size) return "size";
  if (metadata.integrityHash?.algorithm !== expected.integrity.algorithm) return "integrity algorithm";
  if (metadata.integrityHash.value !== expected.integrity.value) return "integrity value";
  return null;
}

export function samePayload(left: ProviderObjectMetadata, right: ProviderObjectMetadata): boolean {
  return left.size === right.size
    && left.integrityHash?.algorithm === right.integrityHash?.algorithm
    && left.integrityHash?.value === right.integrityHash?.value;
}

function sameObservation(left: ProviderObjectMetadata, right: ProviderObjectMetadata): boolean {
  return left.path === right.path
    && left.objectId === right.objectId
    && left.revisionToken === right.revisionToken
    && samePayload(left, right);
}

export function matchesStagedArtifactPayload(
  request: StagedArtifactWriteRequest,
  metadata: ProviderObjectMetadata
): boolean {
  return metadata.size === request.source.size
    && metadata.integrityHash?.algorithm === request.source.integrity.algorithm
    && metadata.integrityHash?.value === request.source.integrity.value;
}

export interface StagedArtifactRollbackEvidence {
  schema_version: "1.0";
  project_id: string;
  request_id: string;
  destination_path: string;
  provider_id: string;
  backup: {
    path: string;
    object_id: string;
    revision_token: string;
    size: number;
    integrity: { algorithm: string; value: string };
  };
}

export function stagedArtifactRollbackEvidence(
  request: StagedArtifactWriteRequest,
  destinationPath: string,
  backup: ProviderObjectMetadata,
  providerId: string
): StagedArtifactRollbackEvidence {
  if (!backup.objectId || !backup.revisionToken || !backup.integrityHash) {
    throw new Error("Staged artifact rollback evidence requires complete provider metadata");
  }
  return {
    schema_version: "1.0",
    project_id: request.project_id,
    request_id: request.request_id,
    destination_path: destinationPath,
    provider_id: providerId,
    backup: {
      path: backup.path,
      object_id: backup.objectId,
      revision_token: backup.revisionToken,
      size: backup.size,
      integrity: backup.integrityHash
    }
  };
}

export function parseStagedArtifactRollbackEvidence(input: unknown): StagedArtifactRollbackEvidence {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid staged artifact rollback evidence");
  const value = input as Record<string, unknown>;
  const backup = value.backup;
  if (!backup || typeof backup !== "object" || Array.isArray(backup)) throw new Error("Invalid staged artifact rollback backup evidence");
  const observed = backup as Record<string, unknown>;
  const integrity = observed.integrity;
  if (!integrity || typeof integrity !== "object" || Array.isArray(integrity)) throw new Error("Invalid staged artifact rollback integrity evidence");
  const hash = integrity as Record<string, unknown>;
  if (
    value.schema_version !== "1.0"
    || typeof value.project_id !== "string"
    || typeof value.request_id !== "string"
    || typeof value.destination_path !== "string"
    || typeof value.provider_id !== "string"
    || typeof observed.path !== "string"
    || typeof observed.object_id !== "string"
    || typeof observed.revision_token !== "string"
    || typeof observed.size !== "number"
    || !Number.isSafeInteger(observed.size)
    || observed.size < 0
    || typeof hash.algorithm !== "string"
    || typeof hash.value !== "string"
  ) throw new Error("Invalid staged artifact rollback evidence");
  return input as StagedArtifactRollbackEvidence;
}

export function matchesStagedArtifactRollbackBackup(
  evidence: StagedArtifactRollbackEvidence,
  metadata: ProviderObjectMetadata
): boolean {
  return evidence.backup.path === metadata.path
    && evidence.backup.object_id === metadata.objectId
    && evidence.backup.revision_token === metadata.revisionToken
    && evidence.backup.size === metadata.size
    && evidence.backup.integrity.algorithm === metadata.integrityHash?.algorithm
    && evidence.backup.integrity.value === metadata.integrityHash?.value;
}

async function versionedArchivePath(basePath: string, metadata: ProviderObjectMetadata): Promise<string> {
  const fingerprint = await sha256Text(JSON.stringify({
    objectId: metadata.objectId ?? null,
    revisionToken: metadata.revisionToken ?? null,
    size: metadata.size,
    integrityHash: metadata.integrityHash ?? null
  }));
  const slash = basePath.lastIndexOf("/");
  const dot = basePath.lastIndexOf(".");
  return dot > slash
    ? `${basePath.slice(0, dot)}.previous-${fingerprint.slice(0, 12)}${basePath.slice(dot)}`
    : `${basePath}.previous-${fingerprint.slice(0, 12)}`;
}

function isVersionedArchivePathFor(basePath: string, candidate: string): boolean {
  const slash = basePath.lastIndexOf("/");
  const dot = basePath.lastIndexOf(".");
  const prefix = dot > slash ? `${basePath.slice(0, dot)}.previous-` : `${basePath}.previous-`;
  const suffix = dot > slash ? basePath.slice(dot) : "";
  if (!candidate.startsWith(prefix) || !candidate.endsWith(suffix)) return false;
  const fingerprint = candidate.slice(prefix.length, suffix ? -suffix.length : undefined);
  return /^[0-9a-f]{12}$/.test(fingerprint);
}
