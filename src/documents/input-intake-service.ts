import {
  documentIdForProviderFile,
  externalVersionIdFor,
  type ManagedProviderObservation
} from "../domain/managed-document";
import type { ProjectState } from "../domain/project-state";
import {
  machineDocumentProviderPayloadPath,
  workspaceManagedDocumentPath
} from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import { ProviderConflictError } from "../persistence/provider/errors";
import {
  inputIntakeIdFor,
  type InputIntakeRecord
} from "./input-intake";
import { InputIntakeRepository } from "./input-intake-repository";
import { DocumentLedgerRepository, type ReferenceFingerprintRecord } from "./repository";

export interface InputIntakeServiceOptions {
  now?: () => string;
}

export interface InputIntakeRequest {
  sourcePath: string;
  relativeInputPath: string;
  metadata: ProviderObjectMetadata;
}

export interface InputIntakeResult {
  status: "completed" | "duplicate_cleaned" | "withdrawn" | "conflict";
  intake_id: string;
  resumed: boolean;
  document_id?: string;
  version_id?: string;
}

interface PortableEvidence {
  objectId: string;
  revisionToken: string;
  integrityHash: { algorithm: string; value: string };
  size: number;
}

export class InputIntakeService {
  private readonly intakeRepository: InputIntakeRepository;
  private readonly ledger: DocumentLedgerRepository;
  private readonly now: () => string;

