import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const workflowPath = ".github/workflows/fallback-ingress-relay.yml";
const source = readFileSync(workflowPath, "utf8");

const ruby = spawnSync("ruby", [
  "-rjson",
  "-ryaml",
  "-e",
  "doc = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [], permitted_symbols: [], aliases: false); puts JSON.generate(doc)",
  workflowPath,
], { encoding: "utf8" });
if (ruby.status !== 0) throw new Error(`YAML validation failed: ${ruby.stderr || ruby.stdout}`);
const workflow = JSON.parse(ruby.stdout);

assert.equal(typeof workflow, "object");
assert.ok(workflow && !Array.isArray(workflow));
assert.deepEqual(Object.keys(workflow.on ?? {}), ["issue_comment"], "issue_comment must be the sole trigger");
assert.deepEqual(workflow.on.issue_comment.types, ["created"]);
assert.deepEqual(workflow.permissions, { issues: "write" }, "relay may only write issue comments");
assert.deepEqual(workflow.concurrency, {
  group: "project-os-fallback-ingress-relay",
  "cancel-in-progress": false,
  queue: "max",
}, "relay must serialize requests without replacing pending requests");

const jobs = Object.values(workflow.jobs ?? {});
assert.equal(jobs.length, 1, "exactly one relay job is expected");
const [job] = jobs;
assert.equal(job?.["runs-on"], "ubuntu-latest");
assert.equal(job?.["timeout-minutes"], 2);
const condition = String(job?.if ?? "");
assert.match(condition, /github\.event\.issue\.title == 'Project OS encrypted fallback relay'/);
assert.match(condition, /github\.event\.issue\.user\.login == github\.repository_owner/);
assert.match(condition, /github\.event\.comment\.user\.login == github\.repository_owner/);
assert.match(condition, /startsWith\(github\.event\.comment\.body, 'PROJECT_OS_FALLBACK_V1 '\)/);

const steps = Array.isArray(job?.steps) ? job.steps : [];
assert.equal(steps.length, 1, "exactly one relay step is expected");
const [step] = steps;
assert.equal(step?.uses, undefined, "third-party or checkout actions are forbidden in relay");
assert.equal(step?.shell, "bash");
assert.deepEqual(step?.env, {
  INGRESS_TOKEN: "${{ secrets.INGRESS_TOKEN }}",
  GITHUB_TOKEN: "${{ github.token }}",
  COMMENT_BODY: "${{ github.event.comment.body }}",
  REPOSITORY: "${{ github.repository }}",
  ISSUE_NUMBER: "${{ github.event.issue.number }}",
});

const secretExpressions = [...source.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]);
assert.deepEqual([...new Set(secretExpressions)].sort(), ["INGRESS_TOKEN"], "INGRESS_TOKEN must be the sole repository secret");
assert.doesNotMatch(source, /::add-mask::/);
assert.doesNotMatch(source, /set\s+-x/);
assert.doesNotMatch(source, /echo[^\n]*INGRESS_TOKEN/i);
assert.doesNotMatch(source, /printf[^\n]*INGRESS_TOKEN/i);
assert.doesNotMatch(source, /console\.log\s*\(/);
assert.doesNotMatch(source, /recover-inputs/i);
assert.doesNotMatch(source, /wrangler\s+deploy/i);
assert.doesNotMatch(source, /CLOUDFLARE_(API|ACCOUNT|TOKEN)/i);
assert.doesNotMatch(source, /\/2\/files\//i);
assert.doesNotMatch(source, /dropbox/i);
assert.doesNotMatch(source, /project_id/i);
assert.doesNotMatch(source, /transaction_id/i);

const runSource = typeof step?.run === "string" ? step.run : "";
assert.match(runSource, /PROJECT_OS_FALLBACK_V1 /);
assert.match(runSource, /PROJECT_OS_FALLBACK_RESPONSE_V1 /);
assert.match(runSource, /PROJECT_OS_FALLBACK_RETRY_V1 /);
assert.match(runSource, /\^\[A-Za-z0-9_-\]\{16,64\}\$/);
assert.match(runSource, /\/v1\/fallback-ingress/);
assert.match(runSource, /\/issues\/\$\{issueNumber\}\/comments/);
assert.match(runSource, /authorization: `Bearer \$\{ingressToken\}`/);
assert.match(runSource, /authorization: `Bearer \$\{githubToken\}`/);
assert.match(runSource, /Object\.keys\(envelope\)\.sort\(\)/);
assert.match(runSource, /Object\.keys\(encryptedResponse\)\.sort\(\)/);
assert.doesNotMatch(runSource, /JSON\.stringify\(.*transaction/i);

console.log("fallback-ingress relay workflow security contract: ok");