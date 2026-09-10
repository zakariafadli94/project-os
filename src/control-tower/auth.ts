export const ALLOWED_EMAIL = "zakaria.fadli.94@gmail.com";
export const SUPPORTED_SCOPES = ["project.read", "project.mutate"] as const;

export type ControlTowerPrincipal = {
  email: typeof ALLOWED_EMAIL;
  scopes: string[];
};

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
