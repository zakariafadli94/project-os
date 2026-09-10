import { describe, expect, it } from "vitest";
import { issueMutationContext, verifyMutationContext } from "../src/admission/mutation-context";
import { commitFixture } from "./helpers/convergence-fixture";

describe("signed mutation context", () => {
  it("binds the token to normalized state, project and submitted base", async () => {
    const state = commitFixture("PRJ-9258", 2)[1].state;
    const secret = "synthetic-context-secret-for-vitest-only";
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    const context = await issueMutationContext(state, secret, now);

    expect(Date.parse(context.expiry) - Date.parse(context.observed_at)).toBe(300_000);
    await expect(verifyMutationContext(context, state, 2, secret, now + 1)).resolves.toBeUndefined();
    await expect(verifyMutationContext(context, state, 1, secret, now + 1))
      .rejects.toMatchObject({ code: "mutation_context_stale" });
    await expect(verifyMutationContext(context, state, 2, secret, now + 300_000))
      .rejects.toMatchObject({ code: "mutation_context_expired" });
  });
});
