import type {
  DocumentVersionRecord,
  ManagedDocumentHead,
  ManagedProviderObservation
} from "../domain/managed-document";
import { assertManagedRelativePath, assertReferenceCollectionPath, documentIdFor } from "../domain/managed-document";
import type { ProjectState } from "../domain/project-state";
import { DropboxConflictError, type DropboxFileMetadata, type DropboxTransport } from "../dropbox/client";
import { workspaceManagedDocumentPath } from "../dropbox/layout";
import { ResilientDropboxTransport } from "../dropbox/resilient-transport";
import { sha256Text } from "./hash";
import { DocumentLedgerRepository } from "./repository";

export interface ManagedTextWriteRequest {
  request_id: string;
  project_id: string;
  logical_path: string;
  content: string;
  content_sha256: string;
  expected_version_id?: string;
  created_at: string;
}

export interface ManagedReviewWriteRequest {
  request_id: string;
  project_id: string;
  document_id: string;
  content: string;
  content_sha256: string;
  expected_version_id?: string;
  created_at: string;
}

export interface ManagedLifecycleRequest {
  request_id: string;
  project_id: string;
  document_id: string;
  expected_version_id?: string;
  created_at: string;
}

export interface ManagedReferenceClassificationRequest extends ManagedLifecycleRequest {
  collection_path: string;
}

export interface ManagedDocumentReceipt {
  request_id: string;
  project_id: string;
  document_id: string;
  version_id: string;
  stage: "reference" | "working" | "review" | "published";
  logical_path: string;
  status: "committed";
  provider_rev?: string;
}

export class ManagedDocumentConflictError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly documentId?: string
  ) {
    super(message);
    this.name = "ManagedDocumentConflictError";
  }
}

export class ManagedDocumentService {
  private readonly transport: ResilientDropboxTransport;
  private readonly ledger: DocumentLedgerRepository;

  constructor(transport: DropboxTransport) {
    this.transport = new ResilientDropboxTransport(transport);
    this.ledger = new DocumentLedgerRepository(transport);
  }

  status(projectId: string, documentId: string): Promise<ManagedDocumentHead | null> {
    return this.readOrRestoreHead(projectId, documentId);
  }

  async writeWorking(request: ManagedTextWriteRequest, state: ProjectState): Promise<ManagedDocumentReceipt> {
    this.assertMutableProject(request.project_id, state);
    const logicalPath = assertManagedRelativePath(request.logical_path);
    await this.assertContentHash(request.content, request.content_sha256);
    const documentId = await documentIdFor(request.project_id, logicalPath);
    const versionId = await requestVersionIdFor(request.request_id, "working");
    const replay = await this.ledger.readVersion(request.project_id, documentId, versionId);
    if (replay) return receiptFor(request.request_id, replay);

    const visiblePath = workspaceManagedDocumentPath(state.project_id, state.slug, "working", logicalPath);
    let head = await this.ledger.readHead(request.project_id, documentId);
    if (!head && this.transport.getMetadata && await this.transport.getMetadata(visiblePath)) {
      head = await this.ledger.restoreHeadFromVersions(request.project_id, documentId);
    }
    if (head && head.kind !== "work_product") {
      throw new ManagedDocumentConflictError("DOCUMENT_KIND_CONFLICT", "Logical document is already a reference", documentId);
    }
    if (head?.review_version_id) {
      throw new ManagedDocumentConflictError("DOCUMENT_IN_REVIEW", "Document is already in review; update the review candidate instead", documentId);
    }

    const currentVersionId = head?.working_version_id ?? head?.published_version_id;
    this.assertExpectedVersion(request.expected_version_id, currentVersionId, documentId);
    const parent = currentVersionId ? await this.requireVersion(request.project_id, documentId, currentVersionId) : null;
    const payloadPath = await this.ledger.storeTextPayload(request.project_id, request.content_sha256, request.content);
    const metadata = await this.writeTextAtStage(
      visiblePath,
      request.content,
      head?.working_version_id ? parent : null,
      head?.provider?.working,
      documentId
    );

    const record: DocumentVersionRecord = {
      schema_version: "1.0",
      project_id: request.project_id,
      document_id: documentId,
      version_id: versionId,
      ...(currentVersionId ? { parent_version_id: currentVersionId } : {}),
      kind: "work_product",
      stage: "working",
      logical_path: logicalPath,
      source: "project_os",
      created_at: request.created_at,
      immutable_payload_path: payloadPath,
      content_sha256: request.content_sha256,
      provider_content_hash: metadata.content_hash,
      provider_file_id: metadata.id,
      provider_rev: metadata.rev,
      provider_path: visiblePath,
      size: metadata.size,
      request_id: request.request_id
    };
    await this.ledger.writeVersion(record);
    await this.ledger.writeHead({
      schema_version: "1.0",
      project_id: request.project_id,
      document_id: documentId,
      kind: "work_product",
      logical_path: logicalPath,
      working_version_id: versionId,
      ...(head?.published_version_id ? { published_version_id: head.published_version_id } : {}),
      provider: compactProviderState({
        ...head?.provider,
        working: providerObservation(metadata, visiblePath)
      }),
      reconciliation_status: "clean"
    });
    return receiptFor(request.request_id, record);
  }

