import {
  documentIdForProviderFile,
  type DocumentVersionRecord,
  type ManagedDocumentHead,
  type ManagedProviderObservation
} from "../domain/managed-document";
import {
  machineDocumentHeadPath,
  machineDocumentProviderPayloadPath,
  machineDocumentRoot,
  machineDocumentTextPayloadPath,
  machineDocumentVersionPath
} from "../persistence/layout";
import {
  requireDropboxV1Evidence,
  toManagedProviderObservation
} from "../persistence/compatibility/dropbox-v1-evidence";
import {
  asProjectOsPersistence,
  toProviderObjectMetadata,
  type LegacyDropboxFileMetadata,
  type PersistenceInput
} from "../persistence/compatibility/legacy-dropbox-runtime";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { ObjectPersistence, ProviderObjectMetadata } from "../persistence/provider/contract";
import { ProviderConflictError } from "../persistence/provider/errors";
import {
  encodeDocumentVersionRecord,
  encodeManagedDocumentHead,
  readDocumentVersionRecord,
  readManagedDocumentHead,
  type CurrentDocumentVersionRecord,
  type CurrentManagedDocumentHead,
  type CurrentManagedProviderObservation,
  type DocumentVersionWriteInput,
  type ManagedDocumentHeadWriteInput
} from "../schema/managed-document";
import {
  parseProviderFileBindingV1,
  parseProviderFileBindingV2,
  parseReferenceFingerprintV1,
  parseReferenceFingerprintV2,
  type ProviderFileBindingV2Record,
  type ReferenceFingerprintV2Record
} from "../schema/provider-index";
import { upcastDropboxV1Observation, type ProviderObservation } from "../schema/provider-evidence";
import { schemaWriterStageFor } from "../schema/runtime-policy";
import { writesProviderV2, type SchemaWriterStage } from "../schema/writer-stage";
import { sha256Text } from "./hash";

const DROPBOX_PROVIDER_ID = "dropbox";
const DROPBOX_CONTENT_HASH_ALGORITHM = "dropbox-content-hash";

export interface ReferenceFingerprintRecord {
  schema_version: "1.0";
  project_id: string;
  provider_content_hash: string;
  document_id: string;
  version_id: string;
}

export interface ProviderFileBindingRecord {
  schema_version: "1.0";
  project_id: string;
  provider_file_id: string;
  document_id: string;
}

export class DocumentLedgerRepository {
  private readonly runtime: ProjectOsPersistenceRuntime;
  private readonly schemaWriterStage: SchemaWriterStage;

  constructor(
    input: PersistenceInput,
    schemaWriterStage: SchemaWriterStage = "v1_only"
  ) {
    this.runtime = asProjectOsPersistence(input);
    this.schemaWriterStage = schemaWriterStageFor(this.runtime, schemaWriterStage);
  }

  async readHead(projectId: string, documentId: string): Promise<CurrentManagedDocumentHead | null> {
    const raw = await this.runtime.objects.readText(machineDocumentHeadPath(projectId, documentId));
    if (raw === null) return null;
    const head = readManagedDocumentHead(JSON.parse(raw)).head;
    if (head.project_id !== projectId || head.document_id !== documentId) {
      throw new Error(`Managed document head binding mismatch for ${projectId}/${documentId}`);
    }
    return head;
  }

  async readVersion(projectId: string, documentId: string, versionId: string): Promise<CurrentDocumentVersionRecord | null> {
    const raw = await this.runtime.objects.readText(machineDocumentVersionPath(projectId, documentId, versionId));
    if (raw === null) return null;
    const record = readDocumentVersionRecord(JSON.parse(raw)).record;
    if (record.project_id !== projectId || record.document_id !== documentId || record.version_id !== versionId) {
      throw new Error(`Managed document version binding mismatch for ${projectId}/${documentId}/${versionId}`);
    }
    return record;
  }

