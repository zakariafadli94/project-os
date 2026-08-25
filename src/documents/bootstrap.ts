import {
  documentIdFor,
  documentIdForProviderFile,
  externalVersionIdFor,
  type DocumentVersionRecord,
  type ManagedDocumentHead,
  type ManagedDocumentKind,
  type ManagedProviderObservation
} from "../domain/managed-document";
import type { ProjectState } from "../domain/project-state";
import type { DropboxFileMetadata, DropboxTransport } from "../dropbox/client";
import {
  machineDocumentProviderPayloadPath,
  workspaceManagedZoneRoot
} from "../dropbox/layout";
import { ResilientDropboxTransport } from "../dropbox/resilient-transport";
import { MutationGateRepository } from "../mutation-gate/repository";
import { sha256Text } from "./hash";
import { DocumentLedgerRepository } from "./repository";

export type BootstrapManagedStage = "reference" | "working" | "review" | "published";
export type PublishedBootstrapProvenance = "legacy_artifact" | "managed_recovery";

export interface ManagedDocumentBootstrapOptions {
  publishedProvenance?: PublishedBootstrapProvenance;
}

export interface ManagedDocumentBootstrapResult {
  adopted: boolean;
  head: ManagedDocumentHead;
  version: DocumentVersionRecord;
}

export class ManagedDocumentBootstrapper {
  private readonly transport: ResilientDropboxTransport;
  private readonly ledger: DocumentLedgerRepository;
  private readonly mutations: MutationGateRepository;

  constructor(transport: DropboxTransport) {
    this.transport = new ResilientDropboxTransport(transport);
    this.ledger = new DocumentLedgerRepository(transport);
    this.mutations = new MutationGateRepository(transport);
  }

