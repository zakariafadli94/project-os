import { documentIdFor, type ManagedDocumentHead } from "../domain/managed-document";
import { asProjectOsPersistence, type PersistenceInput } from "../persistence/compatibility/legacy-dropbox-runtime";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ProviderObjectMetadata } from "../persistence/provider/contract";
import { ManagedDocumentActivePathIndex } from "./active-path-index";
import { readManagedMarkdownIdentity } from "./identity-frontmatter";
import { DocumentLedgerRepository } from "./repository";

export type WorkProductIdentityResolution =
  | { kind: "resolved"; documentId: string; head: ManagedDocumentHead | null; source: "active_path" | "provider_file" | "frontmatter" | "derived_path" }
  | { kind: "conflict"; code: "PROJECT_IDENTITY_MISMATCH" | "DOCUMENT_IDENTITY_ORPHANED" | "MULTIPLE_ACTIVE_WORKING_HEADS"; documentId?: string };

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
    if (indexed) return this.validateResolved(projectId, logicalPath, indexed.document_id, "active_path");

    const providerFileId = metadata?.objectId;
    if (providerFileId) {
      const binding = await this.ledger.readProviderFileBinding(projectId, providerFileId);
      if (binding) return this.validateResolved(projectId, logicalPath, binding.document_id, "provider_file");
    }

    const content = await this.runtime.objects.readText(visiblePath);
    if (content !== null) {
      const visibleIdentity = readManagedMarkdownIdentity(content, logicalPath);
      if (visibleIdentity?.projectId && visibleIdentity.projectId !== projectId) {
        return { kind: "conflict", code: "PROJECT_IDENTITY_MISMATCH" };
      }
      if (visibleIdentity?.documentId) {
        const head = await this.ledger.readHead(projectId, visibleIdentity.documentId);
        if (!head) {
          return { kind: "conflict", code: "DOCUMENT_IDENTITY_ORPHANED", documentId: visibleIdentity.documentId };
        }
        if (head.kind !== "work_product" || head.logical_path !== logicalPath) {
          return { kind: "conflict", code: "MULTIPLE_ACTIVE_WORKING_HEADS", documentId: visibleIdentity.documentId };
        }
        return { kind: "resolved", documentId: visibleIdentity.documentId, head, source: "frontmatter" };
      }
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
    source: "active_path" | "provider_file"
  ): Promise<WorkProductIdentityResolution> {
    const head = await this.ledger.readHead(projectId, documentId);
    if (!head) return { kind: "conflict", code: "DOCUMENT_IDENTITY_ORPHANED", documentId };
    if (head.kind !== "work_product" || head.logical_path !== logicalPath) {
      return { kind: "conflict", code: "MULTIPLE_ACTIVE_WORKING_HEADS", documentId };
    }
    return { kind: "resolved", documentId, head, source };
  }
}
