import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/fallback-ingress-relay.yml";

function parseWorkflow(): { source: string; workflow: any } {
  const source = readFileSync(workflowPath, "utf8");
  const ruby = spawnSync("ruby", [
    "-rjson",
    "-ryaml",
    "-e",
    "doc = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [], permitted_symbols: [], aliases: false); puts JSON.generate(doc)",
    workflowPath,
  ], { encoding: "utf8" });
  if (ruby.status !== 0) throw new Error(`YAML validation failed: ${ruby.stderr || ruby.stdout}`);
  return { source, workflow: JSON.parse(ruby.stdout) };
}

describe("encrypted fallback ingress relay workflow", () => {
  it("is owner-only, serialized, and grants only issue write permission", () => {
    const { workflow } = parseWorkflow();
    expect(Object.keys(workflow.on ?? {})).toEqual(["issue_comment"]);
    expect(workflow.on.issue_comment.types).toEqual(["created"]);
    expect(workflow.permissions).toEqual({ issues: "write" });
    expect(workflow.concurrency).toEqual({
      group: "project-os-fallback-ingress-relay",
      "cancel-in-progress": false,
    });

    const jobs = Object.values(workflow.jobs ?? {}) as any[];
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job["timeout-minutes"]).toBe(2);
    const condition = String(job.if ?? "");
    expect(condition).toContain("github.event.issue.title == 'Project OS encrypted fallback relay'");
    expect(condition).toContain("github.event.issue.user.login == github.repository_owner");
    expect(condition).toContain("github.event.comment.user.login == github.repository_owner");
    expect(condition).toContain("startsWith(github.event.comment.body, 'PROJECT_OS_FALLBACK_V1 ')");
  });

  it("uses only the ingress secret and never exposes plaintext or deployment surfaces", () => {
    const { source, workflow } = parseWorkflow();
    const secretExpressions = [...source.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]);
    expect([...new Set(secretExpressions)].sort()).toEqual(["INGRESS_TOKEN"]);
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

    const jobs = Object.values(workflow.jobs ?? {}) as any[];
    const steps = jobs.flatMap((job) => Array.isArray(job.steps) ? job.steps : []);
    expect(steps).toHaveLength(1);
    expect(steps[0].uses).toBeUndefined();
    expect(steps[0].env).toEqual({
      INGRESS_TOKEN: "${{ secrets.INGRESS_TOKEN }}",
      GITHUB_TOKEN: "${{ github.token }}",
      COMMENT_BODY: "${{ github.event.comment.body }}",
      REPOSITORY: "${{ github.repository }}",
      ISSUE_NUMBER: "${{ github.event.issue.number }}",
    });
  });

  it("accepts only ciphertext envelopes and posts only ciphertext or generic retry markers", () => {
    const { workflow } = parseWorkflow();
    const jobs = Object.values(workflow.jobs ?? {}) as any[];
    const runSource = jobs.flatMap((job) => Array.isArray(job.steps) ? job.steps : [])
      .map((step) => typeof step.run === "string" ? step.run : "")
      .join("\n");

    expect(runSource).toContain("PROJECT_OS_FALLBACK_V1 ");
    expect(runSource).toContain("PROJECT_OS_FALLBACK_RESPONSE_V1 ");
    expect(runSource).toContain("PROJECT_OS_FALLBACK_RETRY_V1 ");
    expect(runSource).toMatch(/\^\[A-Za-z0-9_-\]\{16,64\}\$/);
    expect(runSource).toContain("/v1/fallback-ingress");
    expect(runSource).toContain("/issues/${issueNumber}/comments");
    expect(runSource).toContain("authorization: `Bearer ${ingressToken}`");
    expect(runSource).toContain("authorization: `Bearer ${githubToken}`");
    expect(runSource).toContain("Object.keys(envelope).sort()");
    expect(runSource).toContain("Object.keys(encryptedResponse).sort()");
    expect(runSource).not.toMatch(/JSON\.stringify\(.*transaction/i);
    expect(runSource).not.toMatch(/project_id/i);
    expect(runSource).not.toMatch(/transaction_id/i);
  });
});
