import { documentIdFor, type ManagedDocumentHead } from "../domain/managed-document";
import { asProjectOsPersistence, type PersistenceInput } from "../persistence/compatibility/legacy-dropbox-runtime";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import { ManagedDocumentActivePathIndex } from "./active-path-index";
import { readManagedMarkdownIdentity } from "./identity-frontmatter";
import { DocumentLedgerRepository } from "./repository";

export type WorkProductIdentityResolution =
  | { kind: "resolved"; documentId: string; head: ManagedDocumentHead | null; source: "active_path" | "provider_file" | "frontmatter" | "derived_path" }
  | { kind: "conflict"; code: "PROJECT_IDENTITY_MISMATCH" | "DOCUMENT_IDENTITY_ORPHANED" | "DOCUMENT_IDENTITY_MISMATCH" | "MULTIPLE_ACTIVE_WORKING_HEADS"; documentId?: string };

export class WorkProductIdentityResolver {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly ledger: DocumentLedgerRepository;
  private readonly activePaths: ManagedDocumentActivePathIndex;

  constructor(input: PersistenceInput) {
    this.runtime = asProjectOsPersistence(input);
    this.ledger = new DocumentLedgerRepository(this.runtime);
    this.activePaths = new ManagedDocumentActivePathIndex(this.runtime);
  }

  async resolveVisible(
    projectId: string,
    logicalPath: string,
    visiblePath: string,
    metadata?: ProviderObjectMetadata
  ): Promise<WorkProductIdentityResolution> {
    const indexed = await this.activePaths.read(projectId, logicalPath);
    const providerFileId = metadata?.objectId;
    const providerBinding = providerFileId
      ? await this.ledger.readProviderFileBinding(projectId, providerFileId)
      : null;

    const content = await this.runtime.objects.readText(visiblePath);
    const visibleIdentity = content === null ? null : readManagedMarkdownIdentity(content, logicalPath);
    if (visibleIdentity?.projectId && visibleIdentity.projectId !== projectId) {
      return { kind: "conflict", code: "PROJECT_IDENTITY_MISMATCH" };
    }

    const declaredDocumentId = visibleIdentity?.documentId;
    const candidateIds = [indexed?.document_id, providerBinding?.document_id, declaredDocumentId]
      .filter((value): value is string => Boolean(value));
    const distinct = [...new Set(candidateIds)];
    if (distinct.length > 1) {
      return {
        kind: "conflict",
        code: "DOCUMENT_IDENTITY_MISMATCH",
        ...(declaredDocumentId ? { documentId: declaredDocumentId } : {})
      };
    }

    if (indexed) {
      return this.validateResolved(projectId, logicalPath, indexed.document_id, "active_path");
    }
    if (providerBinding) {
      return this.validateResolved(projectId, logicalPath, providerBinding.document_id, "provider_file");
    }
    if (declaredDocumentId) {
      return this.validateResolved(projectId, logicalPath, declaredDocumentId, "frontmatter");
    }

    const derived = await documentIdFor(projectId, logicalPath);
    const head = await this.ledger.readHead(projectId, derived);
    return { kind: "resolved", documentId: derived, head, source: "derived_path" };
  }

  async resolveDeleted(projectId: string, logicalPath: string): Promise<WorkProductIdentityResolution> {
    const indexed = await this.activePaths.read(projectId, logicalPath);
    if (indexed) return this.validateResolved(projectId, logicalPath, indexed.document_id, "active_path");
    const derived = await documentIdFor(projectId, logicalPath);
    const head = await this.ledger.readHead(projectId, derived);
    return { kind: "resolved", documentId: derived, head, source: "derived_path" };
  }

  private async validateResolved(
    projectId: string,
    logicalPath: string,
    documentId: string,
    source: "active_path" | "provider_file" | "frontmatter"
  ): Promise<WorkProductIdentityResolution> {
    const head = await this.ledger.readHead(projectId, documentId);
    if (!head) return { kind: "conflict", code: "DOCUMENT_IDENTITY_ORPHANED", documentId };
    if (head.kind !== "work_product" || head.logical_path !== logicalPath) {
      return { kind: "conflict", code: "MULTIPLE_ACTIVE_WORKING_HEADS", documentId };
    }
    return { kind: "resolved", documentId, head, source };
  }
}
