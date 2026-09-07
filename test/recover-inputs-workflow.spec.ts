/// <reference types="vite/client" />
import workflowText from "../.github/workflows/recover-inputs.yml?raw";
import { describe, expect, it } from "vitest";

function workflowSource(): string {
  return workflowText;
}

describe("recover-inputs GitHub Actions workflow", () => {
  it("requires a guarded manual dispatch from main with one exact project ID", () => {
    const source = workflowSource();
    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("project_id:");
    expect(source).toContain("confirm_recovery:");
    expect(source).toContain('if [ "$GITHUB_REF" != "refs/heads/main" ]');
    expect(source).toContain('if [ "$CONFIRM_RECOVERY" != "RECOVER" ]');
    expect(source).toMatch(/\^PRJ-\[0-9\]\{4\}\$/);
    expect(source).not.toMatch(/\{4,\}/);
  });

  it("self-provisions only a masked, time-bounded recovery credential", () => {
    const source = workflowSource();
    expect(source).toContain("INPUT_RECOVERY_OPERATOR_TOKEN");
    expect(source).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}");
    expect(source).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
    expect(source).toContain("run: npm ci");
    expect(source).toContain("::add-mask::$OPERATOR_TOKEN");
    expect(source).toContain("${Date.now()}.");
    expect(source).not.toContain("secrets.INGRESS_TOKEN");
    expect(source).not.toContain("set -x");
  });

  it("keeps production on the Git-attributed base and targets a zero-traffic version", () => {
    const source = workflowSource();
    expect(source).toContain("Capture active production deployment");
    expect(source).toContain("Verify base deployment is Git-attributed");
    expect(source).toContain("$BASE_VERSION_ID@100%");
    expect(source).toContain("$OPERATOR_VERSION_ID@0%");
    expect(source).toContain("Cloudflare-Workers-Version-Overrides");
    expect(source).toContain("Verify normal traffic remains on base version");
    expect(source).not.toMatch(/OPERATOR_VERSION_(?:ID|TAG)[^\n]*@(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9])%/);
  });

  it("runs one bounded recovery and validates sanitized postconditions", () => {
    const source = workflowSource();
    expect(source).toContain("/v1/admin/recover-inputs");
    expect(source).toContain('JSON.stringify({ project_ids: [projectId] })');
    expect(source).toContain("--fail-with-body");
    expect(source).toContain("--connect-timeout 5");
    expect(source).toContain("--max-time 30");
    expect(source).toContain("--retry 0");
    expect(source).toContain("Sanitized recovery summary:");
    expect(source).toContain("safe.scanned !== safe.completed + safe.duplicate_cleaned + safe.conflicts + safe.withdrawn + safe.failed");
    expect(source).toContain("safe.remaining !== 0");
    expect(source).toContain("Post-recovery INPUT verification passed");
    expect(source).not.toMatch(/--request\s+(PUT|PATCH|DELETE)\b/i);
  });

  it("always restores the base and proves override removal and token revocation", () => {
    const source = workflowSource();
    expect(source).toContain("timeout-minutes: 25");
    expect(source).toContain("timeout 60s npx wrangler versions deploy");
    expect(source).toContain("if: always()");
    expect(source).toContain("Restore base production deployment and verify cleanup");
    expect(source).toContain("Operator version is no longer present in the active deployment.");
    expect(source).toContain("scripts/recovery-http-policy.mjs");
    expect(source).toContain("Operator token revocation verified with HTTP $revoke_status");
    expect(source).toContain("TOKEN_VERSION_CREATED");
  });

  it("serializes with every production-changing workflow and never calls Dropbox directly", () => {
    const source = workflowSource();
    expect(source).toContain("group: project-os-production");
    expect(source).toContain("cancel-in-progress: false");
    expect(source.toLowerCase()).not.toContain("/2/files/");
  });
});
