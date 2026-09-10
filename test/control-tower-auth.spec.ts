import { describe, expect, it } from "vitest";
import { ALLOWED_EMAIL, authorizeGithubIdentity, grantedScopes } from "../src/control-tower/auth";

describe("Control Tower OAuth policy", () => {
  it("allows only the normalized founder identity", () => {
    expect(ALLOWED_EMAIL).toBe("zakaria.fadli.94@gmail.com");
    expect(authorizeGithubIdentity("Zakaria.Fadli.94@GMAIL.COM")).toEqual({
      email: ALLOWED_EMAIL,
      scopes: ["project.read", "project.mutate"]
    });
    expect(authorizeGithubIdentity("other@example.com")).toBeNull();
  });

  it("never grants mutation without the read scope", () => {
    expect(grantedScopes(["project.mutate"])).toEqual([]);
    expect(grantedScopes(["project.read", "project.mutate"])).toEqual(["project.read", "project.mutate"]);
  });
});
