import type { CurrentDocumentVersionRecord } from "../schema/managed-document";
import { DocumentLedgerRepository } from "../documents/repository";
import type { ManagedDocumentSearchRecord, SearchZone } from "./contract";
import { hashSearchValue } from "./hash";

export async function buildManagedDocumentSearchRecord(
  ledger: DocumentLedgerRepository,
  projectId: string,
  documentId: string
): Promise<ManagedDocumentSearchRecord | null> {
  const head = await ledger.readHead(projectId, documentId);
  if (!head) return null;

  const selection = selectCurrentVersion(head);
  if (!selection) return null;

  const version = await ledger.readVersion(projectId, documentId, selection.versionId);
  if (!version) {
    throw new Error(`Managed document current version missing: ${documentId}/${selection.versionId}`);
  }
  if (version.kind !== head.kind || version.logical_path !== head.logical_path) {
    throw new Error(`Managed document current version binding mismatch: ${documentId}/${selection.versionId}`);
  }
  if (version.stage !== selection.stage) {
    throw new Error(`Managed document current version stage mismatch: ${documentId}/${selection.versionId}`);
  }

  const bodyText = await ledger.readSearchableTextPayload(version);
  const authorityRef = {
    kind: "managed_document" as const,
    project_id: projectId,
    document_id: documentId,
    version_id: version.version_id,
    logical_path: head.logical_path,
    ...(version.content_sha256 ? { content_sha256: version.content_sha256 } : {})
  };
  const semantic = {
    project_id: projectId,
    record_id: `document:${documentId}`,
    record_kind: "managed_document" as const,
    document_id: documentId,
    version_id: version.version_id,
    title: titleFor(head.logical_path),
    logical_path: head.logical_path,
    zone: selection.zone,
    stage_or_collection: selection.stageOrCollection,
    reconciliation_status: head.reconciliation_status,
    ...(bodyText !== null ? { body_text: bodyText } : {}),
    ...(version.media_type ? { media_type: version.media_type } : {}),
    updated_at: version.created_at,
    authority_ref: authorityRef
  };

  return {
    ...semantic,
    content_hash: await hashSearchValue(semantic)
  };
}

export async function buildManagedDocumentSearchRecords(
  ledger: DocumentLedgerRepository,
  projectId: string,
  documentIds: readonly string[]
): Promise<ManagedDocumentSearchRecord[]> {
  const records = await Promise.all(
    documentIds.map((documentId) => buildManagedDocumentSearchRecord(ledger, projectId, documentId))
  );
  return records.filter((record): record is ManagedDocumentSearchRecord => record !== null);
}

function selectCurrentVersion(head: Awaited<ReturnType<DocumentLedgerRepository["readHead"]>>): {
  versionId: string;
  stage: CurrentDocumentVersionRecord["stage"];
  zone: SearchZone;
  stageOrCollection: string;
} | null {
  if (!head) return null;
  if (head.kind === "reference") {
    if (!head.reference_version_id) return null;
    return {
      versionId: head.reference_version_id,
      stage: "reference",
      zone: "references",
      stageOrCollection: head.collection_path ?? "UNCLASSIFIED"
    };
  }
  if (head.working_version_id) {
    return {
      versionId: head.working_version_id,
      stage: "working",
      zone: "working",
      stageOrCollection: "working"
    };
  }
  if (head.review_version_id) {
    return {
      versionId: head.review_version_id,
      stage: "review",
      zone: "review",
      stageOrCollection: "review"
    };
  }
  if (head.published_version_id) {
    return {
      versionId: head.published_version_id,
      stage: "published",
      zone: "deliverables",
      stageOrCollection: "published"
    };
  }
  return null;
}

function titleFor(logicalPath: string): string {
  const file = logicalPath.split("/").at(-1) ?? logicalPath;
  const index = file.lastIndexOf(".");
  return index > 0 ? file.slice(0, index) : file;
}
