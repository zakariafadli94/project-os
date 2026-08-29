import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowsDir = join(root, ".github", "workflows");
const deployPath = join(workflowsDir, "deploy.yml");
const operatorPath = join(workflowsDir, "mutation-candidate-reject.yml");
const deploy = readFileSync(deployPath, "utf8");
const operator = readFileSync(operatorPath, "utf8");

const requireText = (text, needle, label = needle) => {
  if (!text.includes(needle)) throw new Error(`Production promotion authority missing ${label}`);
};
const forbid = (text, pattern, label) => {
  if (pattern.test(text)) throw new Error(`Production promotion authority must not contain ${label}`);
};

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

// No third workflow may mutate Worker production deployment state.
for (const name of readdirSync(workflowsDir).filter((entry) => /\.ya?ml$/.test(entry))) {
  if (name === "deploy.yml" || name === "mutation-candidate-reject.yml") continue;
  const content = readFileSync(join(workflowsDir, name), "utf8");
  if (/\bnpm\s+run\s+deploy\b|\bwrangler\s+deploy\b|\bwrangler\s+rollback\b|\bwrangler\s+versions\s+deploy\b/.test(content)) {
    throw new Error(`Workflow ${name} contains an unauthorized production deployment command`);
  }
}

console.log("Production promotion authority contract passed");
