export interface ProviderIntegrityHash {
  algorithm: string;
  value: string;
}

export interface ProviderObjectMetadata {
  path: string;
  size: number;
  modifiedAt?: string;
  objectId?: string;
  revisionToken?: string;
  integrityHash?: ProviderIntegrityHash;
}

export interface ProviderEntry {
  kind: "file" | "folder" | "deleted";
  name: string;
  path?: string;
}

export interface ProviderChangeEntry {
  kind: "file" | "folder" | "deleted";
  name: string;
  path: string;
  metadata?: ProviderObjectMetadata;
}

export interface ProviderChangePage {
  entries: ProviderChangeEntry[];
  cursor: string;
}

export interface ProviderRequestScope {
  deadlineMs: number;
  signal: AbortSignal;
  beforeHttp(): void;
}

export interface ProviderListPage {
  entries: ProviderEntry[];
  cursor: string | null;
}

export interface PagedListingPort {
  listPage(input: { path: string; cursor: string | null; limit: number }): Promise<ProviderListPage>;
}

export interface ObjectPersistence {
  readBytes?(path: string, maxBytes: number): Promise<Uint8Array | null>;
  readText(path: string): Promise<string | null>;
  createText(path: string, content: string): Promise<void>;
  upsertText(path: string, content: string): Promise<void>;
  getMetadata(path: string): Promise<ProviderObjectMetadata | null>;
  listChildren(path: string): Promise<ProviderEntry[]>;
  move(from: string, to: string): Promise<void>;
  delete(path: string): Promise<void>;
  deleteIfUnchanged?(
    path: string,
    expected: { objectId: string; revisionToken: string }
  ): Promise<"deleted" | "missing" | "changed">;
}

export interface ConditionalWritePort {
  writeTextConditional(path: string, content: string, expectedRevisionToken: string): Promise<ProviderObjectMetadata>;
}

export interface ServerSideCopyPort {
  copyObject(from: string, to: string): Promise<ProviderObjectMetadata>;
}

export interface IncrementalChangeFeedPort {
  listChanges(input: { root?: string; cursor?: string }): Promise<ProviderChangePage>;
}

export interface DirectoryProvisioningPort {
  ensureDirectory(path: string): Promise<void>;
}
