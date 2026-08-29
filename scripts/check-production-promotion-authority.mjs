import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowsDir = join(root, ".github", "workflows");
const deployPath = join(workflowsDir, "deploy.yml");
const operatorPath = join(workflowsDir, "mutation-candidate-reject.yml");
const disableBuildsPath = join(workflowsDir, "r0-disable-cloudflare-workers-builds.yml");
const deploy = readFileSync(deployPath, "utf8");
const operator = readFileSync(operatorPath, "utf8");
const disableBuilds = readFileSync(disableBuildsPath, "utf8");

const requireText = (text, needle, label = needle) => {
  if (!text.includes(needle)) throw new Error(`Production promotion authority missing ${label}`);
};
const forbid = (text, pattern, label) => {
  if (pattern.test(text)) throw new Error(`Production promotion authority must not contain ${label}`);
};
const directPromotionLines = (text) => text
  .split(/\r?\n/)
  .filter((line) => /\bnpm\s+run\s+deploy\b|\bwrangler\s+deploy\b|\bwrangler\s+rollback\b|\bwrangler\s+versions\s+deploy\b/.test(line))
  .filter((line) => !/\bwrangler\s+deploy\b.*--dry-run\b/.test(line));

// GitHub deploy.yml is the sole positive-traffic production promoter.
requireText(deploy, "branches: [main]", "main-only automatic production trigger");
requireText(deploy, "workflow_dispatch:", "manual production trigger");
requireText(deploy, "group: project-os-production", "shared production serialization lock");
requireText(deploy, "git-${GITHUB_SHA}", "exact Git-SHA Worker version tag");
requireText(deploy, "worker_version_id", "post-deploy Worker version identity verification");
requireText(deploy, "worker_version_tag", "post-deploy Worker tag verification");
requireText(deploy, "git_sha", "post-deploy Git SHA verification");

// MutationGate may temporarily attach an operator version at 0% and address it
// only through Cloudflare version overrides. It must never promote that version.
requireText(operator, "BASE_VERSION_ID", "captured base production version");
requireText(operator, "OPERATOR_VERSION_ID", "ephemeral operator version id");
requireText(operator, "$BASE_VERSION_ID@100%", "base version held at 100 percent");
requireText(operator, "$OPERATOR_VERSION_ID@0%", "operator version held at zero percent");
requireText(operator, "Cloudflare-Workers-Version-Overrides", "version-targeted operator requests");
requireText(operator, "Verify normal traffic remains on base version", "zero-traffic verification");
requireText(operator, "Restore base production deployment", "base-only cleanup");
forbid(operator, /OPERATOR_VERSION_(?:ID|TAG)[^\n]*@(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9])%/, "positive operator-version traffic");
forbid(operator, /CLEANUP_VERSION_TAG/, "cleanup version that can become a second production release");
forbid(operator, /wrangler\s+rollback\b/, "operator rollback command");

// R0 account cutover removes Cloudflare Workers Builds triggers and delegates
// the final republish to deploy.yml rather than promoting Worker code itself.
requireText(disableBuilds, "[operator] Project OS R0 disable Cloudflare Workers Builds", "owner-only R0 cutover control issue");
requireText(disableBuilds, "/workers/scripts", "immutable Worker-tag lookup");
requireText(disableBuilds, "/builds/workers/$WORKER_TAG/triggers", "Workers Builds trigger listing");
requireText(disableBuilds, "--request DELETE", "Workers Builds trigger deletion");
requireText(disableBuilds, "/builds/triggers/$trigger_id", "trigger-specific deletion endpoint");
requireText(disableBuilds, "body.result.length !== 0", "zero-trigger verification");
requireText(disableBuilds, "/actions/workflows/deploy.yml/dispatches", "authoritative promoter republish request");
if (directPromotionLines(disableBuilds).length > 0) {
  throw new Error("Production promotion authority must not contain direct Worker promotion from R0 cutover workflow");
}

// No third workflow may mutate Worker production deployment state. A Wrangler
// dry-run in CI is explicitly non-promoting and remains allowed.
for (const name of readdirSync(workflowsDir).filter((entry) => /\.ya?ml$/.test(entry))) {
  if (name === "deploy.yml" || name === "mutation-candidate-reject.yml" || name === "r0-disable-cloudflare-workers-builds.yml") continue;
  const content = readFileSync(join(workflowsDir, name), "utf8");
  const offenders = directPromotionLines(content);
  if (offenders.length > 0) {
    throw new Error(`Workflow ${name} contains an unauthorized production deployment command: ${offenders[0].trim()}`);
  }
}

console.log("Production promotion authority contract passed");
