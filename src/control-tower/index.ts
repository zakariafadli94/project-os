import { AuthorizationError, OAuthProvider, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { createControlTowerServer } from "./mcp";
import { ALLOWED_EMAIL, authorizeGithubIdentity, grantedScopes } from "./auth";

type ControlTowerEnv = {
  OAUTH_KV: KVNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  CONTROL_TOWER_PUBLIC_URL: string;
  PROJECT_GUARD: DurableObjectNamespace;
  REGISTRY_GUARD: DurableObjectNamespace;
};

const apiHandler: Pick<Required<ExportedHandler<ControlTowerEnv>>, "fetch"> = {
  fetch(request, env, ctx) {
    return createMcpHandler(() => createControlTowerServer(env))(request, env, ctx);
  }
};

const defaultHandler: ExportedHandler<ControlTowerEnv> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/authorize" && request.method === "GET") return beginAuthorization(request, env);
    if (url.pathname === "/callback" && request.method === "GET") return finishAuthorization(request, env);
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
};

async function beginAuthorization(request: Request, env: ControlTowerEnv): Promise<Response> {
  let authRequest: AuthRequest;
  try {
    authRequest = await (env as ControlTowerEnv & { OAUTH_PROVIDER: { parseAuthRequest(request: Request): Promise<AuthRequest> } }).OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    return new Response(error.description, { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(`github-state:${state}`, JSON.stringify(authRequest), { expirationTtl: 600 });
  const github = new URL("https://github.com/login/oauth/authorize");
  github.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  github.searchParams.set("redirect_uri", `${env.CONTROL_TOWER_PUBLIC_URL}/callback`);
  github.searchParams.set("scope", "read:user user:email");
  github.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      location: github.toString(),
      "set-cookie": `__Host-CONTROL_TOWER_STATE=${state}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`
    }
  });
}

async function finishAuthorization(request: Request, env: ControlTowerEnv): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const cookieState = request.headers.get("cookie")?.match(/(?:^|;\s*)__Host-CONTROL_TOWER_STATE=([^;]+)/)?.[1];
  if (!state || !code || state !== cookieState) return new Response("Invalid OAuth state", { status: 400 });
  const raw = await env.OAUTH_KV.get(`github-state:${state}`);
  await env.OAUTH_KV.delete(`github-state:${state}`);
  if (!raw) return new Response("Expired OAuth state", { status: 400 });
  const authRequest = JSON.parse(raw) as AuthRequest;
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${env.CONTROL_TOWER_PUBLIC_URL}/callback` })
  });
  const token = await tokenResponse.json<{ access_token?: string }>();
  if (!token.access_token) return new Response("GitHub authorization failed", { status: 502 });
  const userResponse = await fetch("https://api.github.com/user/emails", { headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "project-os-control-tower" } });
  const emails = await userResponse.json<Array<{ email?: string; primary?: boolean; verified?: boolean }>>();
  const identity = authorizeGithubIdentity(emails.find((entry) => entry.primary && entry.verified)?.email);
  if (!identity || identity.email !== ALLOWED_EMAIL) return new Response("GitHub identity is not authorized", { status: 403 });
  const provider = (env as ControlTowerEnv & { OAUTH_PROVIDER: { completeAuthorization(args: unknown): Promise<{ redirectTo: string }> } }).OAUTH_PROVIDER;
  const completed = await provider.completeAuthorization({ request: authRequest, userId: identity.email, metadata: { email: identity.email }, scope: grantedScopes(authRequest.scope), props: { email: identity.email } });
  return Response.redirect(completed.redirectTo, 302);
}

const provider = new OAuthProvider<ControlTowerEnv>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["project.read", "project.mutate"],
  resourceMetadata: { resource: "https://project-os-control-tower.zakaria-fadli-94.workers.dev/mcp", authorization_servers: ["https://project-os-control-tower.zakaria-fadli-94.workers.dev"], scopes_supported: ["project.read", "project.mutate"], resource_name: "Project OS Control Tower" },
  clientIdMetadataDocumentEnabled: false
});

export default provider;
