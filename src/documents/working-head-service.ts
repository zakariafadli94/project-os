import type { DocumentVersionRecord, ManagedDocumentHead } from "../domain/managed-document";
import { assertManagedRelativePath } from "../domain/managed-document";
import type { ProjectState } from "../domain/project-state";
import type { ForkWorkingRequest, SupersedeWorkingRequest } from "../domain/working-head-request";
import { requireDropboxV1Evidence, toManagedProviderObservation } from "../persistence/compatibility/dropbox-v1-evidence";
import { asProjectOsPersistence, type PersistenceInput } from "../persistence/compatibility/legacy-dropbox-runtime";
import { workspaceManagedDocumentPath, workspaceProjectRoot } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import { ProviderConflictError, ProviderPreconditionFailedError } from "../persistence/provider/errors";
import { sha256Text } from "./hash";
import { enforceManagedMarkdownIdentity } from "./identity-frontmatter";
import { DocumentLedgerRepository } from "./repository";
import { ManagedDocumentConflictError, ManagedDocumentService, type ManagedDocumentReceipt } from "./service";

export class ManagedWorkingHeadService {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly ledger: DocumentLedgerRepository;
  private readonly documents: ManagedDocumentService;

  constructor(input: PersistenceInput) {
    this.runtime = asProjectOsPersistence(input);
    this.ledger = new DocumentLedgerRepository(this.runtime);
    this.documents = new ManagedDocumentService(this.runtime);
  }

  async supersedeWorking(request: SupersedeWorkingRequest, state: ProjectState): Promise<ManagedDocumentReceipt> {
    this.assertMutableProject(request.project_id, state);
    const newLogicalPath = assertManagedRelativePath(request.new_logical_path);
    await this.assertContentHash(request.content, request.content_sha256);
    const versionId = await requestVersionIdFor(request.request_id);

    const replay = await this.ledger.readVersion(request.project_id, request.document_id, versionId);
    if (replay) {
      await this.finishInterruptedSupersede(request, state, replay);
      return receiptFor(request.request_id, replay);
    }

    const head = await this.requireWorkingHead(request.project_id, request.document_id);
    this.assertExpectedVersion(request.expected_version_id, head.working_version_id, request.document_id);
    const parent = await this.requireVersion(request.project_id, request.document_id, head.working_version_id!);
    const previousLogicalPath = head.logical_path;

    const managedContent = enforceManagedMarkdownIdentity(request.content, {
      projectId: request.project_id,
      documentId: request.document_id,
      logicalPath: newLogicalPath
    });
    const managedContentSha256 = await sha256Text(managedContent);
    const payloadPath = await this.ledger.storeTextPayload(request.project_id, managedContentSha256, managedContent);
    const previousVisiblePath = workspaceManagedDocumentPath(state.project_id, state.slug, "working", previousLogicalPath);
    const nextVisiblePath = workspaceManagedDocumentPath(state.project_id, state.slug, "working", newLogicalPath);

    let metadata: ProviderObjectMetadata;
    if (nextVisiblePath === previousVisiblePath) {
      metadata = await this.replaceCurrentHead(
        previousVisiblePath,
        managedContent,
        parent,
        head,
        request.document_id
      );
    } else {
      metadata = await this.ensureExactTarget(nextVisiblePath, managedContent, request.document_id);
      const archivePath = managedArchivePath(
        state,
        request.document_id,
        parent.version_id,
        previousLogicalPath
      );
      await this.ensurePreviousHeadArchived(
        previousVisiblePath,
        archivePath,
        parent,
        head,
        request.document_id
      );
    }

    const evidence = requireDropboxV1Evidence(metadata);
    const record: DocumentVersionRecord = {
      schema_version: "1.0",
      project_id: request.project_id,
      document_id: request.document_id,
      version_id: versionId,
      parent_version_id: parent.version_id,
      kind: "work_product",
      stage: "working",
      logical_path: newLogicalPath,
      source: "project_os",
      created_at: request.created_at,
      immutable_payload_path: payloadPath,
      content_sha256: managedContentSha256,
      provider_content_hash: evidence.content_hash,
      provider_file_id: evidence.file_id,
      provider_rev: evidence.rev,
      provider_path: nextVisiblePath,
      size: evidence.size,
      request_id: request.request_id
    };
    await this.ledger.writeVersion(record);
    await this.ledger.writeHead(headAfterSupersede(head, record, metadata));
    return receiptFor(request.request_id, record);
  }

