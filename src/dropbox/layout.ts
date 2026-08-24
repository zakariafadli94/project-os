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
  workspaceProjectFile,
  workspaceEntityPath,
  workspacePortfolioRoot,
  workspacePortfolioDashboardPath,
  machineProjectRoot,
  machineStatePath,
  machineManifestPath,
  machineEventPath,
  machineCommitRecordPath,
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
