import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import { renderOperating } from "../src/render/operating";

describe("cross-project session routing contract", () => {
  it("keeps PROJECT_SESSION binding separate from sending input to another project", () => {
    const state = emptyProjectState("PRJ-3902", "Source Project", "source-project", "Exercise session routing");
    const operating = renderOperating(state);

    expect(operating).toContain("## Project-session isolation and cross-project routing");
    expect(operating).toContain("must not change its primary project unless the user explicitly asks to switch");
    expect(operating).toContain("Mentioning another project does not authorize rebinding");
    expect(operating).toContain("Ambiguous acknowledgements such as `go ahead`, `ok`, `do it`, or `continue` never authorize rebinding");
    expect(operating).toContain("route the information to the target project's `INPUTS/` without changing the current session binding");
    expect(operating).toContain("Do not load the target project's HANDOFF.md or STATE.md merely to deliver the referral");
    expect(operating).toContain("A routed input is evidence/request material, not automatically accepted canonical truth in the target project");
  });
});