  async forkWorking(request: ForkWorkingRequest, state: ProjectState): Promise<ManagedDocumentReceipt> {
    this.assertMutableProject(request.project_id, state);
    const source = await this.requireWorkingHead(request.project_id, request.source_document_id);
    this.assertExpectedVersion(request.expected_version_id, source.working_version_id, request.source_document_id);
    const sourceVersion = await this.requireVersion(request.project_id, request.source_document_id, source.working_version_id!);
    const sourcePath = workspaceManagedDocumentPath(state.project_id, state.slug, "working", source.logical_path);
    await this.assertProviderStillMatches(sourcePath, sourceVersion, source, request.source_document_id);

    const newLogicalPath = assertManagedRelativePath(request.new_logical_path);
    if (newLogicalPath === source.logical_path) {
      throw new ManagedDocumentConflictError(
        "FORK_PATH_CONFLICT",
        "A parallel working fork must use a distinct logical path",
        request.source_document_id
      );
    }

    return this.documents.writeWorking({
      request_id: request.request_id,
      project_id: request.project_id,
      logical_path: newLogicalPath,
      content: request.content,
      content_sha256: request.content_sha256,
      created_at: request.created_at
    }, state);
  }

  private async finishInterruptedSupersede(
    request: SupersedeWorkingRequest,
    state: ProjectState,
    replay: DocumentVersionRecord
  ): Promise<void> {
    if (replay.stage !== "working" || replay.document_id !== request.document_id) {
      throw new Error(`Managed working-head replay mismatch: ${request.request_id}`);
    }
    const currentHead = await this.requireWorkProductHead(request.project_id, request.document_id);
    if (currentHead.working_version_id === replay.version_id && currentHead.logical_path === replay.logical_path) return;

    const nextVisiblePath = workspaceManagedDocumentPath(state.project_id, state.slug, "working", replay.logical_path);
    const metadata = await this.requireMetadata(nextVisiblePath, request.document_id);
    const evidence = requireDropboxV1Evidence(metadata);
    if (
      replay.provider_rev !== evidence.rev
      || replay.provider_content_hash !== evidence.content_hash
      || replay.size !== evidence.size
    ) {
      throw new ManagedDocumentConflictError(
        "PROVIDER_VERSION_CHANGED",
        `Superseded working head changed before ledger recovery: ${nextVisiblePath}`,
        request.document_id
      );
    }

    const parentVersionId = replay.parent_version_id;
    if (!parentVersionId) throw new Error(`Superseded working version has no parent: ${replay.version_id}`);
    const parent = await this.requireVersion(request.project_id, request.document_id, parentVersionId);
    if (parent.logical_path !== replay.logical_path) {
      const previousVisiblePath = workspaceManagedDocumentPath(state.project_id, state.slug, "working", parent.logical_path);
      const archivePath = managedArchivePath(state, request.document_id, parent.version_id, parent.logical_path);
      await this.ensurePreviousHeadArchived(previousVisiblePath, archivePath, parent, currentHead, request.document_id);
    }
    await this.ledger.writeHead(headAfterSupersede(currentHead, replay, metadata));
  }

  private async replaceCurrentHead(
    path: string,
    content: string,
    parent: DocumentVersionRecord,
    head: ManagedDocumentHead,
    documentId: string
  ): Promise<ProviderObjectMetadata> {
    const current = await this.assertProviderStillMatches(path, parent, head, documentId);
    const evidence = requireDropboxV1Evidence(current);
    try {
      return await this.runtime.conditionalWrite.writeTextConditional(path, content, evidence.rev);
    } catch (error) {
      if (!(error instanceof ProviderPreconditionFailedError)) throw error;
      throw new ManagedDocumentConflictError(
        "PROVIDER_CAS_CONFLICT",
        `Managed working head changed concurrently during supersede: ${path}`,
        documentId
      );
    }
  }