  async writeReview(request: ManagedReviewWriteRequest, state: ProjectState): Promise<ManagedDocumentReceipt> {
    this.assertMutableProject(request.project_id, state);
    await this.assertContentHash(request.content, request.content_sha256);
    const versionId = await requestVersionIdFor(request.request_id, "review");
    const replay = await this.ledger.readVersion(request.project_id, request.document_id, versionId);
    if (replay) return receiptFor(request.request_id, replay);

    const head = await this.requireWorkProductHead(request.project_id, request.document_id);
    const currentVersionId = head.review_version_id;
    if (!currentVersionId) {
      throw new ManagedDocumentConflictError("DOCUMENT_NOT_IN_REVIEW", "Document has no active review candidate", request.document_id);
    }
    this.assertExpectedVersion(request.expected_version_id, currentVersionId, request.document_id);
    const parent = await this.requireVersion(request.project_id, request.document_id, currentVersionId);
    const payloadPath = await this.ledger.storeTextPayload(request.project_id, request.content_sha256, request.content);
    const visiblePath = workspaceManagedDocumentPath(state.project_id, state.slug, "review", head.logical_path);
    const metadata = await this.writeTextAtStage(
      visiblePath,
      request.content,
      parent,
      head.provider?.review,
      request.document_id
    );

    const record = versionFromParent(parent, {
      version_id: versionId,
      parent_version_id: currentVersionId,
      stage: "review",
      source: "project_os",
      created_at: request.created_at,
      immutable_payload_path: payloadPath,
      content_sha256: request.content_sha256,
      provider_content_hash: metadata.content_hash,
      provider_file_id: metadata.id,
      provider_rev: metadata.rev,
      provider_path: visiblePath,
      size: metadata.size,
      request_id: request.request_id
    });
    await this.ledger.writeVersion(record);
    await this.ledger.writeHead({
      ...head,
      review_version_id: versionId,
      provider: compactProviderState({
        ...head.provider,
        review: providerObservation(metadata, visiblePath)
      }),
      reconciliation_status: "clean"
    });
    return receiptFor(request.request_id, record);
  }