  constructor(
    private readonly runtime: ProjectOsPersistenceRuntime,
    options: InputIntakeServiceOptions = {}
  ) {
    this.intakeRepository = new InputIntakeRepository(runtime.objects);
    this.ledger = new DocumentLedgerRepository(runtime);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async ingest(state: ProjectState, request: InputIntakeRequest): Promise<InputIntakeResult> {
    if (state.status === "archived") {
      throw new Error(`Cannot ingest INPUTS for archived project ${state.project_id}`);
    }
    if (request.metadata.path !== request.sourcePath) {
      throw new Error(`Input intake metadata path mismatch: ${request.metadata.path} != ${request.sourcePath}`);
    }

    const evidence = requirePortableEvidence(request.metadata);
    const intakeId = await inputIntakeIdFor({
      projectId: state.project_id,
      providerId: this.runtime.providerId,
      objectId: evidence.objectId,
      revisionToken: evidence.revisionToken
    });
    const documentId = await documentIdForProviderFile(state.project_id, evidence.objectId);
    const versionId = await externalVersionIdFor(evidence.revisionToken);

    let intake = await this.intakeRepository.read(state.project_id, intakeId);
    const resumed = intake !== null;
    if (!intake) {
      const timestamp = this.now();
      intake = await this.intakeRepository.create({
        schema_version: "1.0",
        intake_id: intakeId,
        project_id: state.project_id,
        phase: "DETECTED",
        source: {
          provider_id: this.runtime.providerId,
          object_id: evidence.objectId,
          revision_token: evidence.revisionToken,
          integrity_hash: evidence.integrityHash,
          size: evidence.size,
          provider_path: request.sourcePath,
          relative_input_path: request.relativeInputPath
        },
        detected_at: timestamp,
        updated_at: timestamp
      });
      await this.intakeRepository.bindSourcePath(intake);
    } else {
      assertReplayMatches(intake, state, request, this.runtime.providerId, evidence);
    }

    const terminal = terminalResult(intake, resumed, documentId, versionId);
    if (terminal) return terminal;

    if (intake.phase === "DETECTED") {
      const source = await this.runtime.objects.getMetadata(request.sourcePath);
      if (!source) {
        intake = await this.intakeRepository.advance(state.project_id, intakeId, "WITHDRAWN", this.now());
        return { status: "withdrawn", intake_id: intakeId, resumed, document_id: documentId, version_id: versionId };
      }
      if (!samePortableEvidence(source, evidence)) {
        intake = await this.intakeRepository.advance(state.project_id, intakeId, "CONFLICT", this.now());
        return { status: "conflict", intake_id: intakeId, resumed, document_id: documentId, version_id: versionId };
      }

      await this.ledger.snapshotProviderFile(
        state.project_id,
        documentId,
        versionId,
        request.sourcePath,
        request.metadata
      );
      intake = await this.intakeRepository.advance(state.project_id, intakeId, "SNAPSHOTTED", this.now());
    }

    if (intake.phase === "SNAPSHOTTED") {
      const fingerprint = await this.ledger.readReferenceFingerprint(
        state.project_id,
        intake.source.integrity_hash.value
      );
      if (fingerprint && await this.isCurrentReferenceFingerprint(fingerprint, intake)) {
        const source = await this.runtime.objects.getMetadata(request.sourcePath);
        if (source && !samePortableEvidence(source, evidence)) {
          intake = await this.intakeRepository.advance(state.project_id, intakeId, "CONFLICT", this.now());
          return { status: "conflict", intake_id: intakeId, resumed, document_id: documentId, version_id: versionId };
        }
        if (source) await this.runtime.objects.delete(request.sourcePath);
        intake = await this.intakeRepository.advance(state.project_id, intakeId, "DUPLICATE_CLEANED", this.now());
        return { status: "duplicate_cleaned", intake_id: intakeId, resumed };
      }

      const targetPath = workspaceManagedDocumentPath(
        state.project_id,
        state.slug,
        "references",
        `UNCLASSIFIED/${request.relativeInputPath}`
      );
      const targetMetadata = await this.ensureReferenceCopy(request.sourcePath, targetPath, evidence);
      if (!targetMetadata) {
        intake = await this.intakeRepository.advance(state.project_id, intakeId, "CONFLICT", this.now());
        return { status: "conflict", intake_id: intakeId, resumed, document_id: documentId, version_id: versionId };
      }

      const targetEvidence = requirePortableEvidence(targetMetadata);
      await this.ledger.writeVersion({
        schema_version: "1.0",
        project_id: state.project_id,
        document_id: documentId,
        version_id: versionId,
        kind: "reference",
        stage: "reference",
        logical_path: request.relativeInputPath,
        source: "input_ingest",
        created_at: request.metadata.modifiedAt ?? this.now(),
        immutable_payload_path: machineDocumentProviderPayloadPath(state.project_id, documentId, versionId),
        provider_content_hash: targetEvidence.integrityHash.value,
        provider_file_id: targetEvidence.objectId,
        provider_rev: targetEvidence.revisionToken,
        provider_path: targetPath,
        size: targetEvidence.size
      });
      await this.ledger.writeHead({
        schema_version: "1.0",
        project_id: state.project_id,
        document_id: documentId,
        kind: "reference",
        logical_path: request.relativeInputPath,
        collection_path: "UNCLASSIFIED",
        reference_version_id: versionId,
        provider: { reference: toLegacyObservation(targetMetadata) },
        reconciliation_status: "clean"
      });
      await this.ledger.writeProviderFileBinding({
        schema_version: "1.0",
        project_id: state.project_id,
        provider_file_id: targetEvidence.objectId,
        document_id: documentId
      });
      await this.ledger.writeReferenceFingerprint({
        schema_version: "1.0",
        project_id: state.project_id,
        provider_content_hash: targetEvidence.integrityHash.value,
        document_id: documentId,
        version_id: versionId
      });
      intake = await this.intakeRepository.advance(state.project_id, intakeId, "REFERENCE_COMMITTED", this.now());
    }

    if (intake.phase === "REFERENCE_COMMITTED") {
      const targetPath = workspaceManagedDocumentPath(
        state.project_id,
        state.slug,
        "references",
        `UNCLASSIFIED/${request.relativeInputPath}`
      );
      const durable = await this.verifyGovernedReference(
        state.project_id,
        documentId,
        versionId,
        targetPath,
        intake
      );
      if (!durable) {
        intake = await this.intakeRepository.advance(state.project_id, intakeId, "CONFLICT", this.now());
        return { status: "conflict", intake_id: intakeId, resumed, document_id: documentId, version_id: versionId };
      }

      const source = await this.runtime.objects.getMetadata(request.sourcePath);
      if (source && !samePortableEvidence(source, evidence)) {
        intake = await this.intakeRepository.advance(state.project_id, intakeId, "CONFLICT", this.now());
        return { status: "conflict", intake_id: intakeId, resumed, document_id: documentId, version_id: versionId };
      }
      if (source) await this.runtime.objects.delete(request.sourcePath);
      intake = await this.intakeRepository.advance(state.project_id, intakeId, "SOURCE_REMOVED", this.now());
    }

    if (intake.phase === "SOURCE_REMOVED") {
      const targetPath = workspaceManagedDocumentPath(
        state.project_id,
        state.slug,
        "references",
        `UNCLASSIFIED/${request.relativeInputPath}`
      );
      if (
        await this.runtime.objects.getMetadata(request.sourcePath)
        || !await this.verifyGovernedReference(state.project_id, documentId, versionId, targetPath, intake)
      ) {
        intake = await this.intakeRepository.advance(state.project_id, intakeId, "CONFLICT", this.now());
        return { status: "conflict", intake_id: intakeId, resumed, document_id: documentId, version_id: versionId };
      }
      intake = await this.intakeRepository.advance(state.project_id, intakeId, "COMPLETE", this.now());
    }

    if (intake.phase !== "COMPLETE") {
      throw new Error(`Input intake did not reach a terminal state: ${intake.intake_id}/${intake.phase}`);
    }
    return {
      status: "completed",
      intake_id: intakeId,
      resumed,
      document_id: documentId,
      version_id: versionId
    };
  }

  private async ensureReferenceCopy(
    sourcePath: string,
    targetPath: string,
    sourceEvidence: PortableEvidence
  ): Promise<ProviderObjectMetadata | null> {
    const existing = await this.runtime.objects.getMetadata(targetPath);
    if (existing) return sameContentEvidence(existing, sourceEvidence) ? existing : null;

    try {
      const copied = await this.runtime.serverSideCopy.copyObject(sourcePath, targetPath);
      return sameContentEvidence(copied, sourceEvidence) ? copied : null;
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const raced = await this.runtime.objects.getMetadata(targetPath);
      if (!raced) throw error;
      return sameContentEvidence(raced, sourceEvidence) ? raced : null;
    }
  }

  private async verifyGovernedReference(
    projectId: string,
    documentId: string,
    versionId: string,
    targetPath: string,
    intake: InputIntakeRecord
  ): Promise<boolean> {
    const [target, version, head, fingerprint] = await Promise.all([
      this.runtime.objects.getMetadata(targetPath),
      this.ledger.readVersion(projectId, documentId, versionId),
      this.ledger.readHead(projectId, documentId),
      this.ledger.readReferenceFingerprint(projectId, intake.source.integrity_hash.value)
    ]);
    if (!target || !sameContentEvidence(target, sourceEvidenceFromIntake(intake))) return false;
    if (
      !version
      || version.kind !== "reference"
      || version.stage !== "reference"
      || version.logical_path !== intake.source.relative_input_path
      || version.provider_content_hash !== intake.source.integrity_hash.value
      || version.provider_path !== targetPath
    ) return false;
    if (
      !head
      || head.kind !== "reference"
      || head.logical_path !== intake.source.relative_input_path
      || head.collection_path !== "UNCLASSIFIED"
      || head.reference_version_id !== versionId
      || head.provider?.reference?.path !== targetPath
      || head.provider.reference.content_hash !== intake.source.integrity_hash.value
    ) return false;
    return fingerprint?.document_id === documentId && fingerprint.version_id === versionId;
  }

  private async isCurrentReferenceFingerprint(
    fingerprint: ReferenceFingerprintRecord,
    intake: InputIntakeRecord
  ): Promise<boolean> {
    const [head, version] = await Promise.all([
      this.ledger.readHead(fingerprint.project_id, fingerprint.document_id),
      this.ledger.readVersion(fingerprint.project_id, fingerprint.document_id, fingerprint.version_id)
    ]);
    return head?.kind === "reference"
      && head.reference_version_id === fingerprint.version_id
      && head.provider?.reference?.content_hash === intake.source.integrity_hash.value
      && version?.kind === "reference"
      && version.stage === "reference"
      && version.provider_content_hash === intake.source.integrity_hash.value;
  }
}

function requirePortableEvidence(metadata: ProviderObjectMetadata): PortableEvidence {
  if (!metadata.objectId) throw new Error("Input intake requires a stable provider object id");
  if (!metadata.revisionToken) throw new Error("Input intake requires a provider revision token");
  if (!metadata.integrityHash) throw new Error("Input intake requires provider integrity evidence");
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
    throw new Error("Input intake size must be a non-negative safe integer");
  }
  return {
    objectId: metadata.objectId,
    revisionToken: metadata.revisionToken,
    integrityHash: metadata.integrityHash,
    size: metadata.size
  };
}

