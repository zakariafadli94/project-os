import { readFileSync } from "node:fs";

const workflowPath = new URL("../.github/workflows/mutation-candidate-reject.yml", import.meta.url);
const workflow = readFileSync(workflowPath, "utf8");

const expectedCandidates = [
  "MUTCAND-A546CDBE7CF04684BD3A0C80",
  "MUTCAND-5A8935635AAEB09CCF1ABA29",
  "MUTCAND-A0F80BD3D82FED5C45DA472F",
  "MUTCAND-40BE82147A4DDA2B277AA2EE",
  "MUTCAND-F70FB05673E9F63940717150",
  "MUTCAND-A0FF170F4D6D3412953AFACB",
  "MUTCAND-D95D6E3FD68ACD3A2B93DB3A",
  "MUTCAND-34C0FA6FF7DA80ACDA79EA88"
];

const requireText = (needle, label = needle) => {
  if (!workflow.includes(needle)) throw new Error(`MutationGate repair workflow missing ${label}`);
};
const forbid = (pattern, label) => {
  if (pattern.test(workflow)) throw new Error(`MutationGate repair workflow must not contain ${label}`);
};
const requireBefore = (first, second, label) => {
  const firstIndex = workflow.indexOf(first);
  const secondIndex = workflow.indexOf(second);
  if (firstIndex === -1 || secondIndex === -1 || firstIndex >= secondIndex) {
    throw new Error(`MutationGate repair workflow has invalid ordering for ${label}`);
  }
};

requireText("workflow_dispatch:", "manual workflow_dispatch trigger");
requireText("issues:", "connector-accessible issue trigger");
requireText("types: [opened]", "opened-issue trigger scope");
forbid(/^\s*push:/m, "push trigger");
forbid(/^\s*pull_request:/m, "pull_request trigger");
forbid(/PROJECT_OS_INGRESS_TOKEN/, "persistent GitHub ingress-token dependency");
requireText("CLOUDFLARE_API_TOKEN", "existing Cloudflare API credential");
requireText("CLOUDFLARE_ACCOUNT_ID", "existing Cloudflare account credential");
requireText("MUTATION_GATE_OPERATOR_TOKEN", "ephemeral Worker operator secret");
requireText("runs-on: ubuntu-latest", "GitHub-hosted runner");
forbid(/wrangler secret bulk/, "legacy immediate secret lifecycle");
requireText("Capture active production deployment", "authoritative base capture");
requireText("workers/scripts/$WORKER_NAME/deployments", "Cloudflare active deployment API");
requireText("BASE_VERSION_ID", "captured base Worker version");
requireText("Verify base deployment is Git-attributed", "Git-attributed base prerequisite");
requireText("worker_version_tag", "base Worker version tag proof");
requireText("git_sha", "base Git SHA proof");
requireText("wrangler versions upload", "versioned operator-token upload");
requireText("--secrets-file", "operator-token secrets file upload");
requireText("OPERATOR_VERSION_TAG", "unique operator version tag");
requireText("OPERATOR_VERSION_ID", "resolved operator Worker version id");
requireText("wrangler versions list --json", "operator version-id fallback resolution");
requireText("wrangler versions deploy", "explicit zero-traffic deployment composition");
requireText("$BASE_VERSION_ID@100%", "authoritative base pinned at 100 percent");
requireText("$OPERATOR_VERSION_ID@0%", "operator version pinned at zero percent");
forbid(/OPERATOR_VERSION_(?:ID|TAG)[^\n]*@(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9])%/, "positive operator-version traffic");
forbid(/CLEANUP_VERSION_TAG/, "cleanup version that could become a production release");
forbid(/wrangler versions secret delete MUTATION_GATE_OPERATOR_TOKEN/, "secret-delete version churn");
requireText("Cloudflare-Workers-Version-Overrides", "targeted version override header");
requireText("Verify normal traffic remains on base version", "normal-traffic zero-percent proof");
requireText("Verify version override reaches operator version", "operator override identity proof");
requireText("TOKEN_VERSION_CREATED", "operator-version creation state tracking");
requireText("::add-mask::", "GitHub log masking");
requireText("if: always()", "unconditional cleanup path");
requireText("Restore base production deployment and verify cleanup", "base-only cleanup");
requireText("Operator version is no longer present in the active deployment", "override-removal proof");
requireText("HTTP 401", "post-cleanup revocation verification");
requireText("revoked=0", "bounded revocation state");
requireText("Operator token still not verified revoked on attempt", "bounded revocation retry diagnostic");
requireText("github.repository_owner", "owner-only issue trigger guard");
requireText("[operator] MutationGate PRJ-0003 reject repair", "exact connector control issue title");
requireText("group: project-os-production", "shared production deployment concurrency lock");
forbid(/group: mutation-candidate-reject-operator/, "operator-only concurrency group");
requireText("cancel-in-progress: false", "non-cancelling operator queue");
requireText("/v1/mutation-candidates/resolve", "governed resolution endpoint");
requireText('{"operation":"candidate.reject"', "explicit candidate.reject payload");
requireText('{"status":"committed"', "committed receipt check");
requireText('"action":"reject"', "reject action check");
requireText("confirm_reject", "explicit operator confirmation input");
requireText("candidate_ids_json", "candidate list input");
requireText("Verify ephemeral operator token readiness", "authenticated operator-token readiness probe");
requireText("invalid_mutation_candidate_resolution", "readiness probe authenticated-response contract");
requireText("readiness probe received HTTP 401", "readiness retry on propagation");
requireText("--data '{}'", "non-mutating invalid readiness probe payload");
requireText("candidate reject received HTTP 401", "per-candidate 401 retry diagnostic");
requireText("await new Promise((resolve) => setTimeout(resolve, 3000))", "bounded per-candidate retry delay");
requireText("for (let attempt = 1; attempt <= 10; attempt += 1)", "bounded per-candidate retry loop");
requireText("const payloadJson = JSON.stringify(payload)", "stable retry payload serialization");
requireBefore("Capture active production deployment", "Create ephemeral operator-token version", "base capture before operator version creation");
requireBefore("Create ephemeral operator-token version", "Attach operator version at zero percent traffic", "operator upload before zero-traffic attachment");
requireBefore("Attach operator version at zero percent traffic", "Verify normal traffic remains on base version", "zero-traffic attachment before normal-traffic proof");
requireBefore("Verify version override reaches operator version", "Verify ephemeral operator token readiness", "version identity before token readiness");
requireBefore("Verify ephemeral operator token readiness", "Reject candidates through governed ingress", "token readiness before mutation");
forbid(/Verify production health after token install/, "health-only operator-token readiness check");
forbid(/dropbox/i, "direct Dropbox access");

for (const candidateId of expectedCandidates) {
  requireText(candidateId, `repair candidate ${candidateId}`);
}

console.log("MutationGate repair workflow contract passed");
