import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

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
  if (ruby.status !== 0) {
    throw new Error(`YAML validation failed: ${ruby.stderr || ruby.stdout}`);
  }
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

  const nodePattern = /^PRJ-[0-9]{4}$/;
  for (const value of valid) assert.equal(nodePattern.test(value), true, `Node should accept ${value}`);
  for (const value of invalid) assert.equal(nodePattern.test(value), false, `Node should reject ${value}`);

  const bashProgram = [
    "set -euo pipefail",
    "valid=(PRJ-0000 PRJ-0002 PRJ-9999)",
    "invalid=(PRJ-000 PRJ-00000 PRJ-12A4 prj-0002 PRJ_0002 ' PRJ-0002' 'PRJ-0002 ' PRJ-AUTO)",
    "for value in \"${valid[@]}\"; do",
    "  [[ \"$value\" =~ ^PRJ-[0-9]{4}$ ]] || { echo \"Bash rejected valid project id\" >&2; exit 1; }",
    "done",
    "for value in \"${invalid[@]}\"; do",
    "  if [[ \"$value\" =~ ^PRJ-[0-9]{4}$ ]]; then",
    "    echo \"Bash accepted invalid project id\" >&2",
    "    exit 1",
    "  fi",
    "done",
  ].join("\n");
  const bash = spawnSync("bash", ["-c", bashProgram], { encoding: "utf8" });
  assert.equal(bash.status, 0, bash.stderr || bash.stdout || "Bash project ID cases failed");
}

const workflow = parseYaml(workflowPath);
assert.equal(typeof workflow, "object");
assert.ok(workflow && !Array.isArray(workflow));
assert.deepEqual(Object.keys(workflow.on ?? {}), ["workflow_dispatch"], "workflow_dispatch must be the only trigger");
assert.equal(workflow.on.workflow_dispatch.inputs.project_id.required, true);
assert.equal(workflow.on.workflow_dispatch.inputs.confirm_recovery.required, true);
assert.deepEqual(workflow.permissions ?? null, {}, "workflow must request no GitHub token permissions");
assert.equal(workflow.concurrency?.group, "project-os-input-recovery");
assert.equal(workflow.concurrency?.["cancel-in-progress"], false);

assertProjectIdCases();
assert.match(source, /\[\[ "\$PROJECT_ID" =~ \^PRJ-\[0-9\]\{4\}\$ \]\]/, "Bash gate must use exactly ^PRJ-[0-9]{4}$");
assert.match(source, /\/\^PRJ-\[0-9\]\{4\}\$\//, "Node gate must use exactly ^PRJ-[0-9]{4}$");
assert.doesNotMatch(source, /\{4,\}/, "open-ended PRJ regex is forbidden");

const secretExpressions = [...source.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]);
assert.deepEqual([...new Set(secretExpressions)].sort(), ["INGRESS_TOKEN"], "INGRESS_TOKEN must be the only GitHub secret expression");
assert.doesNotMatch(source, /::add-mask::/);
assert.doesNotMatch(source, /echo[^\n]*INGRESS_TOKEN/i);
assert.doesNotMatch(source, /printf[^\n]*INGRESS_TOKEN/i);
assert.doesNotMatch(source, /set\s+-x/);

const jobs = Object.values(workflow.jobs ?? {});
assert.equal(jobs.length, 1, "exactly one recovery job is expected");
const steps = jobs.flatMap((job) => Array.isArray(job?.steps) ? job.steps : []);
const runSource = steps.map((step) => typeof step?.run === "string" ? step.run : "").join("\n");
assert.match(runSource, /--request POST[\s\S]*\/v1\/admin\/recover-inputs/);
assert.match(runSource, /--request GET[\s\S]*\/v1\/admin\/input-recovery-status\?project_id=/);
assert.doesNotMatch(runSource, /\/v1\/admin\/schema-status/);
assert.doesNotMatch(runSource, /--request\s+(PUT|PATCH|DELETE)\b/i);
assert.doesNotMatch(runSource, /\/2\/files\//i, "direct Dropbox API mutation is forbidden");
assert.doesNotMatch(runSource, /\b(cat|tee)\b[^\n]*(RECOVERY_RESPONSE_FILE|POSTCHECK_RESPONSE_FILE)/);

const consoleLogs = [...runSource.matchAll(/console\.log\(([^\n]*)/g)].map((match) => match[1]);
for (const log of consoleLogs) {
  assert.ok(
    log.includes("Sanitized recovery summary") || log.includes("Post-recovery INPUT verification passed"),
    `unexpected console.log in recovery workflow: ${log}`
  );
}

assert.match(runSource, /safe\.scanned\s*!==\s*safe\.completed\s*\+\s*safe\.duplicate_cleaned\s*\+\s*safe\.conflicts\s*\+\s*safe\.withdrawn\s*\+\s*safe\.failed/);
assert.match(runSource, /body\?\.remaining\s*!==\s*0/);
assert.doesNotMatch(source, /dropbox/i);

console.log("recover-inputs workflow security contract: ok");
