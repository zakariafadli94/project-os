import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function classifyReadinessResponse(status, bodyText) {
  if (status === 400) {
    try {
      if (JSON.parse(bodyText)?.error === "invalid_project_id") return "ready";
    } catch {
      return "fail";
    }
  }
  if (status === 401 || status === 404) return "retry";
  return "fail";
}

export function classifyRevocationResponse(status) {
  return status === 401 || status === 404 ? "revoked" : "retry";
}

export function classifyPostcheckResponse(status) {
  if (status === 200) return "ready";
  if (status === 401 || status === 404) return "retry";
  return "fail";
}

function runCli(args) {
  const [phase, rawStatus, bodyPath] = args;
  const status = Number(rawStatus);
  if (!Number.isSafeInteger(status)) throw new Error("HTTP status must be an integer");

  if (phase === "readiness") {
    if (!bodyPath) throw new Error("Readiness classification requires a response body path");
    return classifyReadinessResponse(status, readFileSync(bodyPath, "utf8"));
  }
  if (phase === "revocation") return classifyRevocationResponse(status);
  if (phase === "postcheck") return classifyPostcheckResponse(status);
  throw new Error(`Unknown recovery HTTP phase: ${phase ?? ""}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`${runCli(process.argv.slice(2))}\n`);
}
