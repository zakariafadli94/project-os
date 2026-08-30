import { documentIdForProviderFile, externalVersionIdFor } from "../domain/managed-document";
import type { ProjectState } from "../domain/project-state";
import {
  requireDropboxV1Evidence,
  toManagedProviderObservation
} from "../persistence/compatibility/dropbox-v1-evidence";
import {
  machineDocumentProviderPayloadPath,
  workspaceManagedDocumentPath
} from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import { asProjectOsPersistence, type PersistenceInput } from "../persistence/provider/runtime";
import { DocumentLedgerRepository, type ReferenceFingerprintRecord } from "./repository";
import {
  IntakeRepository,
  legacyReferralIdFor,
  type ReferralProvenanceRecord
} from "./intake-repository";

export interface IntakeProcessInput {
  logicalPath: string;
  inputPath: string;
  metadata: ProviderObjectMetadata;
  detectedAt: string;
}

export type IntakeProcessResult = "ingested" | "duplicate" | "pending" | "failed";

export class IntakeService {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly ledger: DocumentLedgerRepository;
  private readonly intake: IntakeRepository;

  constructor(input: PersistenceInput) {
    this.runtime = asProjectOsPersistence(input);
    this.ledger = new DocumentLedgerRepository(this.runtime);
    this.intake = new IntakeRepository(this.runtime);
  }

  async process(state: ProjectState, input: IntakeProcessInput): Promise<IntakeProcessResult> {
    if (state.status === "archived") throw new Error("Archived projects do not accept INPUT intake");
    const sourceEvidence = requireDropboxV1Evidence(input.metadata);
    let journal = await this.intake.beginObservation({
      project_id: state.project_id,
      provider_id: this.runtime.providerId,
      object_id: sourceEvidence.file_id,
      revision_token: sourceEvidence.rev,
      logical_input_path: input.logicalPath,
      observed_at: input.detectedAt
    });

    if (journal.state === "ingested" || journal.state === "duplicate") return journal.state;
    if (journal.state === "failed" && journal.retryable === false) return "failed";

    journal = await this.intake.write({
      ...journal,
      state: "processing",
      retryable: undefined,
      last_error: undefined,
      last_attempt_at: input.detectedAt,
      attempt_count: journal.attempt_count + 1,
      step_evidence: { ...(journal.step_evidence ?? {}), intent: true }
    });

    const duplicate = await this.proveCurrentDuplicate(state.project_id, sourceEvidence.content_hash);
    if (duplicate) {
      const provenance = await this.referralProvenanceIfApplicable(
        state,
        input,
        duplicate.document_id,
        duplicate.version_id,
        sourceEvidence.file_id,
        sourceEvidence.rev
      );
      if (provenance) await this.intake.writeReferralProvenance(provenance);
      const sourceCleanup = await this.deleteSourceIfUnchanged(input.inputPath, sourceEvidence);
      await this.intake.write({
        ...journal,
        state: "duplicate",
        document_id: duplicate.document_id,
        version_id: duplicate.version_id,
        reference_path: duplicate.reference_path,
        step_evidence: {
          ...(journal.step_evidence ?? {}),
          duplicate_verified: true,
          source_cleanup: sourceCleanup
        }
      });
      return "duplicate";
    }

    const documentId = await documentIdForProviderFile(state.project_id, sourceEvidence.file_id);
    const versionId = await externalVersionIdFor(sourceEvidence.rev);
    const immutablePayloadPath = machineDocumentProviderPayloadPath(state.project_id, documentId, versionId);

    await this.ledger.snapshotProviderFile(
      state.project_id,
      documentId,
      versionId,
      input.inputPath,
      input.metadata
    );
    journal = await this.intake.write({
      ...journal,
      step_evidence: { ...(journal.step_evidence ?? {}), snapshot_path: immutablePayloadPath }
    });

    const relativeReferencePath = `UNCLASSIFIED/${input.logicalPath}`;
    const targetPath = workspaceManagedDocumentPath(
      state.project_id,
      state.slug,
      "references",
      relativeReferencePath
    );
    await this.ensureDestinationCopy(input.inputPath, targetPath, sourceEvidence.content_hash, sourceEvidence.size);
    const targetMetadata = await this.requireMatchingMetadata(targetPath, sourceEvidence.content_hash, sourceEvidence.size);
    const targetEvidence = requireDropboxV1Evidence(targetMetadata);
    journal = await this.intake.write({
      ...journal,
      step_evidence: {
        ...(journal.step_evidence ?? {}),
        destination_path: targetPath,
        destination_verified: true
      }
    });

    await this.ledger.writeVersion({
      schema_version: "1.0",
      project_id: state.project_id,
      document_id: documentId,
      version_id: versionId,
      kind: "reference",
      stage: "reference",
      logical_path: input.logicalPath,
      source: "input_ingest",
      created_at: input.metadata.modifiedAt ?? input.detectedAt,
      immutable_payload_path: immutablePayloadPath,
      provider_content_hash: targetEvidence.content_hash,
      provider_file_id: targetEvidence.file_id,
      provider_rev: targetEvidence.rev,
      provider_path: targetPath,
      size: targetEvidence.size
    });
    await this.ledger.writeHead({
      schema_version: "1.0",
      project_id: state.project_id,
      document_id: documentId,
      kind: "reference",
      logical_path: input.logicalPath,
      collection_path: "UNCLASSIFIED",
      reference_version_id: versionId,
      provider: { reference: toManagedProviderObservation({ ...targetMetadata, path: targetPath }) },
      reconciliation_status: "clean"
    });
    await this.ledger.writeProviderFileBinding({
      schema_version: "1.0",
      project_id: state.project_id,
      provider_file_id: targetEvidence.file_id,
      document_id: documentId
    });
    await this.ledger.writeReferenceFingerprint({
      schema_version: "1.0",
      project_id: state.project_id,
      provider_content_hash: targetEvidence.content_hash,
      document_id: documentId,
      version_id: versionId
    });
    await this.requireGovernedReference(
      state.project_id,
      documentId,
      versionId,
      targetPath,
      targetEvidence.content_hash,
      targetEvidence.size
    );
    journal = await this.intake.write({
      ...journal,
      document_id: documentId,
      version_id: versionId,
      reference_path: relativeReferencePath,
      step_evidence: {
        ...(journal.step_evidence ?? {}),
        version_written: true,
        head_indexes_written: true,
        governed_reference_verified: true
      }
    });

    const provenance = await this.referralProvenanceIfApplicable(
      state,
      input,
      documentId,
      versionId,
      sourceEvidence.file_id,
      sourceEvidence.rev
    );
    if (provenance) await this.intake.writeReferralProvenance(provenance);

    const sourceCleanup = await this.deleteSourceIfUnchanged(input.inputPath, sourceEvidence);
    await this.intake.write({
      ...journal,
      state: "ingested",
      step_evidence: { ...(journal.step_evidence ?? {}), source_cleanup: sourceCleanup }
    });
    return "ingested";
  }

