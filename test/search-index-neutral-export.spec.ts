import { describe, expect, it } from "vitest";
import { SearchIndexGuard } from "../src/index-neutral";

describe("neutral worker search index export", () => {
  it("exports SearchIndexGuard from the neutral worker entrypoint", () => {
    expect(SearchIndexGuard).toBeTypeOf("function");
  });
});
