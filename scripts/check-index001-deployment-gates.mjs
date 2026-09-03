import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");

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
requireMatch(config, /"observability"\s*:/, "Workers observability must be prepared in Wrangler config");
requireMatch(config, /"enabled"\s*:\s*true/, "Workers observability must be enabled in prepared config");
requireMatch(config, /"head_sampling_rate"\s*:\s*0\.1/, "Workers observability sampling must be bounded at 0.1");

if (failures.length > 0) {
  for (const failure of failures) console.error(`INDEX001 remediation gate: ${failure}`);
  process.exit(1);
}

console.log("INDEX001 deployment remediation static gate passed.");
