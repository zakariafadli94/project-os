import {
  documentIdFor,
  documentIdForProviderFile,
  externalVersionIdFor,
  type DocumentVersionRecord,
  type ManagedDocumentHead,
  type ManagedProviderObservation
} from "../domain/managed-document";
import type { ProjectState } from "../domain/project-state";
import type { DropboxFileMetadata, DropboxTransport } from "../dropbox/client";
import {
  machineDocumentProviderPayloadPath,
  workspaceManagedZoneRoot
} from "../dropbox/layout";
import { DocumentLedgerRepository } from "./repository";

export type BootstrapManagedStage = "reference" | "working" | "review" | "published";

export interface ManagedDocumentBootstrapResult {
  adopted: boolean;
  head: ManagedDocumentHead;
  version: DocumentVersionRecord;
}

export class ManagedDocumentBootstrapper {
  private readonly ledger: DocumentLedgerRepository;

  constructor(transport: DropboxTransport) {
    this.ledger = new DocumentLedgerRepository(transport);
  }

  async bootstrapExistingManagedPath(
    state: ProjectState,
    visiblePath: string,
    metadata: DropboxFileMetadata,
    inferredStage: BootstrapManagedStage
  ): Promise<ManagedDocumentBootstrapResult> {
    if (state.status === "archived") {
      throw new Error("Archived projects do not bootstrap active managed document paths");
    }

    const parsed = parseVisiblePath(state, visiblePath, inferredStage);
    const documentId = inferredStage === "reference"
      ? await documentIdForProviderFile(state.project_id, metadata.id)
      : await documentIdFor(state.project_id, parsed.logicalPath);
    const existingHead = await this.ledger.readHead(state.project_id, documentId);
    if (existingHead) {
      const versionId = pointerFor(existingHead, inferredStage);
      if (!versionId) {
        throw new Error(`Existing managed document head does not match bootstrap stage ${inferredStage}: ${documentId}`);
      }
      const version = await this.ledger.readVersion(state.project_id, documentId, versionId);
      if (!version) throw new Error(`Existing managed document head points to missing version: ${documentId}/${versionId}`);
      return { adopted: false, head: existingHead, version };
    }

    const versionId = await externalVersionIdFor(metadata.rev);
    const immutablePayloadPath = machineDocumentProviderPayloadPath(state.project_id, documentId, versionId);
    await this.ledger.snapshotProviderFile(
      state.project_id,
      documentId,
      versionId,
      visiblePath,
      metadata
    );

    const kind = inferredStage === "reference" ? "reference" : "work_product";
    const version: DocumentVersionRecord = {
      schema_version: "1.0",
      project_id: state.project_id,
      document_id: documentId,
      version_id: versionId,
      kind,
      stage: inferredStage,
      logical_path: parsed.logicalPath,
      source: "external_human",
      created_at: metadata.server_modified ?? "1970-01-01T00:00:00.000Z",
      immutable_payload_path: immutablePayloadPath,
      provider_content_hash: metadata.content_hash,
      provider_file_id: metadata.id,
      provider_rev: metadata.rev,
      provider_path: visiblePath,
      size: metadata.size
    };
    await this.ledger.writeVersion(version);

    const provider = observation(visiblePath, metadata);
    const head: ManagedDocumentHead = inferredStage === "reference"
      ? {
          schema_version: "1.0",
          project_id: state.project_id,
          document_id: documentId,
          kind: "reference",
          logical_path: parsed.logicalPath,
          collection_path: parsed.collectionPath ?? "UNCLASSIFIED",
          reference_version_id: versionId,
          provider: { reference: provider },
          reconciliation_status: "clean"
        }
      : {
          schema_version: "1.0",
          project_id: state.project_id,
          document_id: documentId,
          kind: "work_product",
          logical_path: parsed.logicalPath,
          ...(inferredStage === "working" ? { working_version_id: versionId, provider: { working: provider } } : {}),
          ...(inferredStage === "review" ? { review_version_id: versionId, provider: { review: provider } } : {}),
          ...(inferredStage === "published" ? { published_version_id: versionId, provider: { published: provider } } : {}),
          reconciliation_status: "clean"
        };
    await this.ledger.writeHead(head);

    if (inferredStage === "reference") {
      await this.ledger.writeProviderFileBinding({
        schema_version: "1.0",
        project_id: state.project_id,
        provider_file_id: metadata.id,
        document_id: documentId
      });
      await this.ledger.writeReferenceFingerprint({
        schema_version: "1.0",
        project_id: state.project_id,
        provider_content_hash: metadata.content_hash,
        document_id: documentId,
        version_id: versionId
      });
    }

    return { adopted: true, head, version };
  }
}

function parseVisiblePath(
  state: ProjectState,
  visiblePath: string,
  stage: BootstrapManagedStage
): { logicalPath: string; collectionPath?: string } {
  const zone = stage === "published" ? "deliverables" : stage === "reference" ? "references" : stage;
  const root = workspaceManagedZoneRoot(state.project_id, state.slug, zone);
  const prefix = `${root}/`;
  if (!visiblePath.startsWith(prefix)) {
    throw new Error(`Managed document bootstrap path is outside expected ${zone} zone: ${visiblePath}`);
  }
  const relative = visiblePath.slice(prefix.length);
  if (!relative || relative.includes("//") || relative.split("/").some((part) => part === "." || part === ".." || !part)) {
    throw new Error(`Unsafe managed document bootstrap path: ${visiblePath}`);
  }

  if (stage !== "reference") return { logicalPath: relative };
  const parts = relative.split("/");
  const logicalPath = parts.pop()!;
  return {
    logicalPath,
    ...(parts.length > 0 ? { collectionPath: parts.join("/") } : {})
  };
}

function pointerFor(head: ManagedDocumentHead, stage: BootstrapManagedStage): string | undefined {
  if (stage === "reference") return head.reference_version_id;
  if (stage === "working") return head.working_version_id;
  if (stage === "review") return head.review_version_id;
  return head.published_version_id;
}

function observation(path: string, metadata: DropboxFileMetadata): ManagedProviderObservation {
  return {
    path,
    file_id: metadata.id,
    rev: metadata.rev,
    content_hash: metadata.content_hash,
    size: metadata.size
  };
}
