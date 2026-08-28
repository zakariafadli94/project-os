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

export interface ObjectPersistence {
  readText(path: string): Promise<string | null>;
  createText(path: string, content: string): Promise<void>;
  upsertText(path: string, content: string): Promise<void>;
  getMetadata(path: string): Promise<ProviderObjectMetadata | null>;
  listChildren(path: string): Promise<ProviderEntry[]>;
  move(from: string, to: string): Promise<void>;
  delete(path: string): Promise<void>;
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
