import {
  parseDocumentVersionRecord,
  parseManagedDocumentHead,
  type DocumentVersionRecord,
  type ManagedDocumentHead
} from "../domain/managed-document";
import {
  DropboxConflictError,
  type DropboxFileMetadata,
  type DropboxTransport
} from "../dropbox/client";
import {
  machineDocumentHeadPath,
  machineDocumentProviderPayloadPath,
  machineDocumentRoot,
  machineDocumentTextPayloadPath,
  machineDocumentVersionPath
} from "../dropbox/layout";
import { ResilientDropboxTransport } from "../dropbox/resilient-transport";
import { sha256Text } from "./hash";

export interface ReferenceFingerprintRecord {
  schema_version: "1.0";
  project_id: string;
  provider_content_hash: string;
  document_id: string;
  version_id: string;
}

export class DocumentLedgerRepository {
  private readonly transport: DropboxTransport;

  constructor(transport: DropboxTransport) {
    this.transport = new ResilientDropboxTransport(transport);
  }

  async readHead(projectId: string, documentId: string): Promise<ManagedDocumentHead | null> {
    const raw = await this.transport.download(machineDocumentHeadPath(projectId, documentId));
    if (raw === null) return null;
    const head = parseManagedDocumentHead(JSON.parse(raw));
    if (head.project_id !== projectId || head.document_id !== documentId) {
      throw new Error(`Managed document head binding mismatch for ${projectId}/${documentId}`);
    }
    return head;
  }

  async readVersion(projectId: string, documentId: string, versionId: string): Promise<DocumentVersionRecord | null> {
    const raw = await this.transport.download(machineDocumentVersionPath(projectId, documentId, versionId));
    if (raw === null) return null;
    const record = parseDocumentVersionRecord(JSON.parse(raw));
    if (record.project_id !== projectId || record.document_id !== documentId || record.version_id !== versionId) {
      throw new Error(`Managed document version binding mismatch for ${projectId}/${documentId}/${versionId}`);
    }
    return record;
  }

  async writeVersion(record: DocumentVersionRecord): Promise<void> {
    const validated = parseDocumentVersionRecord(record);
    const path = machineDocumentVersionPath(validated.project_id, validated.document_id, validated.version_id);
    try {
      await this.transport.upload(path, pretty(validated), "add");
    } catch (error) {
      if (!(error instanceof DropboxConflictError)) throw error;
      const existing = await this.transport.download(path);
      if (existing !== pretty(validated)) {
        throw new Error(`Immutable document version conflict with different content: ${path}`);
      }
    }
  }

  async writeHead(head: ManagedDocumentHead): Promise<void> {
    const validated = parseManagedDocumentHead(head);
    const pointers: Array<[keyof ManagedDocumentHead, string | undefined]> = [
      ["reference_version_id", validated.reference_version_id],
      ["working_version_id", validated.working_version_id],
      ["review_version_id", validated.review_version_id],
      ["published_version_id", validated.published_version_id]
    ];

    for (const [field, versionId] of pointers) {
      if (!versionId) continue;
      const version = await this.readVersion(validated.project_id, validated.document_id, versionId);
      if (!version) throw new Error(`Managed document head references missing version ${versionId}`);
      if (version.kind !== validated.kind) {
        throw new Error(`Managed document head/version kind mismatch for ${versionId}`);
      }
      if (!pointerAcceptsStage(field, version.stage)) {
        throw new Error(`Managed document head pointer ${String(field)} cannot reference ${version.stage} version ${versionId}`);
      }
    }

    await this.transport.upload(
      machineDocumentHeadPath(validated.project_id, validated.document_id),
      pretty(validated),
      "overwrite"
    );
  }

  async readReferenceFingerprint(projectId: string, providerContentHash: string): Promise<ReferenceFingerprintRecord | null> {
    const hash = assertProviderContentHash(providerContentHash);
    const raw = await this.transport.download(referenceFingerprintPath(projectId, hash));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<ReferenceFingerprintRecord>;
    if (
      parsed.schema_version !== "1.0"
      || parsed.project_id !== projectId
      || parsed.provider_content_hash !== hash
      || typeof parsed.document_id !== "string"
      || !/^DOC-[A-F0-9]{24}$/.test(parsed.document_id)
      || typeof parsed.version_id !== "string"
      || !/^VER-(?:EXT|REQ)-[A-F0-9]{24}$/.test(parsed.version_id)
    ) {
      throw new Error(`Invalid reference fingerprint record for ${projectId}/${hash}`);
    }
    return parsed as ReferenceFingerprintRecord;
  }

  async writeReferenceFingerprint(record: ReferenceFingerprintRecord): Promise<ReferenceFingerprintRecord> {
    const hash = assertProviderContentHash(record.provider_content_hash);
    if (record.schema_version !== "1.0" || !/^DOC-[A-F0-9]{24}$/.test(record.document_id) || !/^VER-(?:EXT|REQ)-[A-F0-9]{24}$/.test(record.version_id)) {
      throw new Error("Invalid reference fingerprint record");
    }
    const version = await this.readVersion(record.project_id, record.document_id, record.version_id);
    if (!version || version.kind !== "reference" || version.stage !== "reference" || version.provider_content_hash !== hash) {
      throw new Error(`Reference fingerprint does not match a durable reference version: ${record.document_id}/${record.version_id}`);
    }
    const validated: ReferenceFingerprintRecord = {
      schema_version: "1.0",
      project_id: record.project_id,
      provider_content_hash: hash,
      document_id: record.document_id,
      version_id: record.version_id
    };
    const path = referenceFingerprintPath(record.project_id, hash);
    try {
      await this.transport.upload(path, pretty(validated), "add");
      return validated;
    } catch (error) {
      if (!(error instanceof DropboxConflictError)) throw error;
      const existing = await this.readReferenceFingerprint(record.project_id, hash);
      if (!existing) throw error;
      return existing;
    }
  }

