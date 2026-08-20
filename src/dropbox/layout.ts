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

export function workspaceProjectRoot(projectId: string, slug: string): string {
  return `${WORKSPACE_ROOT}/PROJECTS/${assertSafeProjectId(projectId)}-${assertSafeSlug(slug)}`;
}

export function workspaceProjectFile(
  projectId: string,
  slug: string,
  filename: "PROJECT.md" | "STATE.md" | "PLAN.md" | "HANDOFF.md"
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

export function machineTransactionPath(status: MachineTransactionStatus, transactionId: string): string {
  return `${MACHINE_ROOT}/transactions/${status}/${assertSafeTransactionId(transactionId)}.json`;
}

export function machineReceiptPath(transactionId: string): string {
  return `${MACHINE_ROOT}/receipts/${assertSafeTransactionId(transactionId)}.json`;
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
  workspaceProjectFile,
  workspaceEntityPath,
  workspacePortfolioRoot,
  machineProjectRoot,
  machineStatePath,
  machineManifestPath,
  machineEventPath,
  machineTransactionPath,
  machineReceiptPath,
  machineRegistryJsonPath,
  machineRegistryMarkdownPath
} as const;
