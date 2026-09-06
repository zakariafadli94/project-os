/// <reference types="vite/client" />
import workflowText from "../.github/workflows/recover-inputs.yml?raw";
import { describe, expect, it } from "vitest";

function workflowSource(): string {
  return workflowText;
}

describe("recover-inputs GitHub Actions workflow", () => {
  it("requires a guarded manual dispatch from main with exact project IDs", () => {
    const source = workflowSource();
    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("project_id:");
    expect(source).toContain("confirm_recovery:");
    expect(source).toContain('if [ "$GITHUB_REF" != "refs/heads/main" ]');
    expect(source).toContain('if [ "$CONFIRM_RECOVERY" != "RECOVER" ]');
    expect(source).toMatch(/\^PRJ-\[0-9\]\{4\}\$/);
    expect(source).not.toMatch(/\{4,\}/);
  });

  it("uses only the existing ingress secret and never sends it to stdout", () => {
    const source = workflowSource();
    expect(source).toContain("INGRESS_TOKEN: ${{ secrets.INGRESS_TOKEN }}");
    expect(source).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(source).not.toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(source).not.toContain("::add-mask::");
    expect(source).not.toMatch(/echo[^\n]*INGRESS_TOKEN/i);
    expect(source).not.toMatch(/printf[^\n]*INGRESS_TOKEN/i);
  });

  it("sends one strict project payload through fail-closed bounded curl", () => {
    const source = workflowSource();
    expect(source).toContain("/v1/admin/recover-inputs");
    expect(source).toContain('JSON.stringify({ project_ids: [projectId] })');
    expect(source).toContain("--fail-with-body");
    expect(source).toContain("--connect-timeout 5");
    expect(source).toContain("--max-time 30");
    expect(source).toContain("--retry 0");
    expect(source).not.toMatch(/--request\s+(PUT|PATCH|DELETE)\b/i);
  });

  it("validates the sanitized summary invariant and checks remaining INPUTS read-only", () => {
    const source = workflowSource();
    expect(source).toContain("Sanitized recovery summary:");
    expect(source).toContain("safe.scanned !== safe.completed + safe.duplicate_cleaned + safe.conflicts + safe.withdrawn + safe.failed");
    expect(source).toContain("/v1/admin/input-recovery-status?project_id=");
    expect(source).toContain("--request GET");
    expect(source).toContain("body?.remaining !== 0");
    expect(source).not.toContain("/v1/admin/schema-status");
  });

  it("requests no GitHub token permissions and serializes recovery", () => {
    const source = workflowSource();
    expect(source).toContain("permissions: {}");
    expect(source).toContain("group: project-os-input-recovery");
    expect(source).toContain("cancel-in-progress: false");
    expect(source.toLowerCase()).not.toContain("dropbox");
  });
});