  private async ensureExactTarget(
    path: string,
    content: string,
    documentId: string
  ): Promise<ProviderObjectMetadata> {
    const existing = await this.runtime.objects.getMetadata(path);
    if (existing) {
      const currentContent = await this.runtime.objects.readText(path);
      if (currentContent === content) return existing;
      throw new ManagedDocumentConflictError(
        "WORKING_TARGET_CONFLICT",
        `Working supersede destination already contains different content: ${path}`,
        documentId
      );
    }

    try {
      await this.runtime.objects.createText(path, content);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const racedContent = await this.runtime.objects.readText(path);
      if (racedContent !== content) {
        throw new ManagedDocumentConflictError(
          "WORKING_TARGET_CONFLICT",
          `Working supersede destination appeared concurrently: ${path}`,
          documentId
        );
      }
    }
    return this.requireMetadata(path, documentId);
  }

  private async ensurePreviousHeadArchived(
    previousVisiblePath: string,
    archivePath: string,
    parent: DocumentVersionRecord,
    head: ManagedDocumentHead,
    documentId: string
  ): Promise<void> {
    const current = await this.runtime.objects.getMetadata(previousVisiblePath);
    const archived = await this.runtime.objects.getMetadata(archivePath);

    if (!current) {
      if (!archived || !providerContentMatches(archived, parent)) {
        throw new ManagedDocumentConflictError(
          "WORKING_HEAD_MISSING",
          `Previous working head is missing without a verified archive: ${previousVisiblePath}`,
          documentId
        );
      }
      return;
    }

    await this.assertProviderStillMatches(previousVisiblePath, parent, head, documentId);
    if (archived) {
      throw new ManagedDocumentConflictError(
        "WORKING_ARCHIVE_CONFLICT",
        `Managed working-head archive destination already exists: ${archivePath}`,
        documentId
      );
    }

    const directory = archivePath.slice(0, archivePath.lastIndexOf("/"));
    await this.runtime.directoryProvisioning?.ensureDirectory(directory);
    try {
      await this.runtime.objects.move(previousVisiblePath, archivePath);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const retryArchived = await this.runtime.objects.getMetadata(archivePath);
      const retryCurrent = await this.runtime.objects.getMetadata(previousVisiblePath);
      if (retryCurrent || !retryArchived || !providerContentMatches(retryArchived, parent)) {
        throw new ManagedDocumentConflictError(
          "WORKING_ARCHIVE_CONFLICT",
          `Unable to verify working-head archive transition: ${archivePath}`,
          documentId
        );
      }
    }

    const verified = await this.runtime.objects.getMetadata(archivePath);
    if (!verified || !providerContentMatches(verified, parent)) {
      throw new ManagedDocumentConflictError(
        "WORKING_ARCHIVE_VERIFICATION_FAILED",
        `Archived working head does not match the superseded version: ${archivePath}`,
        documentId
      );
    }
  }

  private async assertProviderStillMatches(
    path: string,
    version: DocumentVersionRecord,
    head: ManagedDocumentHead,
    documentId: string
  ): Promise<ProviderObjectMetadata> {
    const metadata = await this.requireMetadata(path, documentId);
    const evidence = requireDropboxV1Evidence(metadata);
    const expectedRev = head.provider?.working?.rev ?? version.provider_rev;
    if (!expectedRev || evidence.rev !== expectedRev) {
      throw new ManagedDocumentConflictError(
        "PROVIDER_VERSION_CHANGED",
        `Managed working head changed outside Project OS: ${path}`,
        documentId
      );
    }
    return metadata;
  }

  private async requireWorkingHead(projectId: string, documentId: string): Promise<ManagedDocumentHead> {
    const head = await this.requireWorkProductHead(projectId, documentId);
    if (!head.working_version_id) {
      throw new ManagedDocumentConflictError("DOCUMENT_NOT_WORKING", "Document has no active working version", documentId);
    }
    if (head.review_version_id) {
      throw new ManagedDocumentConflictError("DOCUMENT_IN_REVIEW", "Document is already in review", documentId);
    }
    return head;
  }