  async writeVersion(record: DocumentVersionWriteInput): Promise<void> {
    const serialized = encodeDocumentVersionRecord(record, this.schemaWriterStage);
    const validated = readDocumentVersionRecord(serialized).record;
    const path = machineDocumentVersionPath(validated.project_id, validated.document_id, validated.version_id);
    const content = pretty(serialized);
    try {
      await this.runtime.objects.createText(path, content);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.runtime.objects.readText(path);
      if (existing === null) throw error;
      const existingRecord = readDocumentVersionRecord(JSON.parse(existing)).record;
      const canonicalExisting = pretty(encodeDocumentVersionRecord(existingRecord, this.schemaWriterStage));
      if (canonicalExisting !== content) {
        throw new Error(`Immutable document version conflict with different content: ${path}`);
      }
    }
  }

  async writeHead(head: ManagedDocumentHeadWriteInput): Promise<void> {
    const serialized = encodeManagedDocumentHead(head, this.schemaWriterStage);
    const validated = readManagedDocumentHead(serialized).head;
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

    await this.runtime.objects.upsertText(
      machineDocumentHeadPath(validated.project_id, validated.document_id),
      pretty(serialized)
    );
  }

  async readProviderFileBinding(projectId: string, providerFileId: string): Promise<ProviderFileBindingRecord | null> {
    const v2Path = await providerFileBindingV2Path(projectId, DROPBOX_PROVIDER_ID, providerFileId);
    const v1Path = await providerFileBindingPath(projectId, providerFileId);
    const v2Raw = await this.runtime.objects.readText(v2Path);
    const v1Raw = await this.runtime.objects.readText(v1Path);
    const v2 = v2Raw === null ? null : normalizeProviderFileBindingV2(
      parseBoundProviderFileBindingV2(JSON.parse(v2Raw), projectId, providerFileId)
    );
    const v1 = v1Raw === null ? null : parseBoundProviderFileBindingV1(
      JSON.parse(v1Raw),
      projectId,
      providerFileId
    );

    if (v2 && v1 && v2.document_id !== v1.document_id) {
      throw new Error(`Contradictory V1/V2 provider-file bindings for ${projectId}/${providerFileId}`);
    }
    return v2 ?? v1;
  }

  async writeProviderFileBinding(record: ProviderFileBindingRecord): Promise<void> {
    const validated = parseBoundProviderFileBindingV1(record, record.project_id, record.provider_file_id);
    const head = await this.readHead(validated.project_id, validated.document_id);
    if (!head) throw new Error(`Provider-file binding references missing managed document head: ${validated.document_id}`);

    const existing = await this.readProviderFileBinding(validated.project_id, validated.provider_file_id);
    if (existing) {
      if (existing.document_id !== validated.document_id) {
        throw new Error(`Provider file id is already bound to a different managed document: ${validated.provider_file_id}`);
      }
      return;
    }

    const useV2 = writesProviderV2(this.schemaWriterStage);
    const serialized: ProviderFileBindingRecord | ProviderFileBindingV2Record = useV2
      ? parseProviderFileBindingV2({
          schema_version: "2.0",
          project_id: validated.project_id,
          provider_id: DROPBOX_PROVIDER_ID,
          object_id: validated.provider_file_id,
          document_id: validated.document_id
        })
      : validated;
    const path = useV2
      ? await providerFileBindingV2Path(validated.project_id, DROPBOX_PROVIDER_ID, validated.provider_file_id)
      : await providerFileBindingPath(validated.project_id, validated.provider_file_id);

    try {
      await this.runtime.objects.createText(path, pretty(serialized));
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const raced = await this.readProviderFileBinding(validated.project_id, validated.provider_file_id);
      if (!raced || raced.document_id !== validated.document_id) {
        throw new Error(`Provider file id is already bound to a different managed document: ${validated.provider_file_id}`);
      }
    }
  }

  async readReferenceFingerprint(projectId: string, providerContentHash: string): Promise<ReferenceFingerprintRecord | null> {
    const hash = assertProviderContentHash(providerContentHash);
    const v2Path = await referenceFingerprintV2Path(
      projectId,
      DROPBOX_PROVIDER_ID,
      DROPBOX_CONTENT_HASH_ALGORITHM,
      hash
    );
    const v1Path = referenceFingerprintPath(projectId, hash);
    const v2Raw = await this.runtime.objects.readText(v2Path);
    const v1Raw = await this.runtime.objects.readText(v1Path);
    const v2 = v2Raw === null ? null : normalizeReferenceFingerprintV2(
      parseBoundReferenceFingerprintV2(JSON.parse(v2Raw), projectId, hash)
    );
    const v1 = v1Raw === null ? null : parseBoundReferenceFingerprintV1(JSON.parse(v1Raw), projectId, hash);

    if (
      v2
      && v1
      && (v2.document_id !== v1.document_id || v2.version_id !== v1.version_id)
    ) {
      throw new Error(`Contradictory V1/V2 reference fingerprints for ${projectId}/${hash}`);
    }
    return v2 ?? v1;
  }

