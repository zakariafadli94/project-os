import { MANAGED_NOTICE } from "./shared";

export interface RegistryEntry {
  project_id: string;
  name: string;
  slug: string;
  aliases: string[];
  status: "active" | "paused" | "completed" | "archived";
  created_at: string;
  updated_at: string;
}

export function renderRegistry(entries: RegistryEntry[]): string {
  const groups: RegistryEntry["status"][] = ["active", "paused", "completed", "archived"];
  const sections = groups.map((status) => {
    const items = entries
      .filter((entry) => entry.status === status)
      .sort((a, b) => a.project_id.localeCompare(b.project_id))
      .map((entry) => `- **${entry.project_id}** — [[PROJECTS/${entry.project_id}-${entry.slug}/PROJECT|${entry.name}]]`)
      .join("\n") || "- None";
    return `## ${status[0].toUpperCase()}${status.slice(1)}\n\n${items}`;
  }).join("\n\n");

  return `${MANAGED_NOTICE}\n# Project Index\n\n${sections}\n`;
}
