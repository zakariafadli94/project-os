import { describe, expect, it } from "vitest";
import workflow from "../.github/workflows/deploy-control-tower.yml?raw";
import checker from "../scripts/check-control-tower-deployment.mjs?raw";
import config from "../wrangler.control-tower.jsonc?raw";
import deployment from "../docs/deployment.md?raw";
import continuity from "../docs/continuity.md?raw";

describe("Control Tower deployment policy", () => {
  it("requires a manual exact-SHA deployment after the complete repository gate", async () => {
    expect(workflow).toMatch(/^\s*workflow_dispatch:\s*$/m);
    expect(workflow).not.toMatch(/^\s*push:\s*$/m);
    expect(workflow).toContain("expected_sha");
    expect(workflow).toContain("refs/heads/main");
    expect(workflow).toContain("npm run check");
    expect(workflow).toContain("wrangler.control-tower.jsonc");
    expect(workflow).toContain('git-${GITHUB_SHA}');
  });

  it("keeps Project OS credentials outside the Control Tower boundary", async () => {
    const combined = `${workflow}\n${config}`;

    expect(combined).not.toMatch(/INGRESS_TOKEN|MUTATION_CONTEXT_SIGNING_KEY|DROPBOX_/);
    expect(workflow).toContain("GITHUB_CLIENT_ID");
    expect(workflow).toContain("GITHUB_CLIENT_SECRET");
    expect(workflow).toContain("OAUTH_COOKIE_ENCRYPTION_KEY");
  });

  it("qualifies only synthetic PRJ-0008 and proves OAuth denial plus authenticated tools", async () => {
    expect(checker).toContain("PRJ-0008");
    expect(checker).not.toContain("PRJ-0003");
    expect(checker).toMatch(/unauthenticated/i);
    expect(checker).toMatch(/tools\/list/);
    expect(checker).toMatch(/authorization/i);
  });

  it("documents a route-only rollback that preserves the canonical guard and inbox", async () => {
    expect(deployment).toContain("project-os-control-tower.zakaria-fadli-94.workers.dev/mcp");
    expect(deployment).toMatch(/rollback/i);
    expect(deployment).toMatch(/project-os-guard/);
    expect(deployment).toMatch(/inbox/i);
    expect(continuity).toMatch(/Control Tower/);
  });
});