  async promoteToReview(request: ManagedLifecycleRequest, state: ProjectState): Promise<ManagedDocumentReceipt> {
    this.assertMutableProject(request.project_id, state);
    const versionId = await requestVersionIdFor(request.request_id, "review");
    const replay = await this.ledger.readVersion(request.project_id, request.document_id, versionId);
    if (replay) return receiptFor(request.request_id, replay);

    const head = await this.requireWorkProductHead(request.project_id, request.document_id);
    if (!head.working_version_id) {
      throw new ManagedDocumentConflictError("DOCUMENT_NOT_WORKING", "Document has no active working version", request.document_id);
    }
    if (head.review_version_id) {
      throw new ManagedDocumentConflictError("DOCUMENT_ALREADY_IN_REVIEW", "Document already has a review candidate", request.document_id);
    }
    this.assertExpectedVersion(request.expected_version_id, head.working_version_id, request.document_id);
    const parent = await this.requireVersion(request.project_id, request.document_id, head.working_version_id);
    const from = workspaceManagedDocumentPath(state.project_id, state.slug, "working", head.logical_path);
    const to = workspaceManagedDocumentPath(state.project_id, state.slug, "review", head.logical_path);
    await this.assertProviderStillMatches(from, parent, head.provider?.working, request.document_id);
    await this.transport.move(from, to);
    const metadata = await this.requireMetadata(to);

    const record = versionFromParent(parent, {
      version_id: versionId,
      parent_version_id: parent.version_id,
      stage: "review",
      source: "project_os",
      created_at: request.created_at,
      provider_content_hash: metadata.content_hash,
      provider_file_id: metadata.id,
      provider_rev: metadata.rev,
      provider_path: to,
      size: metadata.size,
      request_id: request.request_id
    });
    await this.ledger.writeVersion(record);
    await this.ledger.writeHead({
      ...head,
      working_version_id: undefined,
      review_version_id: versionId,
      provider: compactProviderState({
        ...head.provider,
        working: undefined,
        review: providerObservation(metadata, to)
      }),
      reconciliation_status: "clean"
    });
    return receiptFor(request.request_id, record);
  }

  async publish(request: ManagedLifecycleRequest, state: ProjectState): Promise<ManagedDocumentReceipt> {
    this.assertMutableProject(request.project_id, state);
    const versionId = await requestVersionIdFor(request.request_id, "published");
    const replay = await this.ledger.readVersion(request.project_id, request.document_id, versionId);
    if (replay) return receiptFor(request.request_id, replay);

    const head = await this.requireWorkProductHead(request.project_id, request.document_id);
    if (!head.review_version_id) {
      throw new ManagedDocumentConflictError("DOCUMENT_NOT_IN_REVIEW", "Document must be in review before publication", request.document_id);
    }
    this.assertExpectedVersion(request.expected_version_id, head.review_version_id, request.document_id);
    const review = await this.requireVersion(request.project_id, request.document_id, head.review_version_id);
    const reviewPath = workspaceManagedDocumentPath(state.project_id, state.slug, "review", head.logical_path);
    const publishedPath = workspaceManagedDocumentPath(state.project_id, state.slug, "deliverables", head.logical_path);

    const persistPublished = async (metadata: DropboxFileMetadata): Promise<ManagedDocumentReceipt> => {
      const record = versionFromParent(review, {
        version_id: versionId,
        parent_version_id: review.version_id,
        stage: "published",
        source: "project_os",
        created_at: request.created_at,
        provider_content_hash: metadata.content_hash,
        provider_file_id: metadata.id,
        provider_rev: metadata.rev,
        provider_path: publishedPath,
        size: metadata.size,
        request_id: request.request_id
      });
      await this.ledger.writeVersion(record);
      await this.ledger.writeHead({
        ...head,
        working_version_id: undefined,
        review_version_id: undefined,
        published_version_id: versionId,
        provider: compactProviderState({
          ...head.provider,
          working: undefined,
          review: undefined,
          published: providerObservation(metadata, publishedPath)
        }),
        reconciliation_status: "clean"
      });
      return receiptFor(request.request_id, record);
    };

    if (!this.transport.getMetadata) throw new Error("Dropbox transport does not support managed-document metadata");
    const visibleReview = await this.transport.getMetadata(reviewPath);
    if (!visibleReview) {
      const visiblePublished = await this.transport.getMetadata(publishedPath);
      if (
        visiblePublished
        && review.provider_content_hash
        && review.size !== undefined
        && visiblePublished.content_hash === review.provider_content_hash
        && visiblePublished.size === review.size
      ) {
        return persistPublished(visiblePublished);
      }
      throw new ManagedDocumentConflictError(
        "REVIEW_CONTENT_MISSING",
        "Review candidate is missing and the published deliverable does not prove the expected interrupted publication",
        request.document_id
      );
    }

    const expectedReviewRev = head.provider?.review?.rev ?? review.provider_rev;
    if (!expectedReviewRev || visibleReview.rev !== expectedReviewRev) {
      throw new ManagedDocumentConflictError(
        "PROVIDER_VERSION_CHANGED",
        `Managed document visible file changed outside Project OS: ${reviewPath}`,
        request.document_id
      );
    }

    let metadata: DropboxFileMetadata;
    if (head.published_version_id) {
      const priorPublished = await this.requireVersion(request.project_id, request.document_id, head.published_version_id);
      const currentPublished = await this.assertProviderStillMatches(
        publishedPath,
        priorPublished,
        head.provider?.published,
        request.document_id
      );
      const reviewContent = await this.transport.download(reviewPath);
      if (reviewContent === null) {
        throw new ManagedDocumentConflictError("REVIEW_CONTENT_MISSING", "Review candidate content is missing", request.document_id);
      }
      if (!this.transport.uploadConditional) throw new Error("Dropbox transport does not support conditional managed-document writes");
      try {
        metadata = await this.transport.uploadConditional(publishedPath, reviewContent, currentPublished.rev);
      } catch (error) {
        if (!(error instanceof DropboxConflictError)) throw error;
        throw new ManagedDocumentConflictError(
          "PROVIDER_CAS_CONFLICT",
          `Published deliverable changed concurrently during publication: ${publishedPath}`,
          request.document_id
        );
      }
      if (!this.transport.delete) throw new Error("Dropbox transport does not support managed-document cleanup");
      await this.transport.delete(reviewPath);
    } else {
      await this.transport.move(reviewPath, publishedPath);
      metadata = await this.requireMetadata(publishedPath);
    }

    return persistPublished(metadata);
  }