  private async requireWorkProductHead(projectId: string, documentId: string): Promise<ManagedDocumentHead> {
    const head = await this.ledger.readHead(projectId, documentId)
      ?? await this.ledger.restoreHeadFromVersions(projectId, documentId);
    if (!head) throw new ManagedDocumentConflictError("DOCUMENT_NOT_FOUND", `Managed document not found: ${documentId}`, documentId);
    if (head.kind !== "work_product") {
      throw new ManagedDocumentConflictError("DOCUMENT_KIND_CONFLICT", "Document is not a work product", documentId);
    }
    return head;
  }

  private async requireVersion(projectId: string, documentId: string, versionId: string): Promise<DocumentVersionRecord> {
    const version = await this.ledger.readVersion(projectId, documentId, versionId);
    if (!version) throw new Error(`Managed document version missing: ${documentId}/${versionId}`);
    return version;
  }

  private async requireMetadata(path: string, documentId: string): Promise<ProviderObjectMetadata> {
    const metadata = await this.runtime.objects.getMetadata(path);
    if (!metadata) {
      throw new ManagedDocumentConflictError("PROVIDER_FILE_MISSING", `Managed document visible file is missing: ${path}`, documentId);
    }
    return metadata;
  }

  private assertExpectedVersion(expected: string, current: string | undefined, documentId: string): void {
    if (expected !== current) {
      throw new ManagedDocumentConflictError(
        "STALE_DOCUMENT_VERSION",
        `Managed document changed since the requested base version: expected ${expected}, current ${current ?? "none"}`,
        documentId
      );
    }
  }

  private assertMutableProject(projectId: string, state: ProjectState): void {
    if (projectId !== state.project_id) throw new Error("Managed document request project_id does not match project state");
    if (state.status === "archived") {
      throw new ManagedDocumentConflictError("PROJECT_ARCHIVED", "Archived projects do not accept managed document writes");
    }
  }

  private async assertContentHash(content: string, expected: string): Promise<void> {
    const actual = await sha256Text(content);
    if (actual !== expected) {
      throw new Error(`Managed document content SHA-256 mismatch: expected ${expected}, got ${actual}`);
    }
  }
}

async function requestVersionIdFor(requestId: string): Promise<string> {
  const digest = await sha256Text(`${requestId}\nworking`);
  return `VER-REQ-${digest.slice(0, 24).toUpperCase()}`;
}

function managedArchivePath(
  state: ProjectState,
  documentId: string,
  versionId: string,
  logicalPath: string
): string {
  return `${workspaceProjectRoot(state.project_id, state.slug)}/ARCHIVES/MANAGED-DOCUMENTS/${documentId}/${versionId}/${logicalPath}`;
}

function providerContentMatches(metadata: ProviderObjectMetadata, version: DocumentVersionRecord): boolean {
  if (!version.provider_content_hash || version.size === undefined) return false;
  const evidence = requireDropboxV1Evidence(metadata);
  return evidence.content_hash === version.provider_content_hash && evidence.size === version.size;
}

function headAfterSupersede(
  head: ManagedDocumentHead,
  version: DocumentVersionRecord,
  metadata: ProviderObjectMetadata
): ManagedDocumentHead {
  return {
    ...head,
    logical_path: version.logical_path,
    working_version_id: version.version_id,
    provider: {
      ...(head.provider ?? {}),
      working: toManagedProviderObservation({ ...metadata, path: version.provider_path ?? metadata.path })
    },
    reconciliation_status: "clean"
  };
}

function receiptFor(requestId: string, record: DocumentVersionRecord): ManagedDocumentReceipt {
  return {
    request_id: requestId,
    project_id: record.project_id,
    document_id: record.document_id,
    version_id: record.version_id,
    stage: record.stage === "recovered_external" ? "working" : record.stage,
    logical_path: record.logical_path,
    status: "committed",
    ...(record.provider_rev ? { provider_rev: record.provider_rev } : {})
  };
}