function sourceEvidenceFromIntake(intake: InputIntakeRecord): PortableEvidence {
  return {
    objectId: intake.source.object_id,
    revisionToken: intake.source.revision_token,
    integrityHash: intake.source.integrity_hash,
    size: intake.source.size
  };
}

function samePortableEvidence(metadata: ProviderObjectMetadata, expected: PortableEvidence): boolean {
  if (!metadata.objectId || !metadata.revisionToken || !metadata.integrityHash) return false;
  return metadata.objectId === expected.objectId
    && metadata.revisionToken === expected.revisionToken
    && metadata.integrityHash.algorithm === expected.integrityHash.algorithm
    && metadata.integrityHash.value === expected.integrityHash.value
    && metadata.size === expected.size;
}

function sameContentEvidence(metadata: ProviderObjectMetadata, expected: PortableEvidence): boolean {
  if (!metadata.integrityHash) return false;
  return metadata.integrityHash.algorithm === expected.integrityHash.algorithm
    && metadata.integrityHash.value === expected.integrityHash.value
    && metadata.size === expected.size;
}

function toLegacyObservation(metadata: ProviderObjectMetadata): ManagedProviderObservation {
  const evidence = requirePortableEvidence(metadata);
  return {
    path: metadata.path,
    file_id: evidence.objectId,
    rev: evidence.revisionToken,
    content_hash: evidence.integrityHash.value,
    size: evidence.size
  };
}

