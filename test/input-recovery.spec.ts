import { describe, expect, it } from "vitest";
import { emptyProjectState } from "../src/domain/transitions";
import type { DropboxEntry, DropboxFileMetadata, DropboxTransport } from "../src/persistence/providers/dropbox/client";
import { DropboxConflictError } from "../src/persistence/providers/dropbox/client";
import { sha256Text } from "../src/documents/hash";
import { InputIntakeService } from "../src/documents/input-intake-service";
import { InputRecoveryService } from "../src/documents/input-recovery";
import { workspaceManagedDocumentPath } from "../src/persistence/layout";
import { persistenceFromDropbox } from "./helpers/persistence-runtime";

class RecoveryDropbox implements DropboxTransport {
  readonly files = new Map<string, string>();
  readonly metadata = new Map<string, DropboxFileMetadata>();
  readonly listCalls: string[] = [];
  failDeletes = 0;
  private nextId = 1;
  private nextRev = 1;

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    if (mode === "add" && this.files.has(path)) {
      throw new DropboxConflictError(`exists ${path}`, "req-upload", "path/conflict/file");
    }
    await this.set(path, content, this.metadata.get(path)?.id);
  }

  async download(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
  async getMetadata(path: string): Promise<DropboxFileMetadata | null> { return this.metadata.get(path) ?? null; }

  async move(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    const meta = this.metadata.get(from);
    if (content === undefined || !meta) throw new DropboxConflictError("missing", "req-move", "from_lookup/not_found");
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req-move", "to/conflict/file");
    this.files.delete(from);
    this.metadata.delete(from);
    await this.set(to, content, meta.id);
  }

  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    const content = this.files.get(from);
    if (content === undefined) throw new DropboxConflictError("missing", "req-copy", "from_lookup/not_found");
    if (this.files.has(to)) throw new DropboxConflictError("exists", "req-copy", "to/conflict/file");
    return this.set(to, content);
  }

  async delete(path: string): Promise<void> {
    if (this.failDeletes > 0) {
      this.failDeletes -= 1;
      throw new Error("simulated delete failure");
    }
    this.files.delete(path);
    this.metadata.delete(path);
  }

  async listFolder(path: string): Promise<DropboxEntry[]> {
    this.listCalls.push(path);
    const prefix = `${path}/`;
    const children = new Map<string, DropboxEntry>();
    for (const candidate of this.files.keys()) {
      if (!candidate.startsWith(prefix)) continue;
      const remainder = candidate.slice(prefix.length);
      if (!remainder) continue;
      const slash = remainder.indexOf("/");
      if (slash === -1) {
        children.set(remainder, { tag: "file", name: remainder, path_display: candidate });
      } else {
        const name = remainder.slice(0, slash);
        children.set(name, { tag: "folder", name, path_display: `${path}/${name}` });
      }
    }
    return [...children.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async put(path: string, content: string): Promise<DropboxFileMetadata> {
    return this.set(path, content, this.metadata.get(path)?.id);
  }

  private async set(path: string, content: string, id?: string): Promise<DropboxFileMetadata> {
    const metadata: DropboxFileMetadata = {
      id: id ?? `id:REC${String(this.nextId++).padStart(6, "0")}`,
      path,
      rev: `rev-${String(this.nextRev++).padStart(6, "0")}`,
      content_hash: await sha256Text(content),
      size: new TextEncoder().encode(content).byteLength,
      server_modified: "2026-08-31T15:50:00.000Z"
    };
    this.files.set(path, content);
    this.metadata.set(path, metadata);
    return metadata;
  }
}

const now = () => "2026-08-31T16:00:00+01:00";

describe("explicit INPUTS recovery", () => {
  it("recursively recovers only files below the selected project INPUTS root", async () => {
    const dropbox = new RecoveryDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const state = emptyProjectState("PRJ-5301", "Recovery One", "recovery-one", "Explicit recovery test");
    const firstInput = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", "legacy/a.md");
    const secondInput = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", "legacy/nested/b.txt");
    const unrelated = workspaceManagedDocumentPath(state.project_id, state.slug, "working", "keep.md");
    await dropbox.put(firstInput, "alpha");
    await dropbox.put(secondInput, "beta");
    await dropbox.put(unrelated, "keep me");

    const result = await new InputRecoveryService(runtime, { now }).recover(state);

    expect(result).toMatchObject({
      scanned: 2,
      completed: 2,
      duplicate_cleaned: 0,
      conflicts: 0,
      withdrawn: 0,
      failed: 0
    });
    expect(dropbox.files.has(firstInput)).toBe(false);
    expect(dropbox.files.has(secondInput)).toBe(false);
    expect(dropbox.files.get(workspaceManagedDocumentPath(state.project_id, state.slug, "references", "UNCLASSIFIED/legacy/a.md"))).toBe("alpha");
    expect(dropbox.files.get(workspaceManagedDocumentPath(state.project_id, state.slug, "references", "UNCLASSIFIED/legacy/nested/b.txt"))).toBe("beta");
    expect(dropbox.files.get(unrelated)).toBe("keep me");
  });

  it("resumes the same intake after reference commit when historical source cleanup failed", async () => {
    const dropbox = new RecoveryDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const state = emptyProjectState("PRJ-5302", "Recovery Two", "recovery-two", "Resume partial intake test");
    const relativePath = "legacy/partial.md";
    const inputPath = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", relativePath);
    const metadata = await dropbox.put(inputPath, "partial source");
    dropbox.failDeletes = 1;

    await expect(new InputIntakeService(runtime, { now }).ingest(state, {
      sourcePath: inputPath,
      relativeInputPath: relativePath,
      metadata: {
        path: metadata.path,
        objectId: metadata.id,
        revisionToken: metadata.rev,
        integrityHash: { algorithm: "dropbox-content-hash", value: metadata.content_hash },
        size: metadata.size,
        modifiedAt: metadata.server_modified
      }
    })).rejects.toThrow("simulated delete failure");
    expect(dropbox.files.has(inputPath)).toBe(true);

    const recovered = await new InputRecoveryService(runtime, { now }).recover(state);
    expect(recovered).toMatchObject({ scanned: 1, completed: 1, failed: 0, conflicts: 0 });
    expect(dropbox.files.has(inputPath)).toBe(false);
    expect(dropbox.files.get(workspaceManagedDocumentPath(
      state.project_id,
      state.slug,
      "references",
      `UNCLASSIFIED/${relativePath}`
    ))).toBe("partial source");
  });

  it("preserves a divergent input as conflict and treats referral-looking text without provenance as unclassified", async () => {
    const dropbox = new RecoveryDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const state = emptyProjectState("PRJ-5303", "Recovery Three", "recovery-three", "Fail-closed recovery test");
    const divergentRelative = "legacy/divergent.md";
    const referralRelative = "legacy/referral-looking.md";
    const divergentInput = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", divergentRelative);
    const divergentTarget = workspaceManagedDocumentPath(state.project_id, state.slug, "references", `UNCLASSIFIED/${divergentRelative}`);
    const referralInput = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", referralRelative);
    await dropbox.put(divergentInput, "source reality");
    await dropbox.put(divergentTarget, "different governed reality");
    await dropbox.put(referralInput, "---\nsource_project_id: PRJ-0003\ntarget_project_id: PRJ-5303\n---\nLooks like a referral, but is not governed.");

    const result = await new InputRecoveryService(runtime, { now }).recover(state);

    expect(result).toMatchObject({ scanned: 2, completed: 1, conflicts: 1, failed: 0 });
    expect(dropbox.files.get(divergentInput)).toBe("source reality");
    expect(dropbox.files.get(divergentTarget)).toBe("different governed reality");
    expect(dropbox.files.has(referralInput)).toBe(false);
    expect(dropbox.files.get(workspaceManagedDocumentPath(
      state.project_id,
      state.slug,
      "references",
      `UNCLASSIFIED/${referralRelative}`
    ))).toContain("Looks like a referral");
  });

  it("does not enumerate or resurrect INPUTS for an archived project", async () => {
    const dropbox = new RecoveryDropbox();
    const runtime = persistenceFromDropbox(dropbox);
    const state = emptyProjectState("PRJ-5304", "Recovery Four", "recovery-four", "Archived recovery test");
    state.status = "archived";
    const inputPath = workspaceManagedDocumentPath(state.project_id, state.slug, "inputs", "legacy.md");
    await dropbox.put(inputPath, "leave archived reality alone");

    const result = await new InputRecoveryService(runtime, { now }).recover(state);

    expect(result).toMatchObject({ scanned: 0, completed: 0, duplicate_cleaned: 0, conflicts: 0, withdrawn: 0, failed: 0 });
    expect(dropbox.listCalls).toEqual([]);
    expect(dropbox.files.get(inputPath)).toBe("leave archived reality alone");
  });
});
