import { describe, expect, it } from "vitest";
import { asProjectOsPersistence } from "../src/persistence/compatibility/legacy-dropbox-runtime";
import type { DropboxTransport } from "../src/persistence/providers/dropbox/client";

class ClassBasedTransport implements DropboxTransport {
  private readonly files = new Map<string, string>();

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) throw new Error("conflict");
    this.files.set(path, content);
  }

  async download(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async move(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined) return;
    this.files.set(to, content);
    this.files.delete(from);
  }
}

describe("legacy Dropbox runtime compatibility", () => {
  it("preserves prototype transport methods when adapting a class instance", async () => {
    const runtime = asProjectOsPersistence(new ClassBasedTransport());

    await runtime.objects.createText("/PROJECT_OS/example.txt", "hello");

    await expect(runtime.objects.readText("/PROJECT_OS/example.txt")).resolves.toBe("hello");
  });
});
