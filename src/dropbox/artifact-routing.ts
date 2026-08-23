import type { ArtifactRouteRecord, ProjectState } from "../domain/project-state";
import { workspaceArtifactPath, workspaceProjectRoot } from "./layout";

const ALLOWED_ROOTS = new Set(["DELIVERABLES", "ARCHIVES", "RESEARCH", "REFERENCES", "SPECS", "MEETINGS", "ARTIFACTS"]);

export class ArtifactGovernanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactGovernanceConflictError";
  }
}

export interface ResolvedArtifactDestination {
  path: string;
  route?: ArtifactRouteRecord;
  archive_path?: string;
}

export function resolveArtifactDestination(state: ProjectState, relativePath: string): ResolvedArtifactDestination {
  const relative = safeRelative(relativePath, "artifact relative path");
  const routes = Object.values(state.artifact_routes ?? {}).sort((a, b) => b.source_prefix.length - a.source_prefix.length);

  for (const route of routes) {
    if (!route.exclusive) continue;
    const physicalArtifactPrefix = `ARTIFACTS/${route.source_prefix}`;
    if (hasPrefix(relative, physicalArtifactPrefix) || hasPrefix(relative, route.target_prefix)) {
      throw new ArtifactGovernanceConflictError(
        `Artifact request bypasses governed route ${route.route_id}; use logical prefix ${route.source_prefix}`
      );
    }
  }

  const route = routes.find((candidate) => hasPrefix(relative, candidate.source_prefix));
  if (!route) {
    return { path: workspaceArtifactPath(state.project_id, state.slug, relative) };
  }

  for (const decisionId of route.decision_ids) {
    const decision = state.decisions[decisionId];
    if (!decision || decision.status !== "accepted") {
      throw new ArtifactGovernanceConflictError(
        `Artifact route ${route.route_id} is not governed by an active accepted decision: ${decisionId}`
      );
    }
  }

  const targetPrefix = safeWorkspacePrefix(route.target_prefix, "target_prefix");
  const suffix = relative === route.source_prefix ? "" : relative.slice(route.source_prefix.length + 1);
  const targetRelative = suffix ? `${targetPrefix}/${suffix}` : targetPrefix;
  const root = workspaceProjectRoot(state.project_id, state.slug);
  const result: ResolvedArtifactDestination = { path: `${root}/${targetRelative}`, route };

  if (route.archive_prefix) {
    const archivePrefix = safeWorkspacePrefix(route.archive_prefix, "archive_prefix");
    result.archive_path = `${root}/${suffix ? `${archivePrefix}/${suffix}` : archivePrefix}`;
  }
  return result;
}

function hasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function safeWorkspacePrefix(value: string, name: string): string {
  const safe = safeRelative(value, name);
  const root = safe.split("/")[0] ?? "";
  if (!ALLOWED_ROOTS.has(root)) throw new ArtifactGovernanceConflictError(`${name} uses forbidden workspace root ${root}`);
  return safe;
}

function safeRelative(value: string, name: string): string {
  if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("//")) {
    throw new ArtifactGovernanceConflictError(`Unsafe ${name}: ${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ArtifactGovernanceConflictError(`Unsafe ${name}: ${value}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) {
    throw new ArtifactGovernanceConflictError(`Unsafe ${name}: ${value}`);
  }
  return value;
}
