import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const workflowPath = ".github/workflows/recover-inputs.yml";
const source = readFileSync(workflowPath, "utf8");

function parseYaml(path) {
  const ruby = spawnSync("ruby", [
    "-rjson",
    "-ryaml",
    "-e",
    "doc = YAML.safe_load(File.read(ARGV[0]), permitted_classes: [], permitted_symbols: [], aliases: false); puts JSON.generate(doc)",
    path,
  ], { encoding: "utf8" });
  if (ruby.status !== 0) throw new Error(`YAML validation failed: ${ruby.stderr || ruby.stdout}`);
  return JSON.parse(ruby.stdout);
}

function assertProjectIdCases() {
  const valid = ["PRJ-0000", "PRJ-0002", "PRJ-9999"];
  const invalid = [
    "PRJ-000",
    "PRJ-00000",
    "PRJ-12A4",
    "prj-0002",
    "PRJ_0002",
    " PRJ-0002",
    "PRJ-0002 ",
    "PRJ-AUTO",
  ];
  const pattern = /^PRJ-[0-9]{4}$/;
  for (const value of valid) assert.equal(pattern.test(value), true, `Node should accept ${value}`);
  for (const value of invalid) assert.equal(pattern.test(value), false, `Node should reject ${value}`);
}

function requireText(value, label) {
  assert.ok(source.includes(value), `missing ${label}: ${value}`);
}

function requireBefore(left, right, label) {
  const leftIndex = source.indexOf(left);
  const rightIndex = source.indexOf(right);
  assert.ok(leftIndex >= 0 && rightIndex >= 0 && leftIndex < rightIndex, `invalid step order: ${label}`);
}

const workflow = parseYaml(workflowPath);
assert.ok(workflow && typeof workflow === "object" && !Array.isArray(workflow));
assert.deepEqual(Object.keys(workflow.on ?? {}), ["workflow_dispatch"], "workflow_dispatch must be the only trigger");
assert.equal(workflow.on.workflow_dispatch.inputs.project_id.required, true);
assert.equal(workflow.on.workflow_dispatch.inputs.confirm_recovery.required, true);
assert.deepEqual(workflow.permissions, { contents: "read" }, "workflow may request only read-only repository content access");
assert.equal(workflow.concurrency?.group, "project-os-production");
assert.equal(workflow.concurrency?.["cancel-in-progress"], false);