  async bootstrapExistingManagedPath(
    state: ProjectState,
    visiblePath: string,
    metadata: DropboxFileMetadata,
    inferredStage: BootstrapManagedStage,
    options: ManagedDocumentBootstrapOptions = {}
  ): Promise<ManagedDocumentBootstrapResult> {
    if (state.status === "archived") {
      throw new Error("Archived projects do not bootstrap active managed document paths");
    }

    const effectiveOptions = inferredStage === "published" && !options.publishedProvenance
      ? { ...options, publishedProvenance: await this.publishedProvenanceFromIntent(state, visiblePath) }
      : options;
    if (inferredStage === "published" && !effectiveOptions.publishedProvenance) {
      throw new Error("Published provenance is required before DELIVERABLES bootstrap");
    }

    const parsed = parseVisiblePath(state, visiblePath, inferredStage);
    const kind: ManagedDocumentKind = inferredStage === "reference" ? "reference" : "work_product";
    const providerBinding = inferredStage === "reference"
      ? await this.ledger.readProviderFileBinding(state.project_id, metadata.id)
      : null;
    const documentId = inferredStage === "reference"
      ? providerBinding?.document_id ?? await documentIdForProviderFile(state.project_id, metadata.id)
      : await documentIdFor(state.project_id, parsed.logicalPath);
    const existingHead = await this.ledger.readHead(state.project_id, documentId);

    if (existingHead) {
      assertCompatibleHead(
        existingHead,
        kind,
        providerBinding ? existingHead.logical_path : parsed.logicalPath
      );
      const existingVersionId = pointerFor(existingHead, inferredStage);
      if (existingVersionId) {
        const version = await this.ledger.readVersion(state.project_id, documentId, existingVersionId);
        if (!version) throw new Error(`Existing managed document head points to missing version: ${documentId}/${existingVersionId}`);
        return { adopted: false, head: existingHead, version };
      }
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

    const parentVersionId = parentForBootstrap(existingHead, inferredStage);
    const version: DocumentVersionRecord = {
      schema_version: "1.0",
      project_id: state.project_id,
      document_id: documentId,
      version_id: versionId,
      ...(parentVersionId ? { parent_version_id: parentVersionId } : {}),
      kind,
      stage: inferredStage,
      logical_path: existingHead?.logical_path ?? parsed.logicalPath,
      source: sourceForBootstrap(inferredStage, effectiveOptions),
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
    const head = mergeHead(existingHead, {
      projectId: state.project_id,
      documentId,
      kind,
      logicalPath: existingHead?.logical_path ?? parsed.logicalPath,
      collectionPath: parsed.collectionPath,
      stage: inferredStage,
      versionId,
      provider
    });
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

  private async publishedProvenanceFromIntent(
    state: ProjectState,
    visiblePath: string
  ): Promise<PublishedBootstrapProvenance | undefined> {
    const intents = await this.mutations.listArtifactIntentsForDestination(state.project_id, visiblePath);
    if (intents.length === 0) return undefined;
    const visible = await this.transport.download(visiblePath);
    if (visible === null) return undefined;
    const contentSha256 = await sha256Text(visible);
    return intents.some((intent) => intent.expected_content_sha256 === contentSha256)
      ? "legacy_artifact"
      : undefined;
  }
}

function sourceForBootstrap(
  stage: BootstrapManagedStage,
  options: ManagedDocumentBootstrapOptions
): DocumentVersionRecord["source"] {
  if (stage !== "published") return "external_human";
  if (options.publishedProvenance === "legacy_artifact") return "legacy_artifact_api";
  if (options.publishedProvenance === "managed_recovery") return "project_os";
  throw new Error("Published provenance is required before DELIVERABLES bootstrap");
}

function mergeHead(
  existing: ManagedDocumentHead | null,
  input: {
    projectId: string;
    documentId: string;
    kind: ManagedDocumentKind;
    logicalPath: string;
    collectionPath?: string;
    stage: BootstrapManagedStage;
    versionId: string;
    provider: ManagedProviderObservation;
  }
): ManagedDocumentHead {
  if (input.kind === "reference") {
    return {
      ...(existing ?? {
        schema_version: "1.0" as const,
        project_id: input.projectId,
        document_id: input.documentId,
        kind: "reference" as const,
        logical_path: input.logicalPath,
        reconciliation_status: "clean" as const
      }),
      collection_path: input.collectionPath ?? existing?.collection_path ?? "UNCLASSIFIED",
      reference_version_id: input.versionId,
      provider: { ...(existing?.provider ?? {}), reference: input.provider },
      reconciliation_status: "clean"
    };
  }

  const base: ManagedDocumentHead = existing ?? {
    schema_version: "1.0",
    project_id: input.projectId,
    document_id: input.documentId,
    kind: "work_product",
    logical_path: input.logicalPath,
    reconciliation_status: "clean"
  };
  const provider = { ...(base.provider ?? {}) };
  if (input.stage === "working") provider.working = input.provider;
  if (input.stage === "review") provider.review = input.provider;
  if (input.stage === "published") provider.published = input.provider;

  return {
    ...base,
    ...(input.stage === "working" ? { working_version_id: input.versionId } : {}),
    ...(input.stage === "review" ? { review_version_id: input.versionId } : {}),
    ...(input.stage === "published" ? { published_version_id: input.versionId } : {}),
    provider,
    reconciliation_status: "clean"
  };
}

function parentForBootstrap(head: ManagedDocumentHead | null, stage: BootstrapManagedStage): string | undefined {
  if (!head || stage === "reference") return undefined;
  if (stage === "working") return head.published_version_id;
  if (stage === "review") return head.working_version_id ?? head.published_version_id;
  return head.review_version_id ?? head.working_version_id;
}

function assertCompatibleHead(head: ManagedDocumentHead, kind: ManagedDocumentKind, logicalPath: string): void {
  if (head.kind !== kind) {
    throw new Error(`Managed document bootstrap kind mismatch for ${head.document_id}: ${head.kind} != ${kind}`);
  }
  if (head.logical_path !== logicalPath) {
    throw new Error(`Managed document bootstrap logical path mismatch for ${head.document_id}`);
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
