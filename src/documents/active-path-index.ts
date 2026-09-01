import { assertManagedRelativePath } from "../domain/managed-document";
import { asProjectOsPersistence, type PersistenceInput } from "../persistence/compatibility/legacy-dropbox-runtime";
import { machineDocumentRoot } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { ProviderConflictError } from "../persistence/provider/errors";
import { sha256Text } from "./hash";

export interface ManagedDocumentActivePathBinding {
  schema_version: "1.0";
  project_id: string;
  logical_path: string;
  document_id: string;
}

export class ManagedDocumentActivePathIndex {
  private readonly runtime: ProjectOsPersistenceRuntime;

  constructor(input: PersistenceInput) {
    this.runtime = asProjectOsPersistence(input);
  }

  async read(projectId: string, logicalPath: string): Promise<ManagedDocumentActivePathBinding | null> {
    const path = await bindingPath(projectId, logicalPath);
    const raw = await this.runtime.objects.readText(path);
    if (raw === null) return null;
    return parseBinding(JSON.parse(raw), projectId, logicalPath);
  }

  async bind(projectId: string, logicalPath: string, documentId: string): Promise<void> {
    const normalized = assertManagedRelativePath(logicalPath);
    assertDocumentId(documentId);
    const path = await bindingPath(projectId, normalized);
    const record: ManagedDocumentActivePathBinding = {
      schema_version: "1.0",
      project_id: projectId,
      logical_path: normalized,
      document_id: documentId
    };
    const content = `${JSON.stringify(record, null, 2)}\n`;
    const existing = await this.read(projectId, normalized);
    if (existing) {
      if (existing.document_id !== documentId) {
        throw new Error(`Managed document active path is already bound to ${existing.document_id}: ${normalized}`);
      }
      return;
    }
    try {
      await this.runtime.objects.createText(path, content);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const raced = await this.read(projectId, normalized);
      if (!raced || raced.document_id !== documentId) {
        throw new Error(`Managed document active path binding conflict: ${normalized}`);
      }
    }
  }

  async unbind(projectId: string, logicalPath: string, documentId: string): Promise<void> {
    const normalized = assertManagedRelativePath(logicalPath);
    const current = await this.read(projectId, normalized);
    if (!current) return;
    if (current.document_id !== documentId) {
      throw new Error(`Managed document active path binding belongs to another document: ${normalized}`);
    }
    await this.runtime.objects.delete(await bindingPath(projectId, normalized));
  }
}

async function bindingPath(projectId: string, logicalPath: string): Promise<string> {
  const normalized = assertManagedRelativePath(logicalPath);
  const hash = await sha256Text(normalized);
  return `${machineDocumentRoot(projectId)}/bindings/active-path/${hash}.json`;
}

function parseBinding(input: unknown, projectId: string, logicalPath: string): ManagedDocumentActivePathBinding {
  if (!input || typeof input !== "object") throw new Error("Invalid managed document active-path binding");
  const record = input as Record<string, unknown>;
  const normalized = assertManagedRelativePath(logicalPath);
  if (
    record.schema_version !== "1.0"
    || record.project_id !== projectId
    || record.logical_path !== normalized
    || typeof record.document_id !== "string"
  ) {
    throw new Error(`Managed document active-path binding mismatch: ${normalized}`);
  }
  assertDocumentId(record.document_id);
  return record as unknown as ManagedDocumentActivePathBinding;
}

function assertDocumentId(value: string): void {
  if (!/^DOC-[A-F0-9]{24}$/.test(value)) throw new Error(`Invalid managed document id: ${value}`);
}
