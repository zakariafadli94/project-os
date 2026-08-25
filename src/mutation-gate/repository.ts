import {
  parseExternalMutationCandidateRecord,
  parseExternalMutationResolutionRecord,
  parseMutationIntentRecord,
  mutationCandidateIdFor,
  type ExternalMutationCandidateRecord,
  type ExternalMutationResolutionRecord,
  type MutationDetectionSource,
  type MutationIntentRecord
} from "../domain/mutation-gate";
import {
  DropboxConflictError,
  type DropboxFileMetadata,
  type DropboxTransport
} from "../dropbox/client";
import {
  machineMutationCandidatePath,
  machineMutationCandidatePayloadPath,
  machineMutationGateRoot,
  machineMutationIntentDestinationBindingRoot,
  machineMutationIntentPath,
  machineMutationResolutionPath
} from "../dropbox/layout";
import { ResilientDropboxTransport } from "../dropbox/resilient-transport";
import { sha256Text } from "../documents/hash";

interface MutationIntentDestinationBindingRecord {
  schema_version: "1.0";
  project_id: string;
  destination_path: string;
  request_id: string;
  intent_id: string;
}

export interface MutationResolutionTerminalEvidence {
  schema_version: "1.0";
  project_id: string;
  candidate_id: string;
  resolution_id: string;
  resolution: ExternalMutationResolutionRecord;
  resolution_request_sha256?: string;
}

export interface CaptureExternalMutationCandidateInput {
  projectId: string;
  detectionSource: MutationDetectionSource;
  visiblePath: string;
  metadata: DropboxFileMetadata;
  detectedAt: string;
}

export interface CaptureExternalMutationCandidateResult {
  created: boolean;
  record: ExternalMutationCandidateRecord;
}

export class MutationIntentConflictError extends Error {
  constructor(public readonly requestId: string) {
    super(`Mutation intent conflict for ${requestId}`);
    this.name = "MutationIntentConflictError";
  }
}

export class MutationCandidateEvidenceConflictError extends Error {
  constructor(public readonly candidateId: string) {
    super(`Mutation candidate evidence conflict for ${candidateId}`);
    this.name = "MutationCandidateEvidenceConflictError";
  }
}

export class MutationResolutionConflictError extends Error {
  constructor(public readonly candidateId: string) {
    super(`Conflicting terminal resolution for mutation candidate ${candidateId}`);
    this.name = "MutationResolutionConflictError";
  }
}

export class MutationGateRepository {
  private readonly transport: ResilientDropboxTransport;

  constructor(transport: DropboxTransport) {
    this.transport = new ResilientDropboxTransport(transport);
  }

  async ensureArtifactIntent(record: MutationIntentRecord): Promise<MutationIntentRecord> {
    const validated = parseMutationIntentRecord(record);
    const path = machineMutationIntentPath(validated.project_id, validated.request_id);
    let effective = validated;

    try {
      await this.transport.upload(path, pretty(validated), "add");
    } catch (error) {
      if (!(error instanceof DropboxConflictError)) throw error;
      const existing = await this.readArtifactIntent(validated.project_id, validated.request_id);
      if (!existing || !sameJson(existing, validated)) {
        throw new MutationIntentConflictError(validated.request_id);
      }
      effective = existing;
    }

    await this.ensureDestinationBinding(effective);
    return effective;
  }

  async readArtifactIntent(projectId: string, requestId: string): Promise<MutationIntentRecord | null> {
    const path = machineMutationIntentPath(projectId, requestId);
    const raw = await this.transport.download(path);
    if (raw === null) return null;
    const record = parseMutationIntentRecord(JSON.parse(raw));
    if (record.project_id !== projectId || record.request_id !== requestId) {
      throw new Error(`Mutation intent binding mismatch for ${projectId}/${requestId}`);
    }
    return record;
  }

  async listArtifactIntentsForDestination(projectId: string, destinationPath: string): Promise<MutationIntentRecord[]> {
    const pathHash = await sha256Text(destinationPath);
    const root = machineMutationIntentDestinationBindingRoot(projectId, pathHash);
    const entries = await this.transport.listFolder(root);
    const records: MutationIntentRecord[] = [];

    for (const entry of entries) {
      if (entry.tag !== "file") continue;
      const match = /^(ART-[A-Z0-9-]{10,})\.json$/.exec(entry.name);
      if (!match) continue;
      const binding = await this.readDestinationBinding(projectId, destinationPath, match[1]);
      if (!binding) continue;
      const intent = await this.readArtifactIntent(projectId, binding.request_id);
      if (!intent || intent.intent_id !== binding.intent_id || intent.destination_path !== destinationPath) {
        throw new Error(`Mutation intent destination binding is inconsistent for ${projectId}/${binding.request_id}`);
      }
      records.push(intent);
    }

    return records.sort((left, right) => left.recorded_at.localeCompare(right.recorded_at) || left.request_id.localeCompare(right.request_id));
  }

