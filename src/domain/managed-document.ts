export type ManagedDocumentZone = "inputs" | "references" | "working" | "review" | "deliverables";
export type ManagedDocumentKind = "reference" | "work_product";

export interface ManagedDocumentHead {
  schema_version: "1.0";
  project_id: string;
  document_id: string;
  kind: ManagedDocumentKind;
  logical_path: string;
  collection_path?: string;
  reference_version_id?: string;
  working_version_id?: string;
  review_version_id?: string;
  published_version_id?: string;
  reconciliation_status: "clean" | "conflict";
}

export interface DocumentVersionRecord {
  schema_version: "1.0";
  project_id: string;
  document_id: string;
  version_id: string;
  parent_version_id?: string;
  kind: ManagedDocumentKind;
  stage: "reference" | "working" | "review" | "published" | "recovered_external";
  logical_path: string;
  source: "project_os" | "external_human" | "input_ingest" | "legacy_artifact_api";
  created_at: string;
  immutable_payload_path: string;
  content_sha256?: string;
  provider_content_hash?: string;
  provider_file_id?: string;
  provider_rev?: string;
  size?: number;
  media_type?: string;
  request_id?: string;
}

export function parseManagedDocumentHead(_input: unknown): ManagedDocumentHead {
  throw new Error("not implemented");
}

export function parseDocumentVersionRecord(_input: unknown): DocumentVersionRecord {
  throw new Error("not implemented");
}

export async function documentIdFor(_projectId: string, _logicalPath: string): Promise<string> {
  throw new Error("not implemented");
}

export async function externalVersionIdFor(_providerRev: string): Promise<string> {
  throw new Error("not implemented");
}

export function assertManagedRelativePath(_value: string): string {
  throw new Error("not implemented");
}

export function assertReferenceCollectionPath(_value: string): string {
  throw new Error("not implemented");
}
