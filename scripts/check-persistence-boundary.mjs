import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const srcRoot = join(root, "src");
const allowedRuntime = [
  "src/persistence/providers/dropbox/",
  "src/persistence/production-factory.ts",
  "src/webhook/dropbox.ts"
];
const forbiddenTokens = [
  "DropboxClient",
  "DropboxTransport",
  "DropboxConflictError",
  "DropboxApiError",
  "DropboxCursorResetError",
  "ResilientDropboxTransport"
];
const violations = [];
let dropboxClientConstructions = 0;

for (const file of await tsFiles(srcRoot)) {
  const rel = relative(root, file).split(sep).join("/");
  const text = await readFile(file, "utf8");
  const allowed = allowedRuntime.some((prefix) => rel === prefix || rel.startsWith(prefix));
  if (!allowed) {
    for (const token of forbiddenTokens) {
      if (text.includes(token)) violations.push(`${rel}: forbidden runtime token ${token}`);
    }
  }
  if (
    rel === "src/persistence/compatibility/dropbox-v1-evidence.ts"
    && /providers\/dropbox|dropbox\/(?:client|retry|resilient-transport)/.test(text)
  ) {
    violations.push(`${rel}: compatibility seam imports Dropbox runtime`);
  }

  const constructions = text.match(/new\s+DropboxClient\s*\(/g)?.length ?? 0;
  dropboxClientConstructions += constructions;
  if (constructions > 0 && rel !== "src/persistence/production-factory.ts") {
    violations.push(`${rel}: DropboxClient construction must be centralized in production-factory.ts`);
  }
}

if (dropboxClientConstructions !== 1) {
  violations.push(`expected exactly one DropboxClient construction, found ${dropboxClientConstructions}`);
}

for (const file of [
  ...await tsFiles(srcRoot),
  ...await filesWithExtension(join(root, "docs"), ".md"),
  join(root, "package.json")
]) {
  const rel = relative(root, file).split(sep).join("/");
  const text = await readFile(file, "utf8");
  if (text.includes("PROJECT_OS_PROVIDER")) {
    violations.push(`${rel}: provider selector is forbidden in IMP-PERSIST001`);
  }
}

const wrangler = await readFile(join(root, "wrangler.jsonc"), "utf8");
if (/"PROJECT_OS_MUTATION_GATE_MODE"\s*:\s*"enforce"/.test(wrangler)) {
  violations.push("wrangler.jsonc: MutationGate production mode must remain observe");
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("Persistence boundary check passed");

async function tsFiles(dir) {
  return filesWithExtension(dir, ".ts");
}

async function filesWithExtension(dir, extension) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesWithExtension(path, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) out.push(path);
  }
  return out;
}
