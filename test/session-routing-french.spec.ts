import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { renderOperating } from "../src/render/operating";

describe("French cross-project acknowledgement routing", () => {
  it("does not treat vas-y or fais-le as project rebinding authorization", () => {
    const state = emptyProjectState("PRJ-3903", "Projet source", "projet-source", "Test French routing");
    const operating = renderOperating(state);
    expect(operating).toContain("`vas-y`");
    expect(operating).toContain("`fais-le`");
    expect(operating).toContain("never authorize rebinding");
  });
});
