import { readFile } from "node:fs/promises";

const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const publicIngress = await readFile(new URL("../src/index-neutral.ts", import.meta.url), "utf8");
const inboxIngress = await readFile(new URL("../src/inbox/runtime.ts", import.meta.url), "utf8");
const operating = await readFile(new URL("../src/render/operating.ts", import.meta.url), "utf8");
const deployment = await readFile(new URL("../docs/deployment.md", import.meta.url), "utf8");
const dropboxClient = await readFile(new URL("../src/persistence/providers/dropbox/client.ts", import.meta.url), "utf8");
const stagedPublication = await readFile(new URL("../src/artifacts/staged-publication.ts", import.meta.url), "utf8");
const mutationClassifier = await readFile(new URL("../src/mutation-gate/classifier.ts", import.meta.url), "utf8");

const failures = [];
const requireMatch = (value, pattern, message) => {
  if (!pattern.test(value)) failures.push(message);
};
const requireBefore = (value, first, second, message) => {
  const firstIndex = value.indexOf(first);
  const secondIndex = value.indexOf(second);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex >= secondIndex) failures.push(message);
};

requireMatch(config, /"PROJECT_OS_BINARY_ARTIFACT_INGRESS_MODE"\s*:\s*"off"/, "binary artifact ingress must remain disabled by default");
requireMatch(config, /"PROJECT_OS_BINARY_ARTIFACT_MAX_BYTES"\s*:\s*"10485760"/, "binary artifact ingress must retain the reviewed 10 MiB default limit");
requireBefore(publicIngress, "binaryArtifactPolicyViolation(env, artifact)", "routeArtifact(env, artifact)", "public ingress must enforce binary policy before ProjectGuard routing");
requireBefore(inboxIngress, "binaryArtifactPolicyViolation(env, artifact)", "env.PROJECT_GUARD.getByName", "Dropbox inbox must enforce binary policy before ProjectGuard routing");
requireMatch(operating, /OPERATING_CONTRACT_VERSION\s*=\s*3/, "operating contract version 3 must carry the persistence preflight");
requireMatch(operating, /LOCAL_GENERATED → STAGED → SUBMITTED → COMMITTED → CANONICAL_VERIFIED → ACCEPTED/, "operating contract must expose the full artifact evidence chain");
requireMatch(deployment, /enablement is a separate, explicitly authorized production action/i, "deployment guide must separate code delivery from binary ingress activation");
requireMatch(dropboxClient, /deleteIfRevision[\s\S]*?parent_rev:\s*revision/, "staging cleanup must use Dropbox revision-conditioned delete");
requireMatch(stagedPublication, /ensureRollbackEvidence\(request, destinationPath, currentBackup\)/, "replace rollback must persist request-specific evidence before restoration");
requireMatch(mutationClassifier, /machineArtifactReceiptPath\(intent\.request_id\)/, "rollback recognition must reject terminal historical intents");
requireMatch(mutationClassifier, /matchesStagedArtifactRollbackBackup\(evidence, backup\)/, "rollback recognition must verify the exact governed backup identity");
requireMatch(stagedPublication, /evidence\.backup\.revision_token === metadata\.revisionToken/, "rollback backup cleanup must require frozen revision evidence");

if (failures.length > 0) {
  for (const failure of failures) console.error(`Binary artifact ingress gate: ${failure}`);
  process.exit(1);
}

console.log("Binary artifact ingress static gate passed.");