  async writeReferenceFingerprint(record: ReferenceFingerprintRecord): Promise<ReferenceFingerprintRecord> {
    const hash = assertProviderContentHash(record.provider_content_hash);
    const validated = parseBoundReferenceFingerprintV1(record, record.project_id, hash);
    const version = await this.readVersion(validated.project_id, validated.document_id, validated.version_id);
    if (!version || version.kind !== "reference" || version.stage !== "reference" || version.provider_content_hash !== hash) {
      throw new Error(`Reference fingerprint does not match a durable reference version: ${validated.document_id}/${validated.version_id}`);
    }

    const existing = await this.readReferenceFingerprint(validated.project_id, hash);
    const sameEvidence = existing
      && existing.document_id === validated.document_id
      && existing.version_id === validated.version_id;
    if (sameEvidence) return existing;
    if (existing && await this.isCurrentReferenceFingerprint(existing)) {
      throw new Error(`Provider integrity fingerprint is already bound to different current reference evidence: ${hash}`);
    }

    const useV2 = writesProviderV2(this.schemaWriterStage);
    if (useV2 && !hasDropboxProviderEvidence(version, hash)) {
      throw new Error(`Reference fingerprint V2 requires complete Dropbox provider evidence: ${validated.document_id}/${validated.version_id}`);
    }
    const serialized: ReferenceFingerprintRecord | ReferenceFingerprintV2Record = useV2
      ? parseReferenceFingerprintV2({
          schema_version: "2.0",
          project_id: validated.project_id,
          provider_id: DROPBOX_PROVIDER_ID,
          integrity_hash: {
            algorithm: DROPBOX_CONTENT_HASH_ALGORITHM,
            value: hash
          },
          document_id: validated.document_id,
          version_id: validated.version_id
        })
      : validated;
    const v1Path = referenceFingerprintPath(validated.project_id, hash);
    const path = useV2
      ? await referenceFingerprintV2Path(
          validated.project_id,
          DROPBOX_PROVIDER_ID,
          DROPBOX_CONTENT_HASH_ALGORITHM,
          hash
        )
      : v1Path;

    if (existing) {
      // Fingerprint indexes are reconstructible current bindings, unlike immutable document versions.
      // Same-project managed-document writes are serialized by ProjectGuard; only a binding proven stale is replaced.
      if (useV2 && await this.runtime.objects.readText(v1Path) !== null) {
        await this.runtime.objects.upsertText(v1Path, pretty(validated));
      }
      await this.runtime.objects.upsertText(path, pretty(serialized));
      return validated;
    }

    try {
      await this.runtime.objects.createText(path, pretty(serialized));
      return validated;
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const raced = await this.readReferenceFingerprint(validated.project_id, hash);
      if (!raced || raced.document_id !== validated.document_id || raced.version_id !== validated.version_id) {
        throw new Error(`Provider integrity fingerprint is already bound to different current reference evidence: ${hash}`);
      }
      return raced;
    }
  }

  private async isCurrentReferenceFingerprint(record: ReferenceFingerprintRecord): Promise<boolean> {
    const head = await this.readHead(record.project_id, record.document_id);
    if (
      !head
      || head.kind !== "reference"
      || head.reference_version_id !== record.version_id
      || !head.provider?.reference
      || head.provider.reference.content_hash !== record.provider_content_hash
    ) return false;
    const version = await this.readVersion(record.project_id, record.document_id, record.version_id);
    return version?.kind === "reference"
      && version.stage === "reference"
      && version.provider_content_hash === record.provider_content_hash;
  }

