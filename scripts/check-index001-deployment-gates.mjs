import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const neutralWorker = await readFile(new URL("../src/index-neutral.ts", import.meta.url), "utf8");
const productionWorker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const projectSearchSync = await readFile(new URL("../src/durable/project-guard-search-sync.ts", import.meta.url), "utf8");
const searchSyncGuard = await readFile(new URL("../src/durable/search-sync-guard.ts", import.meta.url), "utf8");

const failures = [];
const requireMatch = (value, pattern, message) => {
  if (!pattern.test(value)) failures.push(message);
};
const rejectMatch = (value, pattern, message) => {
  if (pattern.test(value)) failures.push(message);
};

requireMatch(workflow, /^\s*workflow_dispatch:\s*$/m, "deploy workflow must use workflow_dispatch");
rejectMatch(workflow, /^\s*push:\s*$/m, "deploy workflow must not deploy automatically on push");
requireMatch(workflow, /confirm_production/, "deploy workflow must require explicit production confirmation");
requireMatch(workflow, /expected_sha/, "deploy workflow must bind deployment to an expected SHA");
requireMatch(workflow, /refs\/heads\/main/, "deploy workflow must reject non-main refs");

requireMatch(config, /"PROJECT_OS_SEARCH_READ_MODE"\s*:\s*"off"/, "production search read mode must remain off");
requireMatch(config, /"PROJECT_OS_SEARCH_SYNC_MODE"\s*:\s*"off"/, "production search sync mode must remain off");
requireMatch(config, /"observability"\s*:/, "Workers observability must be prepared in Wrangler config");
requireMatch(config, /"enabled"\s*:\s*true/, "Workers observability must be enabled in prepared config");
requireMatch(config, /"head_sampling_rate"\s*:\s*0\.1/, "Workers observability sampling must be bounded at 0.1");

requireMatch(neutralWorker, /reconcileSearchIndexes[\s\S]*?if \(!searchSyncEnabled\(env\)\)/, "fleet search reconciliation must fail closed on search sync mode");
requireMatch(projectSearchSync, /captureSearchSideEffects[\s\S]*?!searchSyncEnabled\(this\.env\)/, "ProjectGuard derived search side effects must be gated by search sync mode");
requireMatch(projectSearchSync, /handleSearchDrain[\s\S]*?!searchSyncEnabled\(this\.env\)/, "ProjectGuard search drain must be inert when sync mode is off");
requireMatch(searchSyncGuard, /\/wake[\s\S]*?!searchSyncEnabled\(this\.env\)/, "SearchSyncGuard wake must be inert when sync mode is off");
requireMatch(searchSyncGuard, /async alarm\(\)[\s\S]*?!searchSyncEnabled\(this\.env\)/, "SearchSyncGuard alarm must be inert when sync mode is off");
rejectMatch(projectSearchSync, /searchWakeKnownArmed/, "ProjectGuard must not cache cross-DO alarm state across sync mode transitions");

const statusMethod = projectSearchSync.match(/private async handleSearchSyncStatus\(\): Promise<Response> \{([\s\S]*?)\n  \}\n\n  private async handleSearchReconcile/);
if (!statusMethod) {
  failures.push("ProjectGuard search status handler must remain identifiable for observation-only audit");
} else {
  rejectMatch(statusMethod[1], /requestCanonical|ensureSearchWakeupSafely|startSearchWakeup|restartSearchDocumentEpoch/, "GET search-sync-status must be strictly observation-only");
}

requireMatch(productionWorker, /\/v1\/admin\/search\/shadow/, "production worker must expose the operator shadow search route");
requireMatch(productionWorker, /\/v1\/admin\/search\/shadow[\s\S]*?authorized\(request, env\)/, "operator shadow search must require ingress authentication");
requireMatch(
  productionWorker,
  /(?:typeof env\.INGRESS_TOKEN === "string"[\s\S]*?env\.INGRESS_TOKEN\.length > 0|typeof env\.INGRESS_TOKEN !== "string"[\s\S]*?env\.INGRESS_TOKEN\.length === 0)/,
  "production ingress authentication must reject missing or empty tokens before comparison"
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`INDEX001 remediation gate: ${failure}`);
  process.exit(1);
}

console.log("INDEX001 deployment remediation static gate passed.");