  async storeTextPayload(projectId: string, expectedSha256: string, content: string): Promise<string> {
    const actual = await sha256Text(content);
    if (actual !== expectedSha256) {
      throw new Error(`Managed document payload SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`);
    }
    const path = machineDocumentTextPayloadPath(projectId, actual);
    try {
      await this.transport.upload(path, content, "add");
    } catch (error) {
      if (!(error instanceof DropboxConflictError)) throw error;
      const existing = await this.transport.download(path);
      if (existing !== content) throw new Error(`Immutable document payload conflict with different content: ${path}`);
    }
    return path;
  }

  async snapshotProviderFile(
    projectId: string,
    documentId: string,
    versionId: string,
    sourcePath: string,
    sourceMetadata: DropboxFileMetadata
  ): Promise<DropboxFileMetadata> {
    if (!this.transport.copy) throw new Error("Dropbox transport does not support provider-side document snapshots");
    const path = machineDocumentProviderPayloadPath(projectId, documentId, versionId);
    try {
      return await this.transport.copy(sourcePath, path);
    } catch (error) {
      if (!(error instanceof DropboxConflictError) || !this.transport.getMetadata) throw error;
      const existing = await this.transport.getMetadata(path);
      if (
        existing
        && existing.content_hash === sourceMetadata.content_hash
        && existing.size === sourceMetadata.size
      ) {
        return existing;
      }
      throw new Error(`Immutable provider document payload conflict with different content: ${path}`);
    }
  }

  async restoreHeadFromVersions(projectId: string, documentId: string): Promise<ManagedDocumentHead | null> {
    if (!/^DOC-[A-F0-9]{24}$/.test(documentId)) throw new Error(`Unsafe document id: ${documentId}`);
    if (!this.transport.listFolder) throw new Error("Dropbox transport does not support document version listing");
    const versionRoot = `${machineDocumentRoot(projectId)}/versions/${documentId}`;
    const entries = await this.transport.listFolder(versionRoot);
    const records = new Map<string, DocumentVersionRecord>();

    for (const entry of entries) {
      if (entry.tag !== "file") continue;
      const match = /^(VER-(?:EXT|REQ)-[A-F0-9]{24})\.json$/.exec(entry.name);
      if (!match) continue;
      const record = await this.readVersion(projectId, documentId, match[1]);
      if (record) records.set(record.version_id, record);
    }

    const causal = [...records.values()].filter((record) => isCausallyComplete(record, records, new Set()));
    if (causal.length === 0) return null;
    const kind = causal[0].kind;
    if (causal.some((record) => record.kind !== kind)) {
      throw new Error(`Managed document version history mixes document kinds for ${documentId}`);
    }

    const newest = (stage: DocumentVersionRecord["stage"]) => causal
      .filter((record) => record.stage === stage)
      .sort(compareVersionRecords)
      .at(-1);
    const latestMeaningful = causal
      .filter((record) => record.stage !== "recovered_external")
      .sort(compareVersionRecords)
      .at(-1) ?? causal.sort(compareVersionRecords).at(-1)!;

    const head: ManagedDocumentHead = kind === "reference"
      ? {
          schema_version: "1.0",
          project_id: projectId,
          document_id: documentId,
          kind,
          logical_path: latestMeaningful.logical_path,
          reference_version_id: newest("reference")?.version_id,
          reconciliation_status: "clean"
        }
      : {
          schema_version: "1.0",
          project_id: projectId,
          document_id: documentId,
          kind,
          logical_path: latestMeaningful.logical_path,
          working_version_id: newest("working")?.version_id,
          review_version_id: newest("review")?.version_id,
          published_version_id: newest("published")?.version_id,
          reconciliation_status: "clean"
        };

    const validated = parseManagedDocumentHead(head);
    await this.writeHead(validated);
    return validated;
  }
}

function referenceFingerprintPath(projectId: string, providerContentHash: string): string {
  return `${machineDocumentRoot(projectId)}/reference-fingerprints/${assertProviderContentHash(providerContentHash)}.json`;
}

function assertProviderContentHash(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Unsafe provider content hash: ${value}`);
  return value;
}

function pointerAcceptsStage(field: keyof ManagedDocumentHead, stage: DocumentVersionRecord["stage"]): boolean {
  if (field === "reference_version_id") return stage === "reference";
  if (field === "working_version_id") return stage === "working";
  if (field === "review_version_id") return stage === "review";
  if (field === "published_version_id") return stage === "published";
  return false;
}

function isCausallyComplete(
  record: DocumentVersionRecord,
  records: ReadonlyMap<string, DocumentVersionRecord>,
  visiting: Set<string>
): boolean {
  if (!record.parent_version_id) return true;
  if (visiting.has(record.version_id)) return false;
  const parent = records.get(record.parent_version_id);
  if (!parent || parent.document_id !== record.document_id || parent.project_id !== record.project_id) return false;
  visiting.add(record.version_id);
  const valid = isCausallyComplete(parent, records, visiting);
  visiting.delete(record.version_id);
  return valid;
}

function compareVersionRecords(a: DocumentVersionRecord, b: DocumentVersionRecord): number {
  const time = Date.parse(a.created_at) - Date.parse(b.created_at);
  return time || a.version_id.localeCompare(b.version_id);
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}