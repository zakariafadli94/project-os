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

requireText("workflow_dispatch:", "manual workflow_dispatch trigger");
requireText("issues:", "connector-accessible issue trigger");
requireText("types: [opened]", "opened-issue trigger scope");
forbid(/^\s*push:/m, "push trigger");
forbid(/^\s*pull_request:/m, "pull_request trigger");
forbid(/PROJECT_OS_INGRESS_TOKEN/, "persistent GitHub ingress-token dependency");
requireText("CLOUDFLARE_API_TOKEN", "existing Cloudflare API credential");
requireText("CLOUDFLARE_ACCOUNT_ID", "existing Cloudflare account credential");
requireText("MUTATION_GATE_OPERATOR_TOKEN", "ephemeral Worker operator secret");
requireText("wrangler secret bulk", "non-interactive Worker secret lifecycle");
requireText("::add-mask::", "GitHub log masking");
requireText("if: always()", "unconditional cleanup path");
requireText("HTTP 401", "post-cleanup revocation verification");
requireText("github.repository_owner", "owner-only issue trigger guard");
requireText("[operator] MutationGate PRJ-0003 reject repair", "exact connector control issue title");
requireText("/v1/mutation-candidates/resolve", "governed resolution endpoint");
requireText('{"operation":"candidate.reject"', "explicit candidate.reject payload");
requireText('{"status":"committed"', "committed receipt check");
requireText('"action":"reject"', "reject action check");
requireText("confirm_reject", "explicit operator confirmation input");
requireText("candidate_ids_json", "candidate list input");
forbid(/dropbox/i, "direct Dropbox access");

for (const candidateId of expectedCandidates) {
  requireText(candidateId, `repair candidate ${candidateId}`);
}

console.log("MutationGate repair workflow contract passed");
