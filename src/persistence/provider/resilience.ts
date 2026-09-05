import type { PersistenceRuntime } from "./capabilities";
import type { ObjectPersistence } from "./contract";
import { ProviderConflictError, ProviderOperationError } from "./errors";

export interface ProviderResilienceOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export function withProviderResilience(
  runtime: PersistenceRuntime,
  options: ProviderResilienceOptions = {}
): PersistenceRuntime {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const random = options.random ?? Math.random;
  const log = options.log ?? ((entry: Record<string, unknown>) => console.warn("Project OS provider retry", entry));

  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be at least 1");
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new Error("baseDelayMs must be non-negative");
  }

  const retry = async <T>(operation: string, path: string, fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      try {
        return await fn();
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        if (!(error instanceof ProviderOperationError)) throw error;
        if (!error.retryable || attempt === maxAttempts) throw error;

        const exponential = baseDelayMs * (2 ** (attempt - 1));
        const retryAfterMs = exponential + Math.floor(exponential * 0.5 * random());
        log({
          operation,
          path,
          project_id: projectIdFromPath(path),
          provider_id: runtime.providerId,
          attempt,
          duration_ms: durationMs,
          provider_status: error.diagnostics?.status,
          provider_request_id: error.diagnostics?.requestId,
          retry_after_ms: retryAfterMs
        });
        await sleep(retryAfterMs);
      }
    }
    throw new Error("Provider retry loop exhausted unexpectedly");
  };

  const objects: ObjectPersistence = {
    readText: (path) => retry("read", path, () => runtime.objects.readText(path)),
    createText: (path, content) => retry("create", path, () => runtime.objects.createText(path, content)),
    upsertText: (path, content) => retry("upsert", path, () => runtime.objects.upsertText(path, content)),
    getMetadata: (path) => retry("metadata", path, () => runtime.objects.getMetadata(path)),
    listChildren: (path) => retry("list", path, () => runtime.objects.listChildren(path)),
    move: (from, to) => retry("move", `${from} -> ${to}`, async () => {
      try {
        await runtime.objects.move(from, to);
        return;
      } catch (error) {
        if (!(error instanceof ProviderConflictError)) throw error;

        let source: string | null;
        let destination: string | null;
        try {
          source = await objects.readText(from);
          if (source === null) return;
          destination = await objects.readText(to);
        } catch {
          throw error;
        }

        if (destination === source) {
          await objects.delete(from);
          return;
        }
        if (destination !== null) throw error;

        try {
          await objects.createText(to, source);
        } catch (publishError) {
          if (!(publishError instanceof ProviderConflictError)) throw publishError;
          const published = await objects.readText(to);
          if (published !== source) throw error;
        }
        await objects.delete(from);
      }
    }),
    delete: (path) => retry("delete", path, () => runtime.objects.delete(path)),
    ...(runtime.objects.deleteIfUnchanged ? {
      deleteIfUnchanged: (path, expected) => retry(
        "conditional-delete",
        path,
        () => runtime.objects.deleteIfUnchanged!(path, expected)
      )
    } : {})
  };

  return {
    providerId: runtime.providerId,
    objects,
    ...(runtime.conditionalWrite ? {
      conditionalWrite: {
        writeTextConditional: (path, content, expectedRevisionToken) => retry(
          "conditional-write",
          path,
          () => runtime.conditionalWrite!.writeTextConditional(path, content, expectedRevisionToken)
        )
      }
    } : {}),
    ...(runtime.serverSideCopy ? {
      serverSideCopy: {
        copyObject: (from, to) => retry(
          "copy",
          `${from} -> ${to}`,
          () => runtime.serverSideCopy!.copyObject(from, to)
        )
      }
    } : {}),
    ...(runtime.changeFeed ? {
      changeFeed: {
        listChanges: (input) => retry(
          "changes",
          input.root ?? `cursor:${input.cursor ?? "missing"}`,
          () => runtime.changeFeed!.listChanges(input)
        )
      }
    } : {}),
    ...(runtime.directoryProvisioning ? {
      directoryProvisioning: {
        ensureDirectory: (path) => retry(
          "ensure-directory",
          path,
          () => runtime.directoryProvisioning!.ensureDirectory(path)
        )
      }
    } : {}),
    ...(runtime.diagnostics ? { diagnostics: runtime.diagnostics } : {}),
    ...(runtime.evidence ? { evidence: runtime.evidence } : {})
  };
}

function projectIdFromPath(path: string): string | null {
  return path.match(/PRJ-[0-9]{4,}/)?.[0] ?? null;
}
