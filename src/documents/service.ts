import type {
  DocumentVersionRecord,
  ManagedDocumentHead,
  ManagedProviderObservation
} from "../domain/managed-document";
import type { ArtifactWriteReceipt } from "../domain/artifact-write";
import { ReviewBinaryValidationError, verifyReviewBytesAtPath } from "../artifacts/review-bytes";
import { ReviewCandidateEvidenceChangedError, ReviewCandidateJournal } from "../artifacts/review-journal";
import { samePayload } from "../artifacts/staged-publication";
import { assertManagedRelativePath, assertReferenceCollectionPath, documentIdFor } from "../domain/managed-document";
import type { ProjectState } from "../domain/project-state";
import {
  requireDropboxV1Evidence,
  toManagedProviderObservation
} from "../persistence/compatibility/dropbox-v1-evidence";
import {
  asProjectOsPersistence,
  type PersistenceInput
} from "../persistence/compatibility/legacy-dropbox-runtime";
import { machineDocumentProviderPayloadPath, workspaceManagedDocumentPath } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import {
  ProviderConflictError,
  ProviderPreconditionFailedError
} from "../persistence/provider/errors";
import { sha256Text } from "./hash";
import { enforceManagedMarkdownIdentity } from "./identity-frontmatter";
import { DocumentLedgerRepository } from "./repository";
import { ManagedDocumentPromotionJournal } from "./promotion-journal";
import { DocumentPackageReplacement, type PackageReplaceRequest, type PackageExecutionOptions } from "./package-replacement";
import type { ExecutionAdmission } from "../execution/contract";
import type { ManagedDocumentRequest } from "../domain/managed-document-request";

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

export interface ManagedReviewCandidatePromotionRequest {
  operation: "review_candidate.promote";
  request_id: string;
  project_id: string;
  candidate_request_id: string;
  logical_path: string;
  expected_project_revision: number;
  accepted: true;
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
  candidate_request_id?: string;
  accepted?: true;
  published?: true;
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
  async freezePackageDocument(request: Extract<ManagedDocumentRequest, { operation: "package.freeze" }>, state: ProjectState) {
    if (request.project_id !== state.project_id || request.expected_project_revision !== state.revision) throw new Error("package_manifest_document_binding");
    const version = await this.ledger.readVersion(request.project_id, request.document_id, request.expected_version_id);
    if (!version || version.content_sha256 !== request.content_sha256) throw new Error("package_manifest_document_binding");
    const content = await this.ledger.readSearchableTextPayload(version);
    if (content === null || await sha256Text(content) !== request.content_sha256) throw new Error("package_manifest_document_binding");
    const manifest = JSON.parse(content);
    if (manifest.project_id !== request.project_id) throw new Error("package_manifest_document_binding");
    return this.ledger.freezePackage(manifest);
  }
  async replacePackage(request: PackageReplaceRequest, state: ProjectState, admission: ExecutionAdmission, options: PackageExecutionOptions = {}) {
    return new DocumentPackageReplacement(this.runtime).resume(request, state, admission, options);
  }
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly ledger: DocumentLedgerRepository;
  private readonly reviewCandidates: ReviewCandidateJournal;
  private readonly promotions: ManagedDocumentPromotionJournal;

  constructor(input: PersistenceInput) {
    this.runtime = asProjectOsPersistence(input);
    this.ledger = new DocumentLedgerRepository(this.runtime);
    this.reviewCandidates = new ReviewCandidateJournal(this.runtime);
    this.promotions = new ManagedDocumentPromotionJournal(this.runtime);
  }

  status(projectId: string, documentId: string): Promise<ManagedDocumentHead | null> {
    return this.readOrRestoreHead(projectId, documentId);
  }