  private async proveCurrentDuplicate(
    projectId: string,
    contentHash: string
  ): Promise<{ document_id: string; version_id: string; reference_path: string } | null> {
    const fingerprint = await this.ledger.readReferenceFingerprint(projectId, contentHash);
    if (!fingerprint) return null;
    if (!await this.isCurrentReferenceFingerprint(projectId, contentHash, fingerprint)) return null;
    const head = await this.ledger.readHead(projectId, fingerprint.document_id);
    if (!head || !head.reference_version_id) return null;
    return {
      document_id: fingerprint.document_id,
      version_id: fingerprint.version_id,
      reference_path: `${head.collection_path ?? "UNCLASSIFIED"}/${head.logical_path}`
    };
  }

  private async isCurrentReferenceFingerprint(
    projectId: string,
    contentHash: string,
    fingerprint: ReferenceFingerprintRecord
  ): Promise<boolean> {
    const head = await this.ledger.readHead(projectId, fingerprint.document_id);
    if (
      !head
      || head.kind !== "reference"
      || head.reference_version_id !== fingerprint.version_id
      || !head.provider?.reference
    ) return false;
    const version = await this.ledger.readVersion(projectId, fingerprint.document_id, fingerprint.version_id);
    if (
      !version
      || version.kind !== "reference"
      || version.stage !== "reference"
      || version.provider_content_hash !== contentHash
    ) return false;
    const metadata = await this.runtime.objects.getMetadata(head.provider.reference.path);
    if (!metadata) return false;
    const current = requireDropboxV1Evidence(metadata);
    return current.content_hash === contentHash
      && current.file_id === head.provider.reference.file_id
      && current.rev === head.provider.reference.rev
      && current.size === head.provider.reference.size;
  }

