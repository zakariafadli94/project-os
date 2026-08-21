import { expect, it } from "vitest";
import { renderRegistry } from "../src/render/registry";

it("renders portfolio links through the PROJECTS namespace", () => {
  const markdown = renderRegistry([{
    project_id: "PRJ-0002",
    name: "Project OS",
    slug: "project-os",
    aliases: ["os"],
    status: "active",
    created_at: "2026-08-21T00:00:00+01:00",
    updated_at: "2026-08-21T00:00:00+01:00"
  }]);

  expect(markdown).toContain("[[PROJECTS/PRJ-0002-project-os/PROJECT|Project OS]]");
  expect(markdown).not.toContain("[[PRJ-0002-project-os/PROJECT|");
});
