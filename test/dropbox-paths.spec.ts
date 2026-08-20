import { expect, it } from "vitest";
import { assertSafeSlug, projectRoot } from "../src/dropbox/paths";

it("builds a canonical project path", () => {
  expect(projectRoot("PRJ-0001", "agency")).toBe("/PROJECT_OS/PROJECTS/PRJ-0001-agency");
});

it("rejects traversal and separators in slug", () => {
  expect(() => assertSafeSlug("../../secret")).toThrow();
  expect(() => assertSafeSlug("a/b")).toThrow();
  expect(() => assertSafeSlug("Agency")).toThrow();
});

it("rejects malformed project IDs", () => {
  expect(() => projectRoot("../1", "agency")).toThrow();
});
