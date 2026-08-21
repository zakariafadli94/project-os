import { describe, expect, it } from "vitest";
import {
  parseLayoutMode,
  workspaceProjectRoot,
  machineProjectRoot,
  machineReceiptPath,
  workspaceEntityPath
} from "../src/dropbox/layout";

describe("workspace V2 layout", () => {
  it("separates human project views from machine state", () => {
    expect(workspaceProjectRoot("PRJ-0002", "project-os"))
      .toBe("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os");
    expect(machineProjectRoot("PRJ-0002"))
      .toBe("/PROJECT_OS/.project-os/projects/PRJ-0002");
    expect(machineReceiptPath("TXN-ABCDEFGHIJ"))
      .toBe("/PROJECT_OS/.project-os/receipts/TXN-ABCDEFGHIJ.json");
    expect(workspaceEntityPath("PRJ-0002", "project-os", "RESEARCH", "RES-CODE0001"))
      .toBe("/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0002-project-os/RESEARCH/RES-CODE0001.md");
  });

  it("defaults missing layout mode to legacy", () => {
    expect(parseLayoutMode(undefined)).toBe("legacy");
    expect(parseLayoutMode("shadow")).toBe("shadow");
    expect(() => parseLayoutMode("broken")).toThrow("Invalid PROJECT_OS_LAYOUT_MODE");
  });
});