  private async ensureDestinationCopy(
    sourcePath: string,
    targetPath: string,
    contentHash: string,
    size: number
  ): Promise<void> {
    try {
      await this.runtime.serverSideCopy.copyObject(sourcePath, targetPath);
    } catch (error) {
      const existing = await this.runtime.objects.getMetadata(targetPath);
      if (!existing) throw error;
      const evidence = requireDropboxV1Evidence(existing);
      if (evidence.content_hash !== contentHash || evidence.size !== size) throw error;
    }
  }

  private async requireMatchingMetadata(
    path: string,
    contentHash: string,
    size: number
  ): Promise<ProviderObjectMetadata> {
    const metadata = await this.runtime.objects.getMetadata(path);
    if (!metadata) throw new Error(`Intake destination missing after copy: ${path}`);
    const evidence = requireDropboxV1Evidence(metadata);
    if (evidence.content_hash !== contentHash || evidence.size !== size) {
      throw new Error(`Intake destination evidence mismatch: ${path}`);
    }
    return metadata;
  }

  private async requireGovernedReference(
    projectId: string,
    documentId: string,
    versionId: string,
    targetPath: string,
    contentHash: string,
    size: number
  ): Promise<void> {
    const version = await this.ledger.readVersion(projectId, documentId, versionId);
    const head = await this.ledger.readHead(projectId, documentId);
    const metadata = await this.requireMatchingMetadata(targetPath, contentHash, size);
    if (
      !version
      || version.kind !== "reference"
      || version.stage !== "reference"
      || !head
      || head.kind !== "reference"
      || head.reference_version_id !== versionId
      || !head.provider?.reference
    ) {
      throw new Error(`Governed reference proof incomplete: ${documentId}/${versionId}`);
    }
    const evidence = requireDropboxV1Evidence(metadata);
    if (
      head.provider.reference.file_id !== evidence.file_id
      || head.provider.reference.rev !== evidence.rev
      || head.provider.reference.content_hash !== evidence.content_hash
      || head.provider.reference.size !== evidence.size
    ) {
      throw new Error(`Governed reference provider proof mismatch: ${documentId}/${versionId}`);
    }
  }

  private async deleteSourceIfUnchanged(
    sourcePath: string,
    original: ReturnType<typeof requireDropboxV1Evidence>
  ): Promise<"deleted" | "skipped_revision_mismatch" | "already_missing"> {
    const currentMetadata = await this.runtime.objects.getMetadata(sourcePath);
    if (!currentMetadata) return "already_missing";
    const current = requireDropboxV1Evidence(currentMetadata);
    if (
      current.file_id !== original.file_id
      || current.rev !== original.rev
      || current.content_hash !== original.content_hash
      || current.size !== original.size
    ) return "skipped_revision_mismatch";
    await this.runtime.objects.delete(sourcePath);
    return "deleted";
  }

  private async referralProvenanceIfApplicable(
    state: ProjectState,
    input: IntakeProcessInput,
    documentId: string,
    versionId: string,
    sourceObjectId: string,
    sourceRevisionToken: string
  ): Promise<ReferralProvenanceRecord | null> {
    const filename = input.logicalPath.split("/").at(-1) ?? input.logicalPath;
    if (!filename.startsWith("REFERRAL-")) return null;
    const sourceText = await this.runtime.objects.readText(input.inputPath);
    const explicit = sourceText?.match(/^referral_id:\s*["']?(REF-[A-Z0-9-]{8,})["']?\s*$/mi)?.[1];
    const referralId = explicit ?? await legacyReferralIdFor(
      state.project_id,
      this.runtime.providerId,
      sourceObjectId
    );
    return {
      schema_version: "1.0",
      referral_id: referralId,
      project_id: state.project_id,
      document_id: documentId,
      version_id: versionId,
      source_input_path: input.inputPath,
      source_provider_id: this.runtime.providerId,
      source_object_id: sourceObjectId,
      source_revision_token: sourceRevisionToken,
      legacy_derived: explicit === undefined
    };
  }
}
