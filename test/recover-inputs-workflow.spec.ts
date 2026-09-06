/// <reference types="vite/client" />
import workflowText from "../.github/workflows/recover-inputs.yml?raw";
import { describe, expect, it } from "vitest";

function workflowSource(): string {
  return workflowText;
}

describe("recover-inputs GitHub Actions workflow", () => {
  it("requires a guarded manual dispatch from main", () => {
    const source = workflowSource();
    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("project_id:");
    expect(source).toContain("confirm_recovery:");
    expect(source).toContain('if [ "$GITHUB_REF" != "refs/heads/main" ]');
    expect(source).toContain('if [ "$CONFIRM_RECOVERY" != "RECOVER" ]');
    expect(source).toMatch(/\^PRJ-\[0-9\]\{4,\}\$/);
  });

  it("uses only the existing ingress secret and never prints it", () => {
    const source = workflowSource();
    expect(source).toContain("INGRESS_TOKEN: ${{ secrets.INGRESS_TOKEN }}");
    expect(source).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(source).not.toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(source).toContain('echo "::add-mask::$INGRESS_TOKEN"');
    expect(source).not.toMatch(/echo .*\$INGRESS_TOKEN(?!\")/);
  });

  it("sends one strict project payload through fail-closed bounded curl", () => {
    const source = workflowSource();
    expect(source).toContain("/v1/admin/recover-inputs");
    expect(source).toContain('JSON.stringify({ project_ids: [projectId] })');
    expect(source).toContain("--fail-with-body");
    expect(source).toContain("--connect-timeout 5");
    expect(source).toContain("--max-time 30");
    expect(source).toContain("--retry 0");
  });

  it("redacts recovery output and performs a read-only post-check", () => {
    const source = workflowSource();
    expect(source).toContain("RECOVERY_RESPONSE_FILE");
    expect(source).toContain("Sanitized recovery response:");
    expect(source).toContain("/v1/admin/schema-status?project_id=");
    expect(source).toContain("--request GET");
    expect(source).toContain("Post-recovery read-only verification passed");
  });

  it("uses minimal GitHub permissions and serializes production recovery", () => {
    const source = workflowSource();
    expect(source).toContain("permissions:\n  contents: read");
    expect(source).toContain("group: project-os-input-recovery");
    expect(source).toContain("cancel-in-progress: false");
    expect(source).not.toContain("dropbox");
  });
});