  async writeWorking(request: ManagedTextWriteRequest, state: ProjectState): Promise<ManagedDocumentReceipt> {
    this.assertMutableProject(request.project_id, state);
    const logicalPath = assertManagedRelativePath(request.logical_path);
    await this.assertContentHash(request.content, request.content_sha256);
    const documentId = await documentIdFor(request.project_id, logicalPath);
    const managedContent = enforceManagedMarkdownIdentity(request.content, {
      projectId: request.project_id,
      documentId,
      logicalPath
    });
    const managedContentSha256 = await sha256Text(managedContent);
    const versionId = await requestVersionIdFor(request.request_id, "working");
    const replay = await this.ledger.readVersion(request.project_id, documentId, versionId);
    if (replay) return receiptFor(request.request_id, replay);

    const visiblePath = workspaceManagedDocumentPath(state.project_id, state.slug, "working", logicalPath);
    let head = await this.ledger.readHead(request.project_id, documentId);
    if (!head && await this.runtime.objects.getMetadata(visiblePath)) {
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
    const payloadPath = await this.ledger.storeTextPayload(request.project_id, managedContentSha256, managedContent);
    const metadata = await this.writeTextAtStage(
      visiblePath,
      managedContent,
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
      content_sha256: managedContentSha256,
      ...providerVersionFields(metadata, visiblePath),
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
    const managedContent = enforceManagedMarkdownIdentity(request.content, {
      projectId: request.project_id,
      documentId: request.document_id,
      logicalPath: head.logical_path
    });
    const managedContentSha256 = await sha256Text(managedContent);
    const payloadPath = await this.ledger.storeTextPayload(request.project_id, managedContentSha256, managedContent);
    const visiblePath = workspaceManagedDocumentPath(state.project_id, state.slug, "review", head.logical_path);
    const metadata = await this.writeTextAtStage(
      visiblePath,
      managedContent,
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
      content_sha256: managedContentSha256,
      ...providerVersionFields(metadata, visiblePath),
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
    await this.runtime.objects.move(from, to);
    const metadata = await this.requireMetadata(to);

    const record = versionFromParent(parent, {
      version_id: versionId,
      parent_version_id: parent.version_id,
      stage: "review",
      source: "project_os",
      created_at: request.created_at,
      ...providerVersionFields(metadata, to),
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

    const persistPublished = async (metadata: ProviderObjectMetadata): Promise<ManagedDocumentReceipt> => {
      const record = versionFromParent(review, {
        version_id: versionId,
        parent_version_id: review.version_id,
        stage: "published",
        source: "project_os",
        created_at: request.created_at,
        ...providerVersionFields(metadata, publishedPath),
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

    const visibleReview = await this.runtime.objects.getMetadata(reviewPath);
    if (!visibleReview) {
      const visiblePublished = await this.runtime.objects.getMetadata(publishedPath);
      if (visiblePublished && review.provider_content_hash && review.size !== undefined) {
        const publishedEvidence = requireDropboxV1Evidence(visiblePublished);
        if (
          publishedEvidence.content_hash === review.provider_content_hash
          && publishedEvidence.size === review.size
        ) {
          return persistPublished(visiblePublished);
        }
      }
      throw new ManagedDocumentConflictError(
        "REVIEW_CONTENT_MISSING",
        "Review candidate is missing and the published deliverable does not prove the expected interrupted publication",
        request.document_id
      );
    }

    const visibleReviewEvidence = requireDropboxV1Evidence(visibleReview);
    const expectedReviewRev = head.provider?.review?.rev ?? review.provider_rev;
    if (!expectedReviewRev || visibleReviewEvidence.rev !== expectedReviewRev) {
      throw new ManagedDocumentConflictError(
        "PROVIDER_VERSION_CHANGED",
        `Managed document visible file changed outside Project OS: ${reviewPath}`,
        request.document_id
      );
    }

    let metadata: ProviderObjectMetadata;
    if (head.published_version_id) {
      const priorPublished = await this.requireVersion(request.project_id, request.document_id, head.published_version_id);
      const currentPublished = await this.assertProviderStillMatches(
        publishedPath,
        priorPublished,
        head.provider?.published,
        request.document_id
      );
      const reviewContent = await this.runtime.objects.readText(reviewPath);
      if (reviewContent === null) {
        throw new ManagedDocumentConflictError("REVIEW_CONTENT_MISSING", "Review candidate content is missing", request.document_id);
      }
      const currentPublishedEvidence = requireDropboxV1Evidence(currentPublished);
      try {
        metadata = await this.runtime.conditionalWrite.writeTextConditional(
          publishedPath,
          reviewContent,
          currentPublishedEvidence.rev
        );
      } catch (error) {
        if (!(error instanceof ProviderPreconditionFailedError)) throw error;
        throw new ManagedDocumentConflictError(
          "PROVIDER_CAS_CONFLICT",
          `Published deliverable changed concurrently during publication: ${publishedPath}`,
          request.document_id
        );
      }
      await this.runtime.objects.delete(reviewPath);
    } else {
      await this.runtime.objects.move(reviewPath, publishedPath);
      metadata = await this.requireMetadata(publishedPath);
    }

    return persistPublished(metadata);
  }

  async promoteReviewCandidate(
    request: ManagedReviewCandidatePromotionRequest,
    state: ProjectState
  ): Promise<ManagedDocumentReceipt> {
    this.assertMutableProject(request.project_id, state);
    const logicalPath = assertManagedRelativePath(request.logical_path);
    const documentId = await documentIdFor(request.project_id, logicalPath);
    const versionId = await requestVersionIdFor(request.request_id, "published");
    const existingVersion = await this.ledger.readVersion(request.project_id, documentId, versionId);
    const existingHead = await this.ledger.readHead(request.project_id, documentId);

    if (existingVersion) {
      if (
        existingVersion.stage !== "published"
        || existingVersion.logical_path !== logicalPath
        || existingVersion.source_candidate_request_id !== request.candidate_request_id
      ) {
        throw new ManagedDocumentConflictError(
          "PROMOTION_HISTORY_CONFLICT",
          "Promotion request id is already bound to different immutable document history",
          documentId
        );
      }
      if (!existingHead) {
        const evidence = await this.promotions.read(request.project_id, request.request_id);
        if (!evidence) {
          throw new ManagedDocumentConflictError(
            "PROMOTION_HISTORY_INCOMPLETE",
            "Published version exists without immutable promotion evidence",
            documentId
          );
        }
        await this.ledger.writeHead(this.publishedHeadFromEvidence(evidence));
      } else if (existingHead.published_version_id !== versionId) {
        throw new ManagedDocumentConflictError(
          "DOCUMENT_ALREADY_EXISTS",
          "Logical document already has a different managed head",
          documentId
        );
      }
      return receiptFor(request.request_id, existingVersion);
    }

    if (state.revision !== request.expected_project_revision) {
      throw new ManagedDocumentConflictError(
        "PROJECT_REVISION_CONFLICT",
        `Project revision changed before review candidate promotion: expected ${request.expected_project_revision}, got ${state.revision}`,
        documentId
      );
    }
    if (existingHead) {
      throw new ManagedDocumentConflictError(
        "DOCUMENT_ALREADY_EXISTS",
        "Logical document already has a managed head",
        documentId
      );
    }

    const destinationPath = workspaceManagedDocumentPath(state.project_id, state.slug, "deliverables", logicalPath);
    const terminal = await this.reviewCandidates.terminalByRequestId(request.project_id, request.candidate_request_id);
    if (!terminal || terminal.receipt.status !== "committed" || !terminal.receipt.final_observation) {
      throw new ManagedDocumentConflictError(
        "CANDIDATE_RECEIPT_NOT_COMMITTED",
        "Promotion requires a committed REVIEW_CANDIDATE receipt with final provider observation",
        documentId
      );
    }

    const candidate = terminal.request;
    let sourceObservation: Awaited<ReturnType<ReviewCandidateJournal["observation"]>>;
    try {
      sourceObservation = await this.reviewCandidates.observation(candidate);
    } catch (error) {
      if (error instanceof ReviewCandidateEvidenceChangedError) {
        throw new ManagedDocumentConflictError("CANDIDATE_EVIDENCE_CHANGED", error.message, documentId);
      }
      throw error;
    }
    if (!sameReviewObservation(terminal.receipt.final_observation, sourceObservation)) {
      throw new ManagedDocumentConflictError(
        "CANDIDATE_EVIDENCE_CHANGED",
        "Committed review terminal evidence does not match the frozen provider observation",
        documentId
      );
    }
    const sourceMetadata = metadataFromReviewObservation(sourceObservation);
    try {
      await verifyReviewBytesAtPath(this.runtime, candidate, sourceObservation.path);
    } catch (error) {
      if (error instanceof ReviewBinaryValidationError) {
        throw new ManagedDocumentConflictError("CANDIDATE_EVIDENCE_CHANGED", error.message, documentId);
      }
      throw error;
    }

    const immutablePayloadPath = machineDocumentProviderPayloadPath(request.project_id, documentId, versionId);
    const existingDestination = await this.runtime.objects.getMetadata(destinationPath);
    if (existingDestination && !samePayload(sourceMetadata, existingDestination)) {
      throw new ManagedDocumentConflictError(
        "DELIVERABLE_PATH_COLLISION",
        `DELIVERABLES target already exists with different content: ${destinationPath}`,
        documentId
      );
    }
    await this.ledger.snapshotProviderFile(
      request.project_id,
      documentId,
      versionId,
      sourceObservation.path,
      sourceMetadata
    );

    let destinationMetadata: ProviderObjectMetadata;
    if (existingDestination) {
      destinationMetadata = existingDestination;
    } else {
      try {
        destinationMetadata = await this.runtime.serverSideCopy.copyObject(sourceObservation.path, destinationPath);
      } catch (error) {
        if (!(error instanceof ProviderConflictError)) throw error;
        const raced = await this.runtime.objects.getMetadata(destinationPath);
        if (!raced || !samePayload(sourceMetadata, raced)) {
          throw new ManagedDocumentConflictError(
            "DELIVERABLE_PATH_COLLISION",
            `DELIVERABLES target changed concurrently: ${destinationPath}`,
            documentId
          );
        }
        destinationMetadata = raced;
      }
    }
    if (!samePayload(sourceMetadata, destinationMetadata)) {
      throw new ManagedDocumentConflictError(
        "CANDIDATE_EVIDENCE_CHANGED",
        "Published provider object does not match the verified candidate payload",
        documentId
      );
    }

    const record: DocumentVersionRecord = {
      schema_version: "1.0",
      project_id: request.project_id,
      document_id: documentId,
      version_id: versionId,
      kind: "work_product",
      stage: "published",
      logical_path: logicalPath,
      source: "project_os",
      created_at: request.created_at,
      immutable_payload_path: immutablePayloadPath,
      media_type: candidate.media_type,
      source_candidate_request_id: request.candidate_request_id,
      ...providerVersionFields(destinationMetadata, destinationPath),
      request_id: request.request_id
    };
    await this.ledger.writeVersion(record);

    const evidence = {
      schema_version: "1.0" as const,
      request_id: request.request_id,
      project_id: request.project_id,
      candidate_request_id: request.candidate_request_id,
      document_id: documentId,
      version_id: versionId,
      logical_path: logicalPath,
      destination_path: destinationPath,
      accepted: true as const,
      published: true as const,
      source: providerEvidenceFromMetadata(this.runtime.providerId, sourceMetadata),
      destination: providerEvidenceFromMetadata(this.runtime.providerId, { ...destinationMetadata, path: destinationPath }),
      created_at: request.created_at
    };
    await this.promotions.write(evidence);
    await this.ledger.writeHead(this.publishedHeadFromEvidence(evidence));
    return receiptFor(request.request_id, record);
  }

  private publishedHeadFromEvidence(evidence: {
    project_id: string;
    document_id: string;
    version_id: string;
    logical_path: string;
    destination_path: string;
    destination: {
      path: string;
      object_id: string;
      revision_token: string;
      size: number;
      integrity_hash: { algorithm: string; value: string };
      provider_id: string;
    };
  }): ManagedDocumentHead {
    const metadata = metadataFromProviderEvidence(evidence.destination);
    return {
      schema_version: "1.0",
      project_id: evidence.project_id,
      document_id: evidence.document_id,
      kind: "work_product",
      logical_path: evidence.logical_path,
      published_version_id: evidence.version_id,
      provider: { published: providerObservation(metadata, evidence.destination_path) },
      reconciliation_status: "clean"
    };
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
    const metadata = await this.runtime.serverSideCopy.copyObject(from, to);

    const record = versionFromParent(published, {
      version_id: versionId,
      parent_version_id: published.version_id,
      stage: "working",
      source: "project_os",
      created_at: request.created_at,
      ...providerVersionFields(metadata, to),
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
        await this.runtime.objects.move(from, to);
      } catch (error) {
        if (!(error instanceof ProviderConflictError)) throw error;
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
      ...providerVersionFields(metadata, to),
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
    const evidence = requireDropboxV1Evidence(metadata);
    await this.ledger.writeReferenceFingerprint({
      schema_version: "1.0",
      project_id: request.project_id,
      provider_content_hash: evidence.content_hash,
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
    assertManagedDocumentExpectedVersion(expected, current, documentId);
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

  private async requireMetadata(path: string): Promise<ProviderObjectMetadata> {
    const metadata = await this.runtime.objects.getMetadata(path);
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
  ): Promise<ProviderObjectMetadata> {
    const metadata = await this.requireMetadata(path);
    const evidence = requireDropboxV1Evidence(metadata);
    const expectedRev = currentObservation?.rev ?? version.provider_rev;
    if (!expectedRev || evidence.rev !== expectedRev) {
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
  ): Promise<ProviderObjectMetadata> {
    if (!currentStageVersion) {
      const existing = await this.runtime.objects.getMetadata(path);
      if (existing) {
        const existingContent = await this.runtime.objects.readText(path);
        if (existingContent === content) return existing;
        throw new ManagedDocumentConflictError("UNTRACKED_VISIBLE_FILE", `Refusing to overwrite untracked managed document: ${path}`, documentId);
      }
      try {
        await this.runtime.objects.createText(path, content);
      } catch (error) {
        if (!(error instanceof ProviderConflictError)) throw error;
        throw new ManagedDocumentConflictError("VISIBLE_FILE_RACE", `Managed document appeared concurrently: ${path}`, documentId);
      }
      const persisted = await this.runtime.objects.readText(path);
      if (persisted !== content) {
        throw new ManagedDocumentConflictError("VISIBLE_FILE_CHANGED", `Managed document changed before write verification: ${path}`, documentId);
      }
      return this.requireMetadata(path);
    }

    const current = await this.requireMetadata(path);
    const currentEvidence = requireDropboxV1Evidence(current);
    const expectedRev = currentObservation?.rev ?? currentStageVersion.provider_rev;
    if (!expectedRev || currentEvidence.rev !== expectedRev) {
      throw new ManagedDocumentConflictError("PROVIDER_VERSION_CHANGED", `Managed document changed outside Project OS: ${path}`, documentId);
    }
    try {
      return await this.runtime.conditionalWrite.writeTextConditional(path, content, currentEvidence.rev);
    } catch (error) {
      if (!(error instanceof ProviderPreconditionFailedError)) throw error;
      throw new ManagedDocumentConflictError("PROVIDER_CAS_CONFLICT", `Managed document changed concurrently during update: ${path}`, documentId);
    }
  }
}

/** Shared deterministic comparison; callers remain responsible for loading a fresh canonical version. */
export function assertManagedDocumentExpectedVersion(expected: string | undefined, current: string | undefined, documentId: string): void {
  if (expected !== undefined && expected !== current) {
    throw new ManagedDocumentConflictError("STALE_DOCUMENT_VERSION", `Managed document changed since the requested base version: expected ${expected}, current ${current ?? "none"}`, documentId);
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

function providerVersionFields(metadata: ProviderObjectMetadata, path: string): Pick<
  DocumentVersionRecord,
  "provider_content_hash" | "provider_file_id" | "provider_rev" | "provider_path" | "size"
> {
  const evidence = requireDropboxV1Evidence({ ...metadata, path });
  return {
    provider_content_hash: evidence.content_hash,
    provider_file_id: evidence.file_id,
    provider_rev: evidence.rev,
    provider_path: path,
    size: evidence.size
  };
}

function providerObservation(metadata: ProviderObjectMetadata, path: string): ManagedProviderObservation {
  return toManagedProviderObservation({ ...metadata, path });
}

function metadataFromReviewObservation(observation: {
  provider_id: string;
  path: string;
  object_id: string;
  revision_token: string;
  size: number;
  integrity: { algorithm: string; value: string };
}): ProviderObjectMetadata {
  return {
    path: observation.path,
    size: observation.size,
    objectId: observation.object_id,
    revisionToken: observation.revision_token,
    integrityHash: observation.integrity
  };
}

function sameReviewObservation(
  left: NonNullable<ArtifactWriteReceipt["final_observation"]>,
  right: NonNullable<ArtifactWriteReceipt["final_observation"]>
): boolean {
  return left.provider_id === right.provider_id
    && left.path === right.path
    && left.object_id === right.object_id
    && left.revision_token === right.revision_token
    && left.size === right.size
    && left.integrity.algorithm === right.integrity.algorithm
    && left.integrity.value === right.integrity.value;
}

function providerEvidenceFromMetadata(providerId: string, metadata: ProviderObjectMetadata) {
  if (!metadata.objectId || !metadata.revisionToken || !metadata.integrityHash) {
    throw new Error(`Complete provider evidence is required for ${metadata.path}`);
  }
  return {
    provider_id: providerId,
    path: metadata.path,
    object_id: metadata.objectId,
    revision_token: metadata.revisionToken,
    integrity_hash: metadata.integrityHash,
    size: metadata.size
  };
}

function metadataFromProviderEvidence(observation: {
  path: string;
  object_id: string;
  revision_token: string;
  integrity_hash: { algorithm: string; value: string };
  size: number;
}): ProviderObjectMetadata {
  return {
    path: observation.path,
    objectId: observation.object_id,
    revisionToken: observation.revision_token,
    integrityHash: observation.integrity_hash,
    size: observation.size
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
    ...(record.provider_rev ? { provider_rev: record.provider_rev } : {}),
    ...(record.source_candidate_request_id
      ? {
          candidate_request_id: record.source_candidate_request_id,
          accepted: true as const,
          ...(record.stage === "published" ? { published: true as const } : {})
        }
      : {})
  };
}
