import { assertManagedRelativePath, type ManagedDocumentZone } from "../domain/managed-document";
import {
  PROJECT_OS_ROOT,
  assertSafeEventId,
  assertSafeProjectId,
  assertSafeSlug,
  assertSafeStableId,
  assertSafeTransactionId,
  decisionPath,
  eventPath,
  manifestPath,
  projectFile,
  projectRoot,
  receiptPath,
  registryJsonPath,
  registryMarkdownPath,
  transactionPath
} from "./paths";

export type LayoutMode = "legacy" | "shadow" | "v2";

export function parseLayoutMode(value?: string): LayoutMode {
  if (value === undefined || value === "") return "legacy";
  if (value === "legacy" || value === "shadow" || value === "v2") return value;
  throw new Error(`Invalid PROJECT_OS_LAYOUT_MODE: ${value}`);
}

export const WORKSPACE_ROOT = `${PROJECT_OS_ROOT}/WORKSPACE`;
export const ARCHIVE_ROOT = `${PROJECT_OS_ROOT}/ARCHIVE`;
export const MACHINE_ROOT = `${PROJECT_OS_ROOT}/.project-os`;

export type WorkspaceEntityFolder =
  | "DECISIONS"
  | "CONSTRAINTS"
  | "TASKS"
  | "RESEARCH"
  | "REFERENCES"
  | "DELIVERABLES"
  | "SPECS"
  | "MEETINGS";

export type MachineTransactionStatus = "incoming" | "committed" | "rejected" | "conflicts";
export type MachineArtifactStatus = "incoming" | "committed" | "rejected" | "conflicts";

const MANAGED_ZONE_FOLDERS: Record<ManagedDocumentZone, string> = {
  inputs: "INPUTS",
  references: "REFERENCES",
  working: "WORKING",
  review: "REVIEW",
  deliverables: "DELIVERABLES"
};

export function workspaceProjectRoot(projectId: string, slug: string): string {
  return `${WORKSPACE_ROOT}/PROJECTS/${assertSafeProjectId(projectId)}-${assertSafeSlug(slug)}`;
}

export function archiveProjectRoot(projectId: string, slug: string): string {
  return `${ARCHIVE_ROOT}/PROJECTS/${assertSafeProjectId(projectId)}-${assertSafeSlug(slug)}`;
}

export function workspaceArtifactPath(projectId: string, slug: string, relativePath: string): string {
  const normalized = assertSafeArtifactRelativePath(relativePath);
  return `${workspaceProjectRoot(projectId, slug)}/ARTIFACTS/${normalized}`;
}

export function workspaceManagedZoneRoot(projectId: string, slug: string, zone: ManagedDocumentZone): string {
  const folder = MANAGED_ZONE_FOLDERS[zone];
  if (!folder) throw new Error(`Unsupported managed document zone: ${String(zone)}`);
  return `${workspaceProjectRoot(projectId, slug)}/${folder}`;
}

export function workspaceManagedDocumentPath(
  projectId: string,
  slug: string,
  zone: ManagedDocumentZone,
  relativePath: string
): string {
  return `${workspaceManagedZoneRoot(projectId, slug, zone)}/${assertManagedRelativePath(relativePath)}`;
}

export function workspaceProjectFile(
  projectId: string,
  slug: string,
  filename:
    | "PROJECT.md"
    | "STATE.md"
    | "PLAN.md"
    | "HANDOFF.md"
    | "BRIEF.md"
    | "DISCOVERY.md"
    | "ROADMAP.md"
): string {
  return `${workspaceProjectRoot(projectId, slug)}/${filename}`;
}

export function workspaceEntityPath(
  projectId: string,
  slug: string,
  folder: WorkspaceEntityFolder,
  entityId: string
): string {
  return `${workspaceProjectRoot(projectId, slug)}/${folder}/${assertSafeStableId(entityId)}.md`;
}

export function workspacePortfolioRoot(): string {
  return `${WORKSPACE_ROOT}/PORTFOLIO`;
}

export function workspacePortfolioDashboardPath(): string {
  return `${workspacePortfolioRoot()}/DASHBOARD.md`;
}

export function machineProjectRoot(projectId: string): string {
  return `${MACHINE_ROOT}/projects/${assertSafeProjectId(projectId)}`;
}

export function machineStatePath(projectId: string): string {
  return `${machineProjectRoot(projectId)}/state.json`;
}

export function machineManifestPath(projectId: string): string {
  return `${machineProjectRoot(projectId)}/manifest.json`;
}

export function machineEventPath(projectId: string, eventId: string): string {
  return `${machineProjectRoot(projectId)}/events/${assertSafeEventId(eventId)}.json`;
}

export function machineCommitRecordPath(projectId: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`Invalid commit record revision: ${revision}`);
  }
  return `${machineProjectRoot(projectId)}/commits/REV-${revision.toString().padStart(6, "0")}.json`;
}

export function machineMaterializationRoot(projectId: string): string {
  return `${machineProjectRoot(projectId)}/materializations`;
}