  async reopenPublished(request: ManagedLifecycleRequest, state: ProjectState): Promise<ManagedDocumentReceipt> {
    this.assertMutableProject(request.project_id, state);
    const versionId = await requestVersionIdFor(request.request_id, "working");
    const replay = await this.ledger.readVersion(request.project_id, request.document_id, versionId);
    if (replay) return receiptFor(request.request_id, replay);

    const head = await this.requireWorkProductHead(request.project_id, request.document_id);
    if (!head.published_version_id) {
      throw new ManagedDocumentConflictError("DOCUMENT_NOT_PUBLISHED", "Document has no published version to reopen", request.document_id);
    }
    if (head.working_version_id || head.review_version_id) {
      throw new ManagedDocumentConflictError("DOCUMENT_ALREADY_ACTIVE", "Document already has an active working/review version", request.document_id);
    }
    this.assertExpectedVersion(request.expected_version_id, head.published_version_id, request.document_id);
    const published = await this.requireVersion(request.project_id, request.document_id, head.published_version_id);
    const from = workspaceManagedDocumentPath(state.project_id, state.slug, "deliverables", head.logical_path);
    const to = workspaceManagedDocumentPath(state.project_id, state.slug, "working", head.logical_path);
    await this.assertProviderStillMatches(from, published, head.provider?.published, request.document_id);
    if (!this.transport.copy) throw new Error("Dropbox transport does not support managed-document copy");
    const metadata = await this.transport.copy(from, to);

    const record = versionFromParent(published, {
      version_id: versionId,
      parent_version_id: published.version_id,
      stage: "working",
      source: "project_os",
      created_at: request.created_at,
      provider_content_hash: metadata.content_hash,
      provider_file_id: metadata.id,
      provider_rev: metadata.rev,
      provider_path: to,
      size: metadata.size,
      request_id: request.request_id
    });
    await this.ledger.writeVersion(record);
    await this.ledger.writeHead({
      ...head,
      working_version_id: versionId,
      provider: compactProviderState({
        ...head.provider,
        working: providerObservation(metadata, to)
      }),
      reconciliation_status: "clean"
    });
    return receiptFor(request.request_id, record);
  }

