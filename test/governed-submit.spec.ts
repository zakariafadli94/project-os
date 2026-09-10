import { describe, expect, it } from "vitest";
import { executeGovernedSubmission } from "../src/admission/governed-submit";

describe("governed submission service", () => {
  it("exposes the shared admission entrypoint", () => {
    expect(executeGovernedSubmission).toBeTypeOf("function");
  });
});
