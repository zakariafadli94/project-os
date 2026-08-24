import { DropboxApiError, DropboxConflictError, type DropboxEntry, type DropboxTransport } from "./client";
import { isTransientDropboxFailure } from "./retry";

export interface ResilientDropboxTransportOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export class ResilientDropboxTransport implements DropboxTransport {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly random: () => number;
  private readonly log: (entry: Record<string, unknown>) => void;

  constructor(
    private readonly inner: DropboxTransport,
    options: ResilientDropboxTransportOptions = {}
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.sleep = options.sleep ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    this.random = options.random ?? Math.random;
    this.log = options.log ?? ((entry) => console.warn("Project OS Dropbox retry", entry));
  }

  upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    return this.retry("upload", path, () => this.inner.upload(path, content, mode));
  }

  download(path: string): Promise<string | null> {
    return this.retry("download", path, () => this.inner.download(path));
  }

  listFolder(path: string): Promise<DropboxEntry[]> {
    if (!this.inner.listFolder) throw new Error("Dropbox transport does not support listFolder");
    return this.retry("list_folder", path, () => this.inner.listFolder!(path));
  }

  move(from: string, to: string): Promise<void> {
    return this.retry("move", `${from} -> ${to}`, async () => {
      try {
        await this.inner.move(from, to);
        return;
      } catch (error) {
        if (!(error instanceof DropboxConflictError) || !this.inner.delete) throw error;

        let source: string | null;
        let destination: string | null;
        try {
          source = await this.download(from);
          if (source === null) return;
          destination = await this.download(to);
        } catch {
          throw error;
        }

        if (destination === source) {
          await this.delete(from);
          return;
        }
        if (destination !== null) throw error;

        try {
          await this.upload(to, source, "add");
        } catch (publishError) {
          if (!(publishError instanceof DropboxConflictError)) throw publishError;
          const published = await this.download(to);
          if (published !== source) throw error;
        }
        await this.delete(from);
      }
    });
  }

  delete(path: string): Promise<void> {
    if (!this.inner.delete) throw new Error("Dropbox transport does not support delete");
    return this.retry("delete", path, () => this.inner.delete!(path));
  }

  private async retry<T>(operation: string, path: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      try {
        return await fn();
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        if (!(error instanceof DropboxApiError)) throw error;
        const transient = isTransientDropboxFailure(error.status, error.responseBody);
        if (!transient || attempt === this.maxAttempts) throw error;

        const exponential = this.baseDelayMs * (2 ** (attempt - 1));
        const retryAfterMs = exponential + Math.floor(exponential * 0.5 * this.random());
        this.log({
          operation,
          path,
          project_id: projectIdFromPath(path),
          attempt,
          duration_ms: durationMs,
          dropbox_status: error.status,
          dropbox_request_id: error.requestId,
          retry_after_ms: retryAfterMs
        });
        await this.sleep(retryAfterMs);
      }
    }
    throw new Error("Dropbox retry loop exhausted unexpectedly");
  }
}

function projectIdFromPath(path: string): string | null {
  return path.match(/PRJ-[0-9]{4,}/)?.[0] ?? null;
}