  async classifyReference(request: ManagedReferenceClassificationRequest, state: ProjectState): Promise<ManagedDocumentReceipt> {
    this.assertMutableProject(request.project_id, state);
    const collectionPath = assertReferenceCollectionPath(request.collection_path);
    const versionId = await requestVersionIdFor(request.request_id, "reference");
    const replay = await this.ledger.readVersion(request.project_id, request.document_id, versionId);
    if (replay) return receiptFor(request.request_id, replay);

    const head = await this.readOrRestoreHead(request.project_id, request.document_id);
    if (!head) {
      throw new ManagedDocumentConflictError("DOCUMENT_NOT_FOUND", `Managed reference not found: ${request.document_id}`, request.document_id);
    }
    if (head.kind !== "reference" || !head.reference_version_id) {
      throw new ManagedDocumentConflictError("DOCUMENT_KIND_CONFLICT", "Document is not a managed reference", request.document_id);
    }
    this.assertExpectedVersion(request.expected_version_id, head.reference_version_id, request.document_id);
    const parent = await this.requireVersion(request.project_id, request.document_id, head.reference_version_id);
    const from = head.provider?.reference?.path
      ?? workspaceManagedDocumentPath(
        state.project_id,
        state.slug,
        "references",
        `${head.collection_path ?? "UNCLASSIFIED"}/${head.logical_path}`
      );
    const to = workspaceManagedDocumentPath(
      state.project_id,
      state.slug,
      "references",
      `${collectionPath}/${head.logical_path}`
    );
    await this.assertProviderStillMatches(from, parent, head.provider?.reference, request.document_id);
    if (from !== to) {
      try {
        await this.transport.move(from, to);
      } catch (error) {
        if (!(error instanceof DropboxConflictError)) throw error;
        throw new ManagedDocumentConflictError(
          "REFERENCE_TARGET_CONFLICT",
          `Reference classification destination already exists: ${to}`,
          request.document_id
        );
      }
    }
    const metadata = await this.requireMetadata(to);
    const record = versionFromParent(parent, {
      version_id: versionId,
      parent_version_id: parent.version_id,
      stage: "reference",
      source: "project_os",
      created_at: request.created_at,
      provider_content_hash: metadata.content_hash,
      provider_file_id: metadata.id,
      provider_rev: metadata.rev,
      provider_path: to,
      size: metadata.size,
      request_id: request.request_id
    });
    await this.ledger.writeVersion(record);
    await this.ledger.writeHead({
      ...head,
      collection_path: collectionPath,
      reference_version_id: versionId,
      provider: { reference: providerObservation(metadata, to) },
      reconciliation_status: "clean"
    });
    await this.ledger.writeReferenceFingerprint({
      schema_version: "1.0",
      project_id: request.project_id,
      provider_content_hash: metadata.content_hash,
      document_id: request.document_id,
      version_id: versionId
    });
    return receiptFor(request.request_id, record);
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

  private assertExpectedVersion(expected: string | undefined, current: string | undefined, documentId: string): void {
    if (expected !== undefined && expected !== current) {
      throw new ManagedDocumentConflictError(
        "STALE_DOCUMENT_VERSION",
        `Managed document changed since the requested base version: expected ${expected}, current ${current ?? "none"}`,
        documentId
      );
    }
  }

  private async readOrRestoreHead(projectId: string, documentId: string): Promise<ManagedDocumentHead | null> {
    const existing = await this.ledger.readHead(projectId, documentId);
    return existing ?? this.ledger.restoreHeadFromVersions(projectId, documentId);
  }

  private async requireWorkProductHead(projectId: string, documentId: string): Promise<ManagedDocumentHead> {
    const head = await this.readOrRestoreHead(projectId, documentId);
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

  private async requireMetadata(path: string): Promise<DropboxFileMetadata> {
    if (!this.transport.getMetadata) throw new Error("Dropbox transport does not support managed-document metadata");
    const metadata = await this.transport.getMetadata(path);
    if (!metadata) {
      throw new ManagedDocumentConflictError("PROVIDER_FILE_MISSING", `Managed document visible file is missing: ${path}`);
    }
    return metadata;
  }

  private async assertProviderStillMatches(
    path: string,
    version: DocumentVersionRecord,
    currentObservation: ManagedProviderObservation | undefined,
    documentId: string
  ): Promise<DropboxFileMetadata> {
    const metadata = await this.requireMetadata(path);
    const expectedRev = currentObservation?.rev ?? version.provider_rev;
    if (!expectedRev || metadata.rev !== expectedRev) {
      throw new ManagedDocumentConflictError(
        "PROVIDER_VERSION_CHANGED",
        `Managed document visible file changed outside Project OS: ${path}`,
        documentId
      );
    }
    return metadata;
  }

  private async writeTextAtStage(
    path: string,
    content: string,
    currentStageVersion: DocumentVersionRecord | null,
    currentObservation: ManagedProviderObservation | undefined,
    documentId: string
  ): Promise<DropboxFileMetadata> {
    if (!this.transport.getMetadata) throw new Error("Dropbox transport does not support managed-document metadata");
    if (!currentStageVersion) {
      const existing = await this.transport.getMetadata(path);
      if (existing) {
        const existingContent = await this.transport.download(path);
        if (existingContent === content) return existing;
        throw new ManagedDocumentConflictError("UNTRACKED_VISIBLE_FILE", `Refusing to overwrite untracked managed document: ${path}`, documentId);
      }
      try {
        await this.transport.upload(path, content, "add");
      } catch (error) {
        if (!(error instanceof DropboxConflictError)) throw error;
        throw new ManagedDocumentConflictError("VISIBLE_FILE_RACE", `Managed document appeared concurrently: ${path}`, documentId);
      }
      const persisted = await this.transport.download(path);
      if (persisted !== content) {
        throw new ManagedDocumentConflictError("VISIBLE_FILE_CHANGED", `Managed document changed before write verification: ${path}`, documentId);
      }
      return this.requireMetadata(path);
    }

    const current = await this.requireMetadata(path);
    const expectedRev = currentObservation?.rev ?? currentStageVersion.provider_rev;
    if (!expectedRev || current.rev !== expectedRev) {
      throw new ManagedDocumentConflictError("PROVIDER_VERSION_CHANGED", `Managed document changed outside Project OS: ${path}`, documentId);
    }
    if (!this.transport.uploadConditional) throw new Error("Dropbox transport does not support conditional managed-document writes");
    try {
      return await this.transport.uploadConditional(path, content, current.rev);
    } catch (error) {
      if (!(error instanceof DropboxConflictError)) throw error;
      throw new ManagedDocumentConflictError("PROVIDER_CAS_CONFLICT", `Managed document changed concurrently during update: ${path}`, documentId);
    }
  }
}

async function requestVersionIdFor(requestId: string, stage: "reference" | "working" | "review" | "published"): Promise<string> {
  if (!/^[A-Z][A-Z0-9-]{7,}$/.test(requestId)) throw new Error(`Invalid managed document request id: ${requestId}`);
  const digest = await sha256Text(`${requestId}\n${stage}`);
  return `VER-REQ-${digest.slice(0, 24).toUpperCase()}`;
}

function versionFromParent(
  parent: DocumentVersionRecord,
  changes: Partial<DocumentVersionRecord> & Pick<DocumentVersionRecord, "version_id" | "stage" | "source" | "created_at">
): DocumentVersionRecord {
  return {
    ...parent,
    ...changes,
    project_id: parent.project_id,
    document_id: parent.document_id,
    kind: parent.kind,
    logical_path: parent.logical_path
  };
}

function providerObservation(metadata: DropboxFileMetadata, path: string): ManagedProviderObservation {
  return {
    path,
    file_id: metadata.id,
    rev: metadata.rev,
    content_hash: metadata.content_hash,
    size: metadata.size
  };
}

function compactProviderState<T extends Record<string, ManagedProviderObservation | undefined>>(state: T): T {
  return Object.fromEntries(Object.entries(state).filter(([, value]) => value !== undefined)) as T;
}

function receiptFor(requestId: string, record: DocumentVersionRecord): ManagedDocumentReceipt {
  if (record.stage !== "reference" && record.stage !== "working" && record.stage !== "review" && record.stage !== "published") {
    throw new Error(`Cannot build managed document receipt for stage ${record.stage}`);
  }
  return {
    request_id: requestId,
    project_id: record.project_id,
    document_id: record.document_id,
    version_id: record.version_id,
    stage: record.stage,
    logical_path: record.logical_path,
    status: "committed",
    ...(record.provider_rev ? { provider_rev: record.provider_rev } : {})
  };
}