  async storeTextPayload(projectId: string, expectedSha256: string, content: string): Promise<string> {
    const actual = await sha256Text(content);
    if (actual !== expectedSha256) {
      throw new Error(`Managed document payload SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`);
    }
    const path = machineDocumentTextPayloadPath(projectId, actual);
    try {
      await this.runtime.objects.createText(path, content);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.runtime.objects.readText(path);
      if (existing !== content) throw new Error(`Immutable document payload conflict with different content: ${path}`);
    }
    return path;
  }

  async snapshotProviderFile(
    projectId: string,
    documentId: string,
    versionId: string,
    sourcePath: string,
    sourceMetadataInput: ProviderObjectMetadata | LegacyDropboxFileMetadata
  ): Promise<ProviderObjectMetadata> {
    const sourceMetadata = toProviderObjectMetadata(sourceMetadataInput);
    const sourceEvidence = requireDropboxV1Evidence(sourceMetadata);
    const path = machineDocumentProviderPayloadPath(projectId, documentId, versionId);
    try {
      const copied = await this.runtime.serverSideCopy.copyObject(sourcePath, path);
      const copiedEvidence = requireDropboxV1Evidence(copied);
      if (
        copiedEvidence.content_hash !== sourceEvidence.content_hash
        || copiedEvidence.size !== sourceEvidence.size
      ) {
        throw new Error(`Immutable provider document payload conflict with different content: ${path}`);
      }
      return copied;
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.runtime.objects.getMetadata(path);
      if (existing) {
        const existingEvidence = requireDropboxV1Evidence(existing);
        if (
          existingEvidence.content_hash === sourceEvidence.content_hash
          && existingEvidence.size === sourceEvidence.size
        ) {
          return existing;
        }
      }
      throw new Error(`Immutable provider document payload conflict with different content: ${path}`);
    }
  }

