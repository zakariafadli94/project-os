/// <reference types="vite/client" />
import sop from "../docs/project-os-sop.md?raw";
import { describe, expect, it } from "vitest";

describe("Project OS SOP encrypted fallback recovery", () => {
  it("defines the connector-outage fallback as a governed recovery path", () => {
    expect(sop).toContain("encrypted fallback ingress");
    expect(sop).toContain("ChatGPT Dropbox connector");
    expect(sop).toContain("GitHub is transport only");
    expect(sop).toContain("Dropbox and ProjectGuard remain canonical");
  });

  it("requires canonical context refresh before fallback transactions and receipt verification after them", () => {
    expect(sop).toContain("project_context");
    expect(sop).toContain("base_revision");
    expect(sop).toContain("transaction_id");
    expect(sop).toContain("committed receipt");
    expect(sop).toContain("refresh canonical context before retrying");
  });

  it("forbids plaintext project data in the GitHub relay and returns to normal canonical reads after recovery", () => {
    expect(sop).toContain("Never place plaintext Project OS project data or transactions in GitHub issue comments");
    expect(sop).toContain("refresh HANDOFF.md and STATE.md");
    expect(sop).toContain("when the ChatGPT Dropbox connector becomes available again");
  });
});
