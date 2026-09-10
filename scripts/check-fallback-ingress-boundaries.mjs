import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fallbackDirectory = join(root, "src", "fallback");
const mutationGatePath = join(root, "src", "index-mutation-gate.ts");
const wranglerPath = join(root, "wrangler.jsonc");
const violations = [];

for (const file of tsFiles(fallbackDirectory)) {
  const text = readFileSync(file, "utf8");
  const relative = file.slice(root.length + 1);
  forbid(text, /\bFallbackIngressGuard\b/, `${relative}: prohibited fallback Durable Object`);
  forbid(text, /(?:persistence\/providers\/dropbox|dropbox\/(?:client|repository|transport)|DropboxClient)/, `${relative}: direct Dropbox runtime`);
  forbid(text, /\bconsole\s*\./, `${relative}: fallback plaintext console output`);
}

const gate = readFileSync(mutationGatePath, "utf8");
const wrangler = readFileSync(wranglerPath, "utf8");
forbid(gate, /\bFallbackIngressGuard\b/, "MutationGate: prohibited fallback Durable Object");
forbid(gate, /(?:persistence\/providers\/dropbox|dropbox\/(?:client|repository|transport)|DropboxClient)/, "MutationGate: direct Dropbox runtime");
forbid(gate, /\bconsole\s*\./, "MutationGate: fallback plaintext console output");
forbid(wrangler, /FallbackIngressGuard|FALLBACK_INGRESS_GUARD/, "wrangler: fallback Durable Object binding");
requireText(gate, "baseWorker.fetch(new Request(\"https://fallback-ingress.internal/v1/transactions\"", "fallback transaction must use ordinary ingress");
forbid(gate, /fallback-ingress[\s\S]*?(?:executeTransactionWithContinuity|PROJECT_GUARD\.getByName\([^)]*\)\.fetch\([^\n]*\/transaction)/, "fallback direct durable transaction path");

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("Fallback ingress boundary check passed");

function forbid(text, pattern, label) {
  if (pattern.test(text)) violations.push(label);
}

function requireText(text, expected, label) {
  if (!text.includes(expected)) violations.push(`Missing invariant: ${label}`);
}

function tsFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}
