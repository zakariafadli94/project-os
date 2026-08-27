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
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("Persistence boundary check passed");

async function tsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await tsFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}