  async captureCandidate(input: CaptureExternalMutationCandidateInput): Promise<CaptureExternalMutationCandidateResult> {
    validateSourceMetadata(input.visiblePath, input.metadata);
    const candidateId = await mutationCandidateIdFor({
      projectId: input.projectId,
      providerFileId: input.metadata.id,
      providerRev: input.metadata.rev
    });
    const immutablePayloadPath = machineMutationCandidatePayloadPath(input.projectId, candidateId);
    const candidate = parseExternalMutationCandidateRecord({
      schema_version: "1.0",
      candidate_id: candidateId,
      project_id: input.projectId,
      source: "external_unverified",
      detection_source: input.detectionSource,
      provider_path: input.visiblePath,
      provider_file_id: input.metadata.id,
      provider_rev: input.metadata.rev,
      provider_content_hash: input.metadata.content_hash,
      size: input.metadata.size,
      immutable_payload_path: immutablePayloadPath,
      detected_at: input.detectedAt
    });

    const existing = await this.readCandidate(input.projectId, candidateId);
    if (existing) {
      if (!sameCandidateEvidence(existing, candidate)) {
        throw new MutationCandidateEvidenceConflictError(candidateId);
      }
      await this.verifyCandidatePayload(existing);
      return { created: false, record: existing };
    }

    await this.snapshotCandidatePayload(candidate);
    const path = machineMutationCandidatePath(input.projectId, candidateId);
    try {
      await this.transport.upload(path, pretty(candidate), "add");
      return { created: true, record: candidate };
    } catch (error) {
      if (!(error instanceof DropboxConflictError)) throw error;
      const raced = await this.readCandidate(input.projectId, candidateId);
      if (!raced || !sameCandidateEvidence(raced, candidate)) {
        throw new MutationCandidateEvidenceConflictError(candidateId);
      }
      await this.verifyCandidatePayload(raced);
      return { created: false, record: raced };
    }
  }

  async readCandidate(projectId: string, candidateId: string): Promise<ExternalMutationCandidateRecord | null> {
    const raw = await this.transport.download(machineMutationCandidatePath(projectId, candidateId));
    if (raw === null) return null;
    const record = parseExternalMutationCandidateRecord(JSON.parse(raw));
    if (record.project_id !== projectId || record.candidate_id !== candidateId) {
      throw new Error(`Mutation candidate binding mismatch for ${projectId}/${candidateId}`);
    }
    return record;
  }

  async listCandidates(projectId: string): Promise<ExternalMutationCandidateRecord[]> {
    const root = `${machineMutationGateRoot(projectId)}/candidates`;
    const entries = await this.transport.listFolder(root);
    const records: ExternalMutationCandidateRecord[] = [];
    for (const entry of entries) {
      if (entry.tag !== "file") continue;
      const match = /^(MUTCAND-[A-F0-9]{24})\.json$/.exec(entry.name);
      if (!match) continue;
      const record = await this.readCandidate(projectId, match[1]);
      if (record) records.push(record);
    }
    return records.sort((left, right) => left.detected_at.localeCompare(right.detected_at) || left.candidate_id.localeCompare(right.candidate_id));
  }

  async readCandidatePayload(projectId: string, candidateId: string): Promise<string | null> {
    const candidate = await this.readCandidate(projectId, candidateId);
    if (!candidate) return null;
    return this.transport.download(candidate.immutable_payload_path);
  }

  async writeResolution(
    record: ExternalMutationResolutionRecord,
    resolutionRequestSha256?: string
  ): Promise<ExternalMutationResolutionRecord> {
    const validated = parseExternalMutationResolutionRecord(record);
    const requestHash = validateOptionalSha256(resolutionRequestSha256);
    const candidate = await this.readCandidate(validated.project_id, validated.candidate_id);
    if (!candidate) throw new Error(`Mutation candidate does not exist: ${validated.candidate_id}`);

    const terminal = await this.readTerminalResolutionRecord(validated.project_id, validated.candidate_id);
    if (terminal) {
      assertTerminalCompatible(terminal, validated, requestHash);
    }

    const terminalEvidence: MutationResolutionTerminalEvidence = {
      schema_version: "1.0",
      project_id: validated.project_id,
      candidate_id: validated.candidate_id,
      resolution_id: validated.resolution_id,
      resolution: validated,
      ...(requestHash ? { resolution_request_sha256: requestHash } : {})
    };

    if (!terminal) {
      try {
        await this.transport.upload(
          terminalResolutionPath(validated.project_id, validated.candidate_id),
          pretty(terminalEvidence),
          "add"
        );
      } catch (error) {
        if (!(error instanceof DropboxConflictError)) throw error;
        const raced = await this.readTerminalResolutionRecord(validated.project_id, validated.candidate_id);
        if (!raced) throw new MutationResolutionConflictError(validated.candidate_id);
        assertTerminalCompatible(raced, validated, requestHash);
      }
    }

    const path = machineMutationResolutionPath(validated.project_id, validated.candidate_id, validated.resolution_id);
    try {
      await this.transport.upload(path, pretty(validated), "add");
      return validated;
    } catch (error) {
      if (!(error instanceof DropboxConflictError)) throw error;
      const existing = await this.readResolution(validated.project_id, validated.candidate_id, validated.resolution_id);
      if (!existing || !sameJson(existing, validated)) {
        throw new MutationResolutionConflictError(validated.candidate_id);
      }
      return existing;
    }
  }