function assertReplayMatches(
  intake: InputIntakeRecord,
  state: ProjectState,
  request: InputIntakeRequest,
  providerId: string,
  evidence: PortableEvidence
): void {
  if (
    intake.project_id !== state.project_id
    || intake.source.provider_id !== providerId
    || intake.source.object_id !== evidence.objectId
    || intake.source.revision_token !== evidence.revisionToken
    || intake.source.integrity_hash.algorithm !== evidence.integrityHash.algorithm
    || intake.source.integrity_hash.value !== evidence.integrityHash.value
    || intake.source.size !== evidence.size
    || intake.source.provider_path !== request.sourcePath
    || intake.source.relative_input_path !== request.relativeInputPath
  ) {
    throw new Error(`Input intake replay evidence mismatch: ${intake.intake_id}`);
  }
}

function terminalResult(
  intake: InputIntakeRecord,
  resumed: boolean,
  documentId: string,
  versionId: string
): InputIntakeResult | null {
  if (intake.phase === "COMPLETE") {
    return {
      status: "completed",
      intake_id: intake.intake_id,
      resumed,
      document_id: documentId,
      version_id: versionId
    };
  }
  if (intake.phase === "DUPLICATE_CLEANED") {
    return { status: "duplicate_cleaned", intake_id: intake.intake_id, resumed };
  }
  if (intake.phase === "WITHDRAWN") {
    return { status: "withdrawn", intake_id: intake.intake_id, resumed, document_id: documentId, version_id: versionId };
  }
  if (intake.phase === "CONFLICT") {
    return { status: "conflict", intake_id: intake.intake_id, resumed, document_id: documentId, version_id: versionId };
  }
  return null;
}