  async restoreHeadFromVersions(projectId: string, documentId: string): Promise<CurrentManagedDocumentHead | null> {
    if (!/^DOC-[A-F0-9]{24}$/.test(documentId)) throw new Error(`Unsafe document id: ${documentId}`);
    const versionRoot = `${machineDocumentRoot(projectId)}/versions/${documentId}`;
    const entries = await this.runtime.objects.listChildren(versionRoot);
    const records = new Map<string, CurrentDocumentVersionRecord>();

    for (const entry of entries) {
      if (entry.kind !== "file") continue;
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

    const meaningful = causal.filter((record) => record.stage !== "recovered_external");
    if (meaningful.length === 0) return null;
    const meaningfulIds = new Set(meaningful.map((record) => record.version_id));
    const consumedParents = new Set(
      meaningful
        .map((record) => record.parent_version_id)
        .filter((value): value is string => !!value && meaningfulIds.has(value))
    );
    const tips = meaningful.filter((record) => !consumedParents.has(record.version_id));
    if (tips.length !== 1) {
      throw new Error(`Managed document version history has ${tips.length} active causal tips for ${documentId}`);
    }
    const tip = tips[0];

    let head: CurrentManagedDocumentHead;
    if (kind === "reference") {
      if (tip.stage !== "reference") {
        throw new Error(`Managed reference history has non-reference active tip ${tip.version_id}`);
      }
      const provider = await providerObservationForVersion(this.runtime.objects, tip);
      head = {
        schema_version: "1.0",
        project_id: projectId,
        document_id: documentId,
        kind,
        logical_path: tip.logical_path,
        ...(referenceCollectionFromVersion(tip) ? { collection_path: referenceCollectionFromVersion(tip) } : {}),
        reference_version_id: tip.version_id,
        ...(provider ? { provider: { reference: provider } } : {}),
        reconciliation_status: "clean"
      };
    } else {
      if (tip.stage !== "working" && tip.stage !== "review" && tip.stage !== "published") {
        throw new Error(`Managed work-product history has unsupported active tip ${tip.version_id}`);
      }
      const publishedAncestor = tip.stage === "published"
        ? tip
        : nearestAncestorAtStage(tip, records, "published");
      const provider: Record<string, CurrentManagedProviderObservation> = {};
      const publishedProvider = publishedAncestor
        ? await providerObservationForVersion(this.runtime.objects, publishedAncestor)
        : undefined;
      if (publishedProvider) provider.published = publishedProvider;
      const tipProvider = await providerObservationForVersion(this.runtime.objects, tip);
      if (tipProvider && tip.stage === "working") provider.working = tipProvider;
      if (tipProvider && tip.stage === "review") provider.review = tipProvider;
      if (tipProvider && tip.stage === "published") provider.published = tipProvider;

      head = {
        schema_version: "1.0",
        project_id: projectId,
        document_id: documentId,
        kind,
        logical_path: tip.logical_path,
        ...(tip.stage === "working" ? { working_version_id: tip.version_id } : {}),
        ...(tip.stage === "review" ? { review_version_id: tip.version_id } : {}),
        ...(publishedAncestor ? { published_version_id: publishedAncestor.version_id } : {}),
        ...(Object.keys(provider).length > 0 ? { provider } : {}),
        reconciliation_status: "clean"
      };
    }

    await this.writeHead(head);
    return head;
  }
}

function referenceFingerprintPath(projectId: string, providerContentHash: string): string {
  return `${machineDocumentRoot(projectId)}/reference-fingerprints/${assertProviderContentHash(providerContentHash)}.json`;
}

async function providerFileBindingPath(projectId: string, providerFileId: string): Promise<string> {
  const key = await documentIdForProviderFile(projectId, providerFileId);
  return `${machineDocumentRoot(projectId)}/provider-file-bindings/${key}.json`;
}

export async function providerFileBindingV2Path(
  projectId: string,
  providerId: string,
  objectId: string
): Promise<string> {
  const key = await sha256Text(`${assertIndexPart(providerId, "provider_id")}\n${assertIndexPart(objectId, "object_id")}`);
  return `${machineDocumentRoot(projectId)}/provider-file-bindings/v2/${key}.json`;
}

export async function referenceFingerprintV2Path(
  projectId: string,
  providerId: string,
  algorithm: string,
  value: string
): Promise<string> {
  const key = await sha256Text(
    `${assertIndexPart(providerId, "provider_id")}\n${assertIndexPart(algorithm, "integrity_hash.algorithm")}\n${assertIndexPart(value, "integrity_hash.value")}`
  );
  return `${machineDocumentRoot(projectId)}/reference-fingerprints/v2/${key}.json`;
}

function parseBoundProviderFileBindingV1(
  input: unknown,
  projectId: string,
  providerFileId: string
): ProviderFileBindingRecord {
  const parsed = parseProviderFileBindingV1(input);
  if (parsed.project_id !== projectId || parsed.provider_file_id !== providerFileId) {
    throw new Error(`Invalid provider-file document binding for ${projectId}/${providerFileId}`);
  }
  return parsed;
}

function parseBoundProviderFileBindingV2(
  input: unknown,
  projectId: string,
  providerFileId: string
): ProviderFileBindingV2Record {
  const parsed = parseProviderFileBindingV2(input);
  if (
    parsed.project_id !== projectId
    || parsed.provider_id !== DROPBOX_PROVIDER_ID
    || parsed.object_id !== providerFileId
  ) {
    throw new Error(`Invalid provider-qualified document binding for ${projectId}/${providerFileId}`);
  }
  return parsed;
}

function normalizeProviderFileBindingV2(record: ProviderFileBindingV2Record): ProviderFileBindingRecord {
  return {
    schema_version: "1.0",
    project_id: record.project_id,
    provider_file_id: record.object_id,
    document_id: record.document_id
  };
}

function parseBoundReferenceFingerprintV1(
  input: unknown,
  projectId: string,
  providerContentHash: string
): ReferenceFingerprintRecord {
  const parsed = parseReferenceFingerprintV1(input);
  if (parsed.project_id !== projectId || parsed.provider_content_hash !== providerContentHash) {
    throw new Error(`Invalid reference fingerprint record for ${projectId}/${providerContentHash}`);
  }
  return parsed;
}

function parseBoundReferenceFingerprintV2(
  input: unknown,
  projectId: string,
  providerContentHash: string
): ReferenceFingerprintV2Record {
  const parsed = parseReferenceFingerprintV2(input);
  if (
    parsed.project_id !== projectId
    || parsed.provider_id !== DROPBOX_PROVIDER_ID
    || parsed.integrity_hash.algorithm !== DROPBOX_CONTENT_HASH_ALGORITHM
    || parsed.integrity_hash.value !== providerContentHash
  ) {
    throw new Error(`Invalid provider-qualified reference fingerprint for ${projectId}/${providerContentHash}`);
  }
  return parsed;
}

function normalizeReferenceFingerprintV2(record: ReferenceFingerprintV2Record): ReferenceFingerprintRecord {
  return {
    schema_version: "1.0",
    project_id: record.project_id,
    provider_content_hash: record.integrity_hash.value,
    document_id: record.document_id,
    version_id: record.version_id
  };
}

function hasDropboxProviderEvidence(record: CurrentDocumentVersionRecord, hash: string): boolean {
  const evidence = record.provider_evidence;
  return evidence?.provider_id === DROPBOX_PROVIDER_ID
    && evidence.integrity_hash.algorithm === DROPBOX_CONTENT_HASH_ALGORITHM
    && evidence.integrity_hash.value === hash;
}

function assertIndexPart(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
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
  record: CurrentDocumentVersionRecord,
  records: ReadonlyMap<string, CurrentDocumentVersionRecord>,
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

function nearestAncestorAtStage(
  record: CurrentDocumentVersionRecord,
  records: ReadonlyMap<string, CurrentDocumentVersionRecord>,
  stage: DocumentVersionRecord["stage"]
): CurrentDocumentVersionRecord | undefined {
  let current: CurrentDocumentVersionRecord | undefined = record;
  const visited = new Set<string>();
  while (current?.parent_version_id) {
    if (visited.has(current.version_id)) return undefined;
    visited.add(current.version_id);
    current = records.get(current.parent_version_id);
    if (current?.stage === stage) return current;
  }
  return undefined;
}

async function providerObservationForVersion(
  objects: ObjectPersistence,
  record: CurrentDocumentVersionRecord
): Promise<CurrentManagedProviderObservation | undefined> {
  const stored = providerObservationFromVersion(record);
  if (!stored) return undefined;
  const current = await objects.getMetadata(stored.path);
  if (current) {
    try {
      const evidence = requireDropboxV1Evidence(current);
      if (evidence.content_hash === stored.content_hash && evidence.size === stored.size) {
        return currentObservationFromLegacy(toManagedProviderObservation(current));
      }
    } catch {
      // Fall back to durable evidence when live metadata cannot be proven compatible.
    }
  }
  return stored;
}

function providerObservationFromVersion(
  record: CurrentDocumentVersionRecord
): CurrentManagedProviderObservation | undefined {
  if (record.provider_evidence) return currentObservationFromProvider(record.provider_evidence);
  if (
    !record.provider_path
    || !record.provider_file_id
    || !record.provider_rev
    || !record.provider_content_hash
    || record.size === undefined
  ) return undefined;
  return currentObservationFromProvider(upcastDropboxV1Observation({
    provider_path: record.provider_path,
    provider_file_id: record.provider_file_id,
    provider_rev: record.provider_rev,
    provider_content_hash: record.provider_content_hash,
    size: record.size
  }));
}

function currentObservationFromLegacy(value: ManagedProviderObservation): CurrentManagedProviderObservation {
  return currentObservationFromProvider(upcastDropboxV1Observation(value));
}

function currentObservationFromProvider(value: ProviderObservation): CurrentManagedProviderObservation {
  return {
    path: value.path,
    file_id: value.object_id,
    rev: value.revision_token,
    content_hash: value.integrity_hash.value,
    size: value.size,
    provider_id: value.provider_id,
    object_id: value.object_id,
    revision_token: value.revision_token,
    integrity_hash: value.integrity_hash
  };
}

function referenceCollectionFromVersion(record: CurrentDocumentVersionRecord): string | undefined {
  if (!record.provider_path) return undefined;
  const marker = "/REFERENCES/";
  const index = record.provider_path.indexOf(marker);
  if (index < 0) return undefined;
  const relative = record.provider_path.slice(index + marker.length);
  const suffix = `/${record.logical_path}`;
  if (!relative.endsWith(suffix)) return relative === record.logical_path ? "UNCLASSIFIED" : undefined;
  const collection = relative.slice(0, -suffix.length);
  return collection || "UNCLASSIFIED";
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