  async readResolutions(projectId: string, candidateId: string): Promise<ExternalMutationResolutionRecord[]> {
    const root = resolutionRoot(projectId, candidateId);
    const entries = await this.transport.listFolder(root);
    const records: ExternalMutationResolutionRecord[] = [];
    for (const entry of entries) {
      if (entry.tag !== "file") continue;
      const match = /^(MUTRES-[A-F0-9]{24})\.json$/.exec(entry.name);
      if (!match) continue;
      const record = await this.readResolution(projectId, candidateId, match[1]);
      if (record) records.push(record);
    }
    return records.sort((left, right) => left.resolved_at.localeCompare(right.resolved_at) || left.resolution_id.localeCompare(right.resolution_id));
  }

  async readTerminalResolutionRecord(
    projectId: string,
    candidateId: string
  ): Promise<MutationResolutionTerminalEvidence | null> {
    const raw = await this.transport.download(terminalResolutionPath(projectId, candidateId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<MutationResolutionTerminalEvidence>;
    if (
      parsed.schema_version !== "1.0"
      || parsed.project_id !== projectId
      || parsed.candidate_id !== candidateId
      || typeof parsed.resolution_id !== "string"
      || !/^MUTRES-[A-F0-9]{24}$/.test(parsed.resolution_id)
      || parsed.resolution === undefined
    ) {
      throw new Error(`Invalid mutation resolution terminal binding for ${projectId}/${candidateId}`);
    }
    const resolution = parseExternalMutationResolutionRecord(parsed.resolution);
    if (
      resolution.project_id !== projectId
      || resolution.candidate_id !== candidateId
      || resolution.resolution_id !== parsed.resolution_id
    ) {
      throw new Error(`Mutation resolution terminal evidence mismatch for ${projectId}/${candidateId}`);
    }
    const requestHash = validateOptionalSha256(parsed.resolution_request_sha256);
    return {
      schema_version: "1.0",
      project_id: projectId,
      candidate_id: candidateId,
      resolution_id: resolution.resolution_id,
      resolution,
      ...(requestHash ? { resolution_request_sha256: requestHash } : {})
    };
  }

  async hasTerminalResolution(projectId: string, candidateId: string): Promise<boolean> {
    return (await this.readTerminalResolutionRecord(projectId, candidateId)) !== null;
  }

  private async ensureDestinationBinding(intent: MutationIntentRecord): Promise<void> {
    const binding: MutationIntentDestinationBindingRecord = {
      schema_version: "1.0",
      project_id: intent.project_id,
      destination_path: intent.destination_path,
      request_id: intent.request_id,
      intent_id: intent.intent_id
    };
    const path = await destinationBindingPath(intent.project_id, intent.destination_path, intent.request_id);
    const content = pretty(binding);
    try {
      await this.transport.upload(path, content, "add");
    } catch (error) {
      if (!(error instanceof DropboxConflictError)) throw error;
      const existing = await this.transport.download(path);
      if (existing !== content) throw new MutationIntentConflictError(intent.request_id);
    }
  }

  private async readDestinationBinding(
    projectId: string,
    destinationPath: string,
    requestId: string
  ): Promise<MutationIntentDestinationBindingRecord | null> {
    const path = await destinationBindingPath(projectId, destinationPath, requestId);
    const raw = await this.transport.download(path);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<MutationIntentDestinationBindingRecord>;
    if (
      parsed.schema_version !== "1.0"
      || parsed.project_id !== projectId
      || parsed.destination_path !== destinationPath
      || parsed.request_id !== requestId
      || typeof parsed.intent_id !== "string"
      || !/^MUTINT-[A-F0-9]{24}$/.test(parsed.intent_id)
    ) {
      throw new Error(`Invalid mutation intent destination binding for ${projectId}/${requestId}`);
    }
    return parsed as MutationIntentDestinationBindingRecord;
  }

  private async snapshotCandidatePayload(candidate: ExternalMutationCandidateRecord): Promise<void> {
    try {
      const copied = await this.transport.copy(candidate.provider_path, candidate.immutable_payload_path);
      assertPayloadMetadata(candidate, copied);
    } catch (error) {
      if (!(error instanceof DropboxConflictError)) throw error;
      const existing = await this.transport.getMetadata(candidate.immutable_payload_path);
      if (!existing) throw error;
      assertPayloadMetadata(candidate, existing);
    }
  }

  private async verifyCandidatePayload(candidate: ExternalMutationCandidateRecord): Promise<void> {
    const metadata = await this.transport.getMetadata(candidate.immutable_payload_path);
    if (!metadata) {
      throw new MutationCandidateEvidenceConflictError(candidate.candidate_id);
    }
    assertPayloadMetadata(candidate, metadata);
  }

  private async readResolution(
    projectId: string,
    candidateId: string,
    resolutionId: string
  ): Promise<ExternalMutationResolutionRecord | null> {
    const raw = await this.transport.download(machineMutationResolutionPath(projectId, candidateId, resolutionId));
    if (raw === null) return null;
    const record = parseExternalMutationResolutionRecord(JSON.parse(raw));
    if (record.project_id !== projectId || record.candidate_id !== candidateId || record.resolution_id !== resolutionId) {
      throw new Error(`Mutation resolution binding mismatch for ${projectId}/${candidateId}/${resolutionId}`);
    }
    return record;
  }
}

async function destinationBindingPath(projectId: string, destinationPath: string, requestId: string): Promise<string> {
  const pathHash = await sha256Text(destinationPath);
  const root = machineMutationIntentDestinationBindingRoot(projectId, pathHash);
  if (!/^ART-[A-Z0-9-]{10,}$/.test(requestId)) throw new Error(`Unsafe artifact request id: ${requestId}`);
  return `${root}/${requestId}.json`;
}

function resolutionRoot(projectId: string, candidateId: string): string {
  const sentinel = "MUTRES-000000000000000000000000";
  const path = machineMutationResolutionPath(projectId, candidateId, sentinel);
  return path.slice(0, -`/${sentinel}.json`.length);
}

function terminalResolutionPath(projectId: string, candidateId: string): string {
  return `${resolutionRoot(projectId, candidateId)}/terminal.json`;
}

function validateSourceMetadata(visiblePath: string, metadata: DropboxFileMetadata): void {
  if (metadata.path !== visiblePath) throw new Error(`Mutation candidate metadata path mismatch: ${metadata.path} != ${visiblePath}`);
  if (!/^id:[A-Za-z0-9_-]+$/.test(metadata.id)) throw new Error(`Invalid provider file id: ${metadata.id}`);
  if (!metadata.rev) throw new Error("Mutation candidate requires provider rev");
  if (!/^[a-f0-9]{64}$/.test(metadata.content_hash)) throw new Error("Mutation candidate requires provider content hash");
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) throw new Error("Mutation candidate requires safe provider size");
}

function assertPayloadMetadata(candidate: ExternalMutationCandidateRecord, metadata: DropboxFileMetadata): void {
  if (metadata.content_hash !== candidate.provider_content_hash || metadata.size !== candidate.size) {
    throw new MutationCandidateEvidenceConflictError(candidate.candidate_id);
  }
}

function sameCandidateEvidence(left: ExternalMutationCandidateRecord, right: ExternalMutationCandidateRecord): boolean {
  return left.schema_version === right.schema_version
    && left.candidate_id === right.candidate_id
    && left.project_id === right.project_id
    && left.source === right.source
    && left.provider_path === right.provider_path
    && left.provider_file_id === right.provider_file_id
    && left.provider_rev === right.provider_rev
    && left.provider_content_hash === right.provider_content_hash
    && left.size === right.size
    && left.immutable_payload_path === right.immutable_payload_path;
}

function assertTerminalCompatible(
  terminal: MutationResolutionTerminalEvidence,
  resolution: ExternalMutationResolutionRecord,
  resolutionRequestSha256?: string
): void {
  if (!sameJson(terminal.resolution, resolution)) {
    throw new MutationResolutionConflictError(resolution.candidate_id);
  }
  if (
    terminal.resolution_request_sha256 !== undefined
    && resolutionRequestSha256 !== undefined
    && terminal.resolution_request_sha256 !== resolutionRequestSha256
  ) {
    throw new MutationResolutionConflictError(resolution.candidate_id);
  }
  if (terminal.resolution_request_sha256 === undefined && resolutionRequestSha256 !== undefined) {
    throw new MutationResolutionConflictError(resolution.candidate_id);
  }
}

function validateOptionalSha256(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid SHA-256: ${value}`);
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
