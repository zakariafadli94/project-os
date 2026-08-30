import { describe, expect, it } from "vitest";
import {
  ManagedDocumentIdentityConflictError,
  enforceManagedMarkdownIdentity
} from "../src/documents/identity-frontmatter";

const identity = {
  projectId: "PRJ-0003",
  documentId: "DOC-08B3524AC1CB4D6AE7079816",
  logicalPath: "strategy/master.md"
};

describe("managed Markdown identity frontmatter", () => {
  it("prepends authoritative project and document identity when frontmatter is absent", () => {
    const rendered = enforceManagedMarkdownIdentity("# Strategy\n\nBody\n", identity);

    expect(rendered).toBe(
      "---\n"
      + "project_id: PRJ-0003\n"
      + "document_id: DOC-08B3524AC1CB4D6AE7079816\n"
      + "---\n"
      + "# Strategy\n\nBody\n"
    );
  });

  it("injects missing identity into existing frontmatter while preserving other metadata", () => {
    const source = [
      "---",
      "task_id: TASK-METHOD001",
      "document_status: REVIEW",
      "---",
      "# Revenue model",
      ""
    ].join("\n");

    const rendered = enforceManagedMarkdownIdentity(source, identity);

    expect(rendered).toContain("project_id: PRJ-0003\n");
    expect(rendered).toContain("document_id: DOC-08B3524AC1CB4D6AE7079816\n");
    expect(rendered).toContain("task_id: TASK-METHOD001\n");
    expect(rendered).toContain("document_status: REVIEW\n");
  });

  it("is idempotent when authoritative identity is already present", () => {
    const source = [
      "---",
      "project_id: PRJ-0003",
      "document_id: DOC-08B3524AC1CB4D6AE7079816",
      "task_id: TASK-METHOD001",
      "---",
      "# Revenue model",
      ""
    ].join("\n");

    const rendered = enforceManagedMarkdownIdentity(source, identity);

    expect(rendered).toBe(source);
    expect(rendered.match(/^project_id:/gm)).toHaveLength(1);
    expect(rendered.match(/^document_id:/gm)).toHaveLength(1);
  });

  it("rejects a mismatching visible project_id", () => {
    const source = "---\nproject_id: PRJ-9999\n---\n# Strategy\n";

    expect(() => enforceManagedMarkdownIdentity(source, identity)).toThrowError(
      expect.objectContaining<Partial<ManagedDocumentIdentityConflictError>>({
        code: "PROJECT_IDENTITY_MISMATCH"
      })
    );
  });

  it("rejects a mismatching visible document_id", () => {
    const source = "---\nproject_id: PRJ-0003\ndocument_id: DOC-AAAAAAAAAAAAAAAAAAAAAAAA\n---\n# Strategy\n";

    expect(() => enforceManagedMarkdownIdentity(source, identity)).toThrowError(
      expect.objectContaining<Partial<ManagedDocumentIdentityConflictError>>({
        code: "DOCUMENT_IDENTITY_MISMATCH"
      })
    );
  });

  it("leaves non-Markdown content byte-identical", () => {
    const source = "project_id: user-data\nraw payload\n";

    expect(enforceManagedMarkdownIdentity(source, {
      ...identity,
      logicalPath: "strategy/master.txt"
    })).toBe(source);
  });
});
