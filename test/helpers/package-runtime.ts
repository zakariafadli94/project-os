import type { ProjectOsPersistenceRuntime } from "../../src/persistence/provider/capabilities";
import { ProviderConflictError, ProviderPreconditionFailedError } from "../../src/persistence/provider/errors";
import { sha256Text } from "../../src/documents/hash";

export function packageRuntime() {
  const files = new Map<string, { content: string; id: string; rev: string }>();
  const effects: string[] = [];
  let sequence = 0;
  const put = (path: string, content: string) => { const previous = files.get(path); files.set(path, { content, id: previous?.id ?? `id:file${++sequence}`, rev: `rev${++sequence}` }); };
  const metadata = async (path: string) => { const f = files.get(path); return f ? { path, objectId: f.id, revisionToken: f.rev, size: new TextEncoder().encode(f.content).length, integrityHash: { algorithm: "sha256", value: await sha256Text(f.content) } } : null; };
  const runtime: ProjectOsPersistenceRuntime = {
    providerId: "test",
    objects: {
      readText: async (path) => files.get(path)?.content ?? null,
      readBytes: async (path) => files.has(path) ? new TextEncoder().encode(files.get(path)!.content) : null,
      createText: async (path, content) => { if (files.has(path)) throw new ProviderConflictError("exists"); put(path, content); effects.push(`create:${path}`); },
      upsertText: async (path, content) => { put(path, content); },
      getMetadata: metadata, listChildren: async () => [],
      move: async () => { throw new Error("unguarded move forbidden"); },
      delete: async () => { throw new Error("unguarded delete forbidden"); },
      deleteIfUnchanged: async (path, expected) => { const f = files.get(path); if (!f) return "missing"; if (f.id !== expected.objectId || f.rev !== expected.revisionToken) return "changed"; files.delete(path); effects.push(`delete:${path}`); return "deleted"; }
    },
    conditionalWrite: { writeTextConditional: async (path, content, rev) => { if (files.get(path)?.rev !== rev) throw new ProviderPreconditionFailedError("changed"); put(path, content); effects.push(`write:${path}`); return (await metadata(path))!; } },
    serverSideCopy: { copyObject: async (from, to) => { if (files.has(to)) throw new ProviderConflictError("exists"); const f = files.get(from); if (!f) throw new Error("missing source"); put(to, f.content); effects.push(`copy:${from}->${to}`); return (await metadata(to))!; } },
    changeFeed: { listChanges: async () => ({ entries: [], cursor: "test" }) },
    evidence: { stableObjectId: { semantics: "stable-through-move" }, revisionToken: { semantics: "opaque-object-revision" }, integrityHash: { semantics: "identified-algorithm" } }
  };
  runtime.serverSideCopy.copyObjectVersion = async (from, to, expected) => {
    const f = files.get(from);
    if (!f || f.id !== expected.objectId || f.rev !== expected.revisionToken || await sha256Text(f.content) !== expected.contentSha256) throw new ProviderPreconditionFailedError("source changed");
    if (files.has(to)) throw new ProviderConflictError("exists");
    put(to, f.content); effects.push(`copy:${from}->${to}`);
    return { source: { ...expected }, destination: (await metadata(to))! };
  };
  return { runtime, files, effects, put };
}