assertProjectIdCases();
assert.match(source, /\[\[ "\$PROJECT_ID" =~ \^PRJ-\[0-9\]\{4\}\$ \]\]/);
assert.match(source, /\/\^PRJ-\[0-9\]\{4\}\$\//);
assert.doesNotMatch(source, /\{4,\}/, "open-ended project-id regex is forbidden");

const secrets = [...source.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]);
assert.deepEqual(
  [...new Set(secrets)].sort(),
  ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
  "workflow must use only the existing Cloudflare deployment credentials",
);
assert.doesNotMatch(source, /INGRESS_TOKEN/, "persistent ingress secret is forbidden");
requireText("INPUT_RECOVERY_OPERATOR_TOKEN", "recovery-only operator secret");
requireText('echo "::add-mask::$OPERATOR_TOKEN"', "immediate token masking");
requireText("${Date.now()}.", "time-bounded token prefix");
requireText("randomBytes(32)", "cryptographically random token material");
assert.doesNotMatch(source, /set\s+-x/);
assert.doesNotMatch(source, /console\.log\([^\n]*(OPERATOR_TOKEN|INPUT_RECOVERY_OPERATOR_TOKEN)/);
assert.doesNotMatch(source, /echo[^\n]*INPUT_RECOVERY_OPERATOR_TOKEN/);

const jobs = Object.values(workflow.jobs ?? {});
assert.equal(jobs.length, 1, "exactly one recovery job is expected");
const [job] = jobs;
assert.equal(job?.["timeout-minutes"], 25, "job timeout must reserve enough time for unconditional cleanup");
assert.equal(job?.env?.CLOUDFLARE_API_TOKEN, undefined, "Cloudflare API token must not be exposed at job scope");
assert.equal(job?.env?.CLOUDFLARE_ACCOUNT_ID, undefined, "Cloudflare account id must not be exposed at job scope");
for (const [name, value] of Object.entries(job?.env ?? {})) {
  assert.doesNotMatch(
    String(value),
    /\$\{\{\s*runner\./,
    `job-level env ${name} must not use the unavailable runner context`,
  );
}
const steps = Array.isArray(job?.steps) ? job.steps : [];
const stepByName = new Map(steps.filter((step) => step?.name).map((step) => [step.name, step]));
const requiredSteps = [
  "Validate manual recovery gate",
  "Build strict recovery payload",
  "Capture active production deployment",
  "Verify base deployment is Git-attributed",
  "Generate ephemeral recovery token and version tag",
  "Create ephemeral recovery-token version",
  "Attach operator version at zero percent traffic",
  "Verify normal traffic remains on base version",
  "Verify version override reaches operator version",
  "Verify ephemeral recovery token readiness",
  "Run targeted recovery and verify INPUTS drained",
  "Restore base production deployment and verify cleanup",
];
for (const name of requiredSteps) assert.ok(stepByName.has(name), `missing workflow step: ${name}`);

assert.deepEqual(stepByName.get("Build strict recovery payload")?.env, {
  RECOVERY_PAYLOAD_FILE: "${{ runner.temp }}/recover-inputs-payload.json",
}, "payload path must use runner.temp only at step scope");
assert.deepEqual(stepByName.get("Run targeted recovery and verify INPUTS drained")?.env, {
  RECOVERY_RESPONSE_FILE: "${{ runner.temp }}/recover-inputs-response.json",
  RECOVERY_PAYLOAD_FILE: "${{ runner.temp }}/recover-inputs-payload.json",
}, "recovery paths must use runner.temp only at step scope");

assert.equal(
  steps.find((step) => step?.name === "Install dependencies")?.run,
  "npm ci",
  "dependency installation must be deterministic",
);
for (const name of [
  "Validate manual recovery gate",
  "Capture active production deployment",
  "Create ephemeral recovery-token version",
  "Attach operator version at zero percent traffic",
  "Restore base production deployment and verify cleanup",
]) {
  assert.deepEqual(stepByName.get(name)?.env, {
    CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
  }, `${name} must receive only the Cloudflare credentials it consumes`);
}

requireBefore("Capture active production deployment", "Create ephemeral recovery-token version", "capture base before upload");
requireBefore("Create ephemeral recovery-token version", "Attach operator version at zero percent traffic", "upload before attachment");
requireBefore("Attach operator version at zero percent traffic", "Verify normal traffic remains on base version", "attach before proof");
requireBefore("Verify version override reaches operator version", "Verify ephemeral recovery token readiness", "identity before auth");
requireBefore("Verify ephemeral recovery token readiness", "Run targeted recovery and verify INPUTS drained", "readiness before mutation");

const createSource = String(stepByName.get("Create ephemeral recovery-token version")?.run ?? "");
assert.match(createSource, /timeout 60s npx wrangler versions upload/);
assert.match(createSource, /--secrets-file/);
assert.match(createSource, /timeout 60s npx wrangler versions list --json/);
assert.match(createSource, /TOKEN_VERSION_CREATED=true/);

const attachSource = String(stepByName.get("Attach operator version at zero percent traffic")?.run ?? "");
assert.match(attachSource, /timeout 60s npx wrangler versions deploy/);
assert.ok(attachSource.includes("$BASE_VERSION_ID@100%"));
assert.ok(attachSource.includes("$OPERATOR_VERSION_ID@0%"));
assert.doesNotMatch(attachSource, /OPERATOR_VERSION_ID@(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9])%/);

const runSource = String(stepByName.get("Run targeted recovery and verify INPUTS drained")?.run ?? "");
assert.match(runSource, /--request POST[\s\S]*\/v1\/admin\/recover-inputs/);
assert.equal((runSource.match(/Cloudflare-Workers-Version-Overrides/g) ?? []).length, 1);
assert.equal((runSource.match(/Authorization: Bearer \$OPERATOR_TOKEN/g) ?? []).length, 1);
assert.match(runSource, /--connect-timeout 5/);
assert.match(runSource, /--max-time 30/);
assert.match(runSource, /--retry 0/);
assert.match(runSource, /safe\.scanned\s*!==\s*safe\.completed\s*\+\s*safe\.duplicate_cleaned\s*\+\s*safe\.conflicts\s*\+\s*safe\.withdrawn\s*\+\s*safe\.failed/);
assert.match(runSource, /safe\.remaining\s*!==\s*0/);
assert.doesNotMatch(runSource, /--request GET/);
assert.doesNotMatch(runSource, /--request\s+(PUT|PATCH|DELETE)\b/i);

const cleanup = stepByName.get("Restore base production deployment and verify cleanup");
assert.equal(cleanup?.if, "always()", "cleanup must be unconditional");
const cleanupSource = String(cleanup?.run ?? "");
assert.match(cleanupSource, /timeout 60s npx wrangler versions deploy/);
assert.ok(cleanupSource.includes("$BASE_VERSION_ID@100%"));
assert.ok(cleanupSource.includes("Operator version is no longer present in the active deployment."));
assert.ok(cleanupSource.includes("Operator token revocation verified with HTTP $revoke_status"));
assert.match(cleanupSource, /Cloudflare-Workers-Version-Overrides/);
assert.match(cleanupSource, /recovery-http-policy\.mjs revocation/);
assert.doesNotMatch(cleanupSource, /OPERATOR_VERSION_ID@0%/);

assert.doesNotMatch(source, /while\s+(?:true|:)/, "unbounded loops are forbidden");
assert.doesNotMatch(source, /\/2\/files\//i, "direct Dropbox API access is forbidden");
assert.doesNotMatch(source, /wrangler\s+rollback\b/, "rollback may not select an unknown historical version");

console.log("recover-inputs zero-traffic operator security contract: ok");
