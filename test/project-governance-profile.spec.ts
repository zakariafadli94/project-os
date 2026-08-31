import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { renderProject } from "../src/render/project";
import { renderRegistry, type RegistryEntry } from "../src/render/registry";

const at = "2026-08-30T08:00:00+01:00";

function registryEntry(project_id: string, name: string, slug: string): RegistryEntry {
  return { project_id, name, slug, aliases: [], status: "active", created_at: at, updated_at: at };
}

describe("project governance human visibility", () => {
  it("renders a legacy project as unknown without mutating business state", () => {
    const state = emptyProjectState("PRJ-9001", "Legacy", "legacy", "Keep history intact");
    const before = structuredClone(state);
    const rendered = (renderProject as any)(state, { project_kind: "unknown_legacy" });

    expect(rendered).toContain("Project kind: unknown_legacy");
    expect(rendered).not.toContain("Synthetic project — fictitious / non-business");
    expect(state).toEqual(before);
  });

  it("renders synthetic projects with an unambiguous fictitious non-business warning", () => {
    const state = emptyProjectState("PRJ-9002", "Probe", "probe", "Synthetic validation");
    const rendered = (renderProject as any)(state, { project_kind: "synthetic_probe" });

    expect(rendered).toContain("Synthetic project — fictitious / non-business");
    expect(rendered).toContain("Project kind: synthetic_probe");
  });

  it("marks synthetic projects in the human registry without changing registry JSON entries", () => {
    const entries = [
      registryEntry("PRJ-9001", "Real", "real"),
      registryEntry("PRJ-9002", "Probe", "probe")
    ];
    const before = structuredClone(entries);
    const kinds = new Map([
      ["PRJ-9001", "real"],
      ["PRJ-9002", "synthetic_probe"]
    ]);
    const rendered = (renderRegistry as any)(entries, kinds);

    expect(rendered).toContain("PRJ-9002** [synthetic]");
    expect(rendered).not.toContain("PRJ-9001** [synthetic]");
    expect(entries).toEqual(before);
  });
});
