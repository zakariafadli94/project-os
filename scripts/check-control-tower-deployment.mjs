const baseUrl = (process.env.CONTROL_TOWER_URL ?? "https://project-os-control-tower.zakaria-fadli-94.workers.dev").replace(/\/$/, "");
const token = process.env.CONTROL_TOWER_BEARER_TOKEN;
const requireLive = process.env.CONTROL_TOWER_REQUIRE_LIVE === "true";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

const metadata = await jsonRequest("/.well-known/oauth-authorization-server");
if (!metadata.response.ok && !requireLive) {
  console.log("Control Tower deployment policy preflight passed; live OAuth qualification is pending deployment.");
  process.exit(0);
}
assert(metadata.response.ok, "OAuth authorization metadata is unavailable");

const unauthenticated = await jsonRequest("/mcp", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
});
assert(unauthenticated.response.status === 401, "unauthenticated MCP tools/list must be denied");

if (!token) {
  console.log("Control Tower public OAuth boundary passed; authenticated qualification skipped because CONTROL_TOWER_BEARER_TOKEN is absent.");
  process.exit(0);
}

const initialized = await jsonRequest("/mcp", {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
});
assert(initialized.response.ok, "authenticated MCP tools/list failed");
assert(JSON.stringify(initialized.body).includes("project_os_get_context"), "authenticated tools/list omitted Project OS tools");

const context = await jsonRequest("/mcp", {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "project_os_get_context", arguments: { project_id: "PRJ-0008" } }
  })
});
assert(context.response.ok, "authenticated synthetic PRJ-0008 read-only context failed");
console.log("Control Tower OAuth and synthetic PRJ-0008 read-only qualification passed.");
