import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function repoFile(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("INDEX001 deployment remediation gates", () => {
  it("requires production deployment to be explicit manual workflow_dispatch only", async () => {
    const workflow = await repoFile(".github/workflows/deploy.yml");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s*push:\s*$/m);
    expect(workflow).toContain("confirm_production");
    expect(workflow).toContain("expected_sha");
    expect(workflow).toContain("refs/heads/main");
  });

  it("keeps production search read mode off and prepares bounded Workers observability", async () => {
    const config = await repoFile("wrangler.jsonc");
    expect(config).toContain('"PROJECT_OS_SEARCH_READ_MODE": "off"');
    expect(config).toContain('"observability"');
    expect(config).toContain('"enabled": true');
    expect(config).toMatch(/"head_sampling_rate"\s*:\s*0\.1/);
  });
});
