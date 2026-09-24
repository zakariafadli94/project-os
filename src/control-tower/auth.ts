export const ALLOWED_EMAIL = "zakaria.fadli.94@gmail.com";
export const SUPPORTED_SCOPES = ["project.read", "project.mutate"] as const;

export type ControlTowerPrincipal = {
  email: typeof ALLOWED_EMAIL;
  scopes: string[];
};

export interface ControlTowerAccess { read: boolean; mutate: boolean }
export class ControlTowerAuthorityUnavailable extends Error {
  constructor() { super("control_tower_authority_unavailable"); }
}

/** Called only behind OAuthProvider's audience/token validation. The effective
 * token scopes may be narrower than the original grant, including old grants. */
export async function resolveTokenAccess(
  request: Request,
  provider: { unwrapToken(token: string): Promise<unknown> }
): Promise<ControlTowerAccess | null> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      provider.unwrapToken(token),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ControlTowerAuthorityUnavailable()), 2_000); })
    ]);
    if (!result || typeof result !== "object" || !("scope" in result) || !Array.isArray(result.scope)
      || !("grant" in result) || !result.grant || typeof result.grant !== "object"
      || !("props" in result.grant) || !result.grant.props || typeof result.grant.props !== "object"
      || !("email" in result.grant.props) || result.grant.props.email !== ALLOWED_EMAIL) return null;
    const scopes = grantedScopes(result.scope.filter((scope): scope is string => typeof scope === "string"));
    return scopes.includes("project.read") ? { read: true, mutate: scopes.includes("project.mutate") } : null;
  } catch {
    throw new ControlTowerAuthorityUnavailable();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function authorizeGithubIdentity(email: string | null | undefined): ControlTowerPrincipal | null {
  const normalized = email?.trim().toLowerCase();
  if (normalized !== ALLOWED_EMAIL) return null;
  return { email: ALLOWED_EMAIL, scopes: [...SUPPORTED_SCOPES] };
}

export function grantedScopes(requested: readonly string[]): string[] {
  const scopes = new Set(requested.filter((scope) => SUPPORTED_SCOPES.includes(scope as (typeof SUPPORTED_SCOPES)[number])));
  if (!scopes.has("project.read")) scopes.delete("project.mutate");
  return SUPPORTED_SCOPES.filter((scope) => scopes.has(scope));
}