export function machineMaterializationRecordPath(
  projectId: string,
  targetRevision: number,
  projectionVersion: number
): string {
  if (!Number.isSafeInteger(targetRevision) || targetRevision < 0) {
    throw new Error(`Invalid materialization revision: ${targetRevision}`);
  }
  if (!Number.isSafeInteger(projectionVersion) || projectionVersion < 1) {
    throw new Error(`Invalid projection version: ${projectionVersion}`);
  }
  return `${machineMaterializationRoot(projectId)}/REV-${targetRevision.toString().padStart(6, "0")}-PV-${projectionVersion.toString().padStart(4, "0")}.json`;
}

export function machineMaterializationHeadPath(projectId: string): string {
  return `${machineProjectRoot(projectId)}/materialization-head.json`;
}

export function machineDocumentRoot(projectId: string): string {
  return `${machineProjectRoot(projectId)}/documents`;
}

export function machineDocumentHeadPath(projectId: string, documentId: string): string {
  return `${machineDocumentRoot(projectId)}/heads/${assertSafeDocumentId(documentId)}.json`;
}

export function machineDocumentVersionPath(projectId: string, documentId: string, versionId: string): string {
  return `${machineDocumentRoot(projectId)}/versions/${assertSafeDocumentId(documentId)}/${assertSafeDocumentVersionId(versionId)}.json`;
}

export function machineDocumentTextPayloadPath(projectId: string, sha256: string): string {
  return `${machineDocumentRoot(projectId)}/payloads/sha256/${assertSafeSha256(sha256)}`;
}

export function machineDocumentProviderPayloadPath(projectId: string, documentId: string, versionId: string): string {
  return `${machineDocumentRoot(projectId)}/payloads/provider/${assertSafeDocumentId(documentId)}/${assertSafeDocumentVersionId(versionId)}/payload`;
}

export function machineTransactionPath(status: MachineTransactionStatus, transactionId: string): string {
  return `${MACHINE_ROOT}/transactions/${status}/${assertSafeTransactionId(transactionId)}.json`;
}

export function machineReceiptPath(transactionId: string): string {
  return `${MACHINE_ROOT}/receipts/${assertSafeTransactionId(transactionId)}.json`;
}

export function machineArtifactRequestPath(status: MachineArtifactStatus, requestId: string): string {
  return `${MACHINE_ROOT}/artifacts/${status}/${assertSafeArtifactRequestId(requestId)}.json`;
}

export function machineArtifactReceiptPath(requestId: string): string {
  return `${MACHINE_ROOT}/artifacts/receipts/${assertSafeArtifactRequestId(requestId)}.json`;
}

export function machineRegistryJsonPath(): string {
  return `${MACHINE_ROOT}/registry/PROJECT_REGISTRY.json`;
}

export function machineRegistryMarkdownPath(): string {
  return `${MACHINE_ROOT}/registry/PROJECT_INDEX.md`;
}

export const legacyPaths = {
  projectRoot,
  projectFile,
  manifestPath,
  eventPath,
  decisionPath,
  transactionPath,
  receiptPath,
  registryJsonPath,
  registryMarkdownPath
} as const;

export const v2Paths = {
  workspaceProjectRoot,
  archiveProjectRoot,
  workspaceArtifactPath,
  workspaceManagedZoneRoot,
  workspaceManagedDocumentPath,
  workspaceProjectFile,
  workspaceEntityPath,
  workspacePortfolioRoot,
  workspacePortfolioDashboardPath,
  machineProjectRoot,
  machineStatePath,
  machineManifestPath,
  machineEventPath,
  machineCommitRecordPath,
  machineMaterializationRoot,
  machineMaterializationRecordPath,
  machineMaterializationHeadPath,
  machineDocumentRoot,
  machineDocumentHeadPath,
  machineDocumentVersionPath,
  machineDocumentTextPayloadPath,
  machineDocumentProviderPayloadPath,
  machineTransactionPath,
  machineReceiptPath,
  machineArtifactRequestPath,
  machineArtifactReceiptPath,
  machineRegistryJsonPath,
  machineRegistryMarkdownPath
} as const;

function assertSafeArtifactRelativePath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("//")) {
    throw new Error(`Unsafe artifact relative path: ${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe artifact relative path: ${value}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) {
    throw new Error(`Unsafe artifact relative path: ${value}`);
  }
  return value;
}

function assertSafeArtifactRequestId(value: string): string {
  if (!/^ART-[A-Z0-9-]{10,}$/.test(value)) {
    throw new Error(`Unsafe artifact request id: ${value}`);
  }
  return value;
}

function assertSafeDocumentId(value: string): string {
  if (!/^DOC-[A-F0-9]{24}$/.test(value)) throw new Error(`Unsafe document id: ${value}`);
  return value;
}

function assertSafeDocumentVersionId(value: string): string {
  if (!/^VER-(?:EXT|REQ)-[A-F0-9]{24}$/.test(value)) throw new Error(`Unsafe document version id: ${value}`);
  return value;
}

function assertSafeSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Unsafe SHA-256: ${value}`);
  return value;
}
