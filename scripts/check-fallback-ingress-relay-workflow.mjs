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
// Execute the actual inline relay against an isolated transport; never contact production.
const { runInNewContext } = await import("node:vm");
const inline = runSource.split("node <<'NODE'\n")[1].split("\nNODE")[0];
const executable = inline.slice(0, inline.indexOf("main().catch")) + "main();";
const tag = "regression_tag_0001";
const requestEnvelope = { schema_version: "1.0", key_id: "k".repeat(24), iv: "i".repeat(16), ciphertext: "c".repeat(32), client_public_key: { kty: "EC", crv: "P-256", x: "x", y: "y" } };
async function relayFixture(ciphertextLength, failPart = 0) {
  const encrypted = { schema_version: "1.0", key_id: "k".repeat(24), iv: "i".repeat(16), ciphertext: "c".repeat(ciphertextLength) };
  const responseText = JSON.stringify(encrypted);
  const comments = [];
  const execution = runInNewContext(executable, {
    Buffer, Response, TextDecoder, setTimeout: (fn) => fn(),
    process: { env: { INGRESS_TOKEN: "fixture-only", GITHUB_TOKEN: "fixture-only", COMMENT_BODY: `PROJECT_OS_FALLBACK_V1 ${tag} ${JSON.stringify(requestEnvelope)}`, REPOSITORY: "fixture/repository", ISSUE_NUMBER: "1" } },
    fetch: async (url, options) => {
      if (url.endsWith("/v1/fallback-ingress")) return new Response(responseText);
      assert.equal(url, "https://api.github.com/repos/fixture/repository/issues/1/comments");
      const body = JSON.parse(options.body).body;
      assert.ok(Buffer.byteLength(body) < 60000, "each comment must fit transport limits");
      comments.push(body);
      return new Response("{}", { status: failPart === comments.length ? 500 : 201 });
    },
  });
  return { comments, responseText, execution };
}
const small = await relayFixture(100);
await small.execution;
assert.deepEqual(small.comments, [`PROJECT_OS_FALLBACK_RESPONSE_V1 ${tag} ${small.responseText}`]);
const large = await relayFixture(223000);
await large.execution;
assert.ok(large.comments.length > 1, "large canonical context must be transported without truncation");
const pieces = large.comments.map((body, index) => {
  const prefix = `PROJECT_OS_FALLBACK_RESPONSE_PART_V1 ${tag} ${index + 1}/${large.comments.length} `;
  assert.ok(body.startsWith(prefix));
  return body.slice(prefix.length);
});
assert.equal(pieces.join(""), large.responseText, "reassembly must preserve every ciphertext byte");
const oversized = await relayFixture(1024 * 1024 + 1);
await oversized.execution;
assert.deepEqual(oversized.comments, [`PROJECT_OS_FALLBACK_UNAVAILABLE_V1 ${tag} response_too_large`]);
const partial = await relayFixture(223000, 2);
await assert.rejects(partial.execution, /publication failed/);
assert.equal(partial.comments.length, 2, "stop publication after a failed part");
console.log("fallback-ingress relay behavioral regressions: ok");
