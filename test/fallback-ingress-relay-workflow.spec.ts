/// <reference types="vite/client" />
import workflowText from "../.github/workflows/fallback-ingress-relay.yml?raw";
import { describe, expect, it } from "vitest";

const source = workflowText;

describe("encrypted fallback ingress relay workflow", () => {
  it("is owner-only, serialized, and grants only issue write permission", () => {
    expect(source).toContain('"on":');
    expect(source).toContain("issue_comment:");
    expect(source).toContain("types: [created]");
    expect(source).toContain("permissions:\n  issues: write");
    expect(source).toContain("group: project-os-fallback-ingress-relay");
    expect(source).toContain("cancel-in-progress: false");
    expect(source).toContain("runs-on: ubuntu-latest");
    expect(source).toContain("timeout-minutes: 2");
    expect(source).toContain("github.event.issue.title == 'Project OS encrypted fallback relay'");
    expect(source).toContain("github.event.issue.user.login == github.repository_owner");
    expect(source).toContain("github.event.comment.user.login == github.repository_owner");
    expect(source).toContain("startsWith(github.event.comment.body, 'PROJECT_OS_FALLBACK_V1 ')");
  });

  it("uses only the ingress secret and never exposes plaintext or deployment surfaces", () => {
    const secretExpressions = [...source.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]);
    expect([...new Set(secretExpressions)].sort()).toEqual(["INGRESS_TOKEN"]);
    expect(source).toContain("INGRESS_TOKEN: ${{ secrets.INGRESS_TOKEN }}");
    expect(source).toContain("GITHUB_TOKEN: ${{ github.token }}");
    expect(source).toContain("COMMENT_BODY: ${{ github.event.comment.body }}");
    expect(source).toContain("REPOSITORY: ${{ github.repository }}");
    expect(source).toContain("ISSUE_NUMBER: ${{ github.event.issue.number }}");
    expect(source).not.toContain("- uses:");
    expect(source).not.toMatch(/::add-mask::/);
    expect(source).not.toMatch(/set\s+-x/);
    expect(source).not.toMatch(/echo[^\n]*INGRESS_TOKEN/i);
    expect(source).not.toMatch(/printf[^\n]*INGRESS_TOKEN/i);
    expect(source).not.toMatch(/console\.log\s*\(/);
    expect(source).not.toMatch(/recover-inputs/i);
    expect(source).not.toMatch(/wrangler\s+deploy/i);
    expect(source).not.toMatch(/CLOUDFLARE_(API|ACCOUNT|TOKEN)/i);
    expect(source).not.toMatch(/\/2\/files\//i);
    expect(source).not.toMatch(/dropbox/i);
  });

  it("accepts only ciphertext envelopes and posts only ciphertext or generic retry markers", () => {
    expect(source).toContain("PROJECT_OS_FALLBACK_V1 ");
    expect(source).toContain("PROJECT_OS_FALLBACK_RESPONSE_V1 ");
    expect(source).toContain("PROJECT_OS_FALLBACK_RETRY_V1 ");
    expect(source).toMatch(/\^\[A-Za-z0-9_-\]\{16,64\}\$/);
    expect(source).toContain("/v1/fallback-ingress");
    expect(source).toContain("/issues/${issueNumber}/comments");
    expect(source).toContain("authorization: `Bearer ${ingressToken}`");
    expect(source).toContain("authorization: `Bearer ${githubToken}`");
    expect(source).toContain("Object.keys(envelope).sort()");
    expect(source).toContain("Object.keys(encryptedResponse).sort()");
    expect(source).not.toMatch(/JSON\.stringify\(.*transaction/i);
    expect(source).not.toMatch(/project_id/i);
    expect(source).not.toMatch(/transaction_id/i);
  });
});
