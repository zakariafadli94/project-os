export interface DropboxTransport {
  upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void>;
  download(path: string): Promise<string | null>;
  move(from: string, to: string): Promise<void>;
  delete?(path: string): Promise<void>;
  deleteIfRevision?(path: string, revision: string): Promise<boolean>;
  listFolder?(path: string): Promise<DropboxEntry[]>;
  getMetadata?(path: string): Promise<DropboxFileMetadata | null>;
  uploadConditional?(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata>;
  copy?(from: string, to: string): Promise<DropboxFileMetadata>;
  listFolderChanges?(root?: string, cursor?: string): Promise<DropboxChangePage>;
  ensureDirectory?(path: string): Promise<void>;
  beginRequestTrace?(operation: string): void;
}

export interface DropboxEntry {
  tag: "file" | "folder" | "deleted";
  name: string;
  path_lower?: string;
  path_display?: string;
}

export interface DropboxFileMetadata {
  id: string;
  path: string;
  rev: string;
  content_hash: string;
  size: number;
  server_modified?: string;
}

export interface DropboxChangeEntry {
  tag: "file" | "folder" | "deleted";
  name: string;
  path: string;
  id?: string;
  rev?: string;
  content_hash?: string;
  size?: number;
  server_modified?: string;
}

export interface DropboxChangePage {
  entries: DropboxChangeEntry[];
  cursor: string;
}

export class DropboxApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId: string | null,
    public readonly responseBody: string
  ) {
    super(message);
    this.name = "DropboxApiError";
  }
}

export class DropboxConflictError extends DropboxApiError {
  constructor(message: string, requestId: string | null, responseBody = "") {
    super(message, 409, requestId, responseBody);
    this.name = "DropboxConflictError";
  }
}

export class DropboxCursorResetError extends DropboxApiError {
  constructor(message: string, requestId: string | null, responseBody = "") {
    super(message, 409, requestId, responseBody);
    this.name = "DropboxCursorResetError";
  }
}

export interface DropboxCredentials {
  appKey: string;
  appSecret: string;
  refreshToken: string;
}

type DropboxUploadMode = "add" | "overwrite" | { ".tag": "update"; update: string };
type DropboxFolderCreateResult = "created" | "exists" | "parent_missing";

interface RawDropboxMetadata {
  ".tag"?: string;
  id?: string;
  name?: string;
  path_lower?: string;
  path_display?: string;
  rev?: string;
  content_hash?: string;
  size?: number;
  server_modified?: string;
}

export class DropboxClient implements DropboxTransport {
  private cachedToken: { value: string; expiresAt: number } | null = null;
  private requestIndex = 0;
  private requestOperation: string | null = null;

  constructor(private readonly credentials: DropboxCredentials) {}

  beginRequestTrace(operation: string): void {
    const normalized = operation.trim();
    if (!normalized) throw new Error("Dropbox request trace operation must not be empty");
    this.requestIndex = 0;
    this.requestOperation = normalized;
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt - 60_000 > now) return this.cachedToken.value;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.credentials.refreshToken
    });
    const basic = btoa(`${this.credentials.appKey}:${this.credentials.appSecret}`);
    const response = await this.runtimeFetch("oauth2/token", "https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    const text = await response.text();
    if (!response.ok) throw this.errorFromResponse("Dropbox token refresh failed", response, text);
    const parsed = JSON.parse(text) as { access_token: string; expires_in?: number };
    if (!parsed.access_token) throw new Error("Dropbox token response did not include access_token");
    const ttlMs = Math.max(60, parsed.expires_in ?? 14_400) * 1000;
    this.cachedToken = { value: parsed.access_token, expiresAt: now + ttlMs };
    return parsed.access_token;
  }

  async upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void> {
    const token = await this.accessToken();
    let response = await this.uploadRequest(token, path, content, mode, mode === "add");
    if (response.ok) return;

    let text = await response.text();
    if (response.status === 409 && text.includes("not_found")) {
      await this.ensureParentFolders(token, path);
      response = await this.uploadRequest(token, path, content, mode, mode === "add");
      if (response.ok) return;
      text = await response.text();
    }

    if (response.status === 409) {
      throw new DropboxConflictError(`Dropbox upload conflict for ${path}`, response.headers.get("x-dropbox-request-id"), text);
    }
    throw this.errorFromResponse(`Dropbox upload failed for ${path}`, response, text);
  }

  async uploadConditional(path: string, content: string, expectedRev: string): Promise<DropboxFileMetadata> {
    if (!expectedRev) throw new Error("Dropbox conditional upload requires expectedRev");
    const token = await this.accessToken();
    const response = await this.uploadRequest(
      token,
      path,
      content,
      { ".tag": "update", update: expectedRev },
      true
    );
    const text = await response.text();
    if (response.ok) return parseFileMetadata(JSON.parse(text) as RawDropboxMetadata, path);
    if (response.status === 409) {
      throw new DropboxConflictError(`Dropbox conditional upload conflict for ${path}`, response.headers.get("x-dropbox-request-id"), text);
    }
    throw this.errorFromResponse(`Dropbox conditional upload failed for ${path}`, response, text);
  }

  async download(path: string): Promise<string | null> {
    const token = await this.accessToken();
    const response = await this.runtimeFetch("files/download", "https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({ path })
      }
    }, path);
    if (response.ok) return response.text();
    const text = await response.text();
    if (response.status === 409 && text.includes("not_found")) return null;
    throw this.errorFromResponse(`Dropbox download failed for ${path}`, response, text);
  }

  async getMetadata(path: string): Promise<DropboxFileMetadata | null> {
    const token = await this.accessToken();
    const response = await this.runtimeFetch("files/get_metadata", "https://api.dropboxapi.com/2/files/get_metadata", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path })
    }, path);
    const text = await response.text();
    if (response.ok) return parseFileMetadata(JSON.parse(text) as RawDropboxMetadata, path);
    if (response.status === 409 && text.includes("not_found")) return null;
    throw this.errorFromResponse(`Dropbox metadata lookup failed for ${path}`, response, text);
  }

  async move(from: string, to: string): Promise<void> {
    const token = await this.accessToken();
    let response = await this.moveRequest(token, from, to);
    if (response.ok) return;

    let text = await response.text();
    if (response.status === 409 && text.includes("to/not_found")) {
      await this.ensureParentFolders(token, to);
      response = await this.moveRequest(token, from, to);
      if (response.ok) return;
      text = await response.text();
    }

    if (response.status === 409) {
      throw new DropboxConflictError(`Dropbox move conflict ${from} -> ${to}`, response.headers.get("x-dropbox-request-id"), text);
    }
    throw this.errorFromResponse(`Dropbox move failed ${from} -> ${to}`, response, text);
  }

  async copy(from: string, to: string): Promise<DropboxFileMetadata> {
    const token = await this.accessToken();
    let response = await this.copyRequest(token, from, to);
    let text = await response.text();

    if (response.status === 409 && text.includes("to/not_found")) {
      await this.ensureParentFolders(token, to);
      response = await this.copyRequest(token, from, to);
      text = await response.text();
    }

    if (response.ok) {
      const parsed = JSON.parse(text) as { metadata?: RawDropboxMetadata };
      return parseFileMetadata(parsed.metadata ?? {}, to);
    }
    if (response.status === 409) {
      throw new DropboxConflictError(`Dropbox copy conflict ${from} -> ${to}`, response.headers.get("x-dropbox-request-id"), text);
    }
    throw this.errorFromResponse(`Dropbox copy failed ${from} -> ${to}`, response, text);
  }

  async delete(path: string): Promise<void> {
    const token = await this.accessToken();
    const response = await this.runtimeFetch("files/delete_v2", "https://api.dropboxapi.com/2/files/delete_v2", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path })
    }, path);
    if (response.ok) return;
    const text = await response.text();
    if (response.status === 409 && text.includes("not_found")) return;
    if (response.status === 409) {
      throw new DropboxConflictError(`Dropbox delete conflict for ${path}`, response.headers.get("x-dropbox-request-id"), text);
    }
    throw this.errorFromResponse(`Dropbox delete failed for ${path}`, response, text);
  }

  async deleteIfRevision(path: string, revision: string): Promise<boolean> {
    const token = await this.accessToken();
    const response = await this.runtimeFetch("files/delete_v2", "https://api.dropboxapi.com/2/files/delete_v2", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path, parent_rev: revision })
    }, path);
    if (response.ok) return true;
    const text = await response.text();
    if (response.status === 409 && text.includes("not_found")) return false;
    if (response.status === 409) {
      throw new DropboxConflictError(`Dropbox conditional delete conflict for ${path}`, response.headers.get("x-dropbox-request-id"), text);
    }
    throw this.errorFromResponse(`Dropbox conditional delete failed for ${path}`, response, text);
  }

  async ensureDirectory(path: string): Promise<void> {
    if (!path.startsWith("/") || path === "/") {
      throw new Error(`Dropbox directory path must be an absolute non-root path: ${path}`);
    }
    const token = await this.accessToken();
    const missingDescendants: string[] = [];
    let current = path;

    for (;;) {
      const result = await this.createFolder(token, current);
      if (result !== "parent_missing") break;

      missingDescendants.push(current);
      const parentSlash = current.lastIndexOf("/");
      if (parentSlash <= 0) {
        throw new Error(`Dropbox directory provisioning could not find an existing ancestor for ${path}`);
      }
      current = current.slice(0, parentSlash);
    }

    for (const missingPath of missingDescendants.reverse()) {
      const result = await this.createFolder(token, missingPath);
      if (result === "parent_missing") {
        throw new Error(`Dropbox directory provisioning lost its parent while creating ${missingPath}`);
      }
    }
  }

  async listFolder(path: string): Promise<DropboxEntry[]> {
    const token = await this.accessToken();
    const entries: DropboxEntry[] = [];
    let response = await this.runtimeFetch("files/list_folder", "https://api.dropboxapi.com/2/files/list_folder", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path, recursive: false, include_deleted: false })
    }, path);

    for (;;) {
      const text = await response.text();
      if (!response.ok) {
        if (response.status === 409 && text.includes("not_found")) return [];
        throw this.errorFromResponse(`Dropbox list_folder failed for ${path}`, response, text);
      }
      const parsed = JSON.parse(text) as {
        entries: Array<{ ".tag": DropboxEntry["tag"]; name: string; path_lower?: string; path_display?: string }>;
        cursor: string;
        has_more: boolean;
      };
      for (const entry of parsed.entries) {
        entries.push({ tag: entry[".tag"], name: entry.name, path_lower: entry.path_lower, path_display: entry.path_display });
      }
      if (!parsed.has_more) return entries;
      response = await this.runtimeFetch("files/list_folder/continue", "https://api.dropboxapi.com/2/files/list_folder/continue", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ cursor: parsed.cursor })
      }, path);
    }
  }

  async listFolderChanges(root?: string, cursor?: string): Promise<DropboxChangePage> {
    if ((root && cursor) || (!root && !cursor)) {
      throw new Error("Dropbox change listing requires exactly one of root or cursor");
    }
    const token = await this.accessToken();
    const entries: DropboxChangeEntry[] = [];
    let response = cursor
      ? await this.listFolderContinueRequest(token, cursor)
      : await this.listFolderChangeRequest(token, root!);
    let currentCursor = cursor ?? "";

    for (;;) {
      const text = await response.text();
      if (!response.ok) {
        if (response.status === 409 && text.includes("reset")) {
          throw new DropboxCursorResetError(
            "Dropbox change cursor must be rebuilt",
            response.headers.get("x-dropbox-request-id"),
            text
          );
        }
        if (response.status === 409 && text.includes("not_found") && root) {
          return { entries: [], cursor: currentCursor };
        }
        throw this.errorFromResponse("Dropbox change listing failed", response, text);
      }

      const parsed = JSON.parse(text) as {
        entries: RawDropboxMetadata[];
        cursor: string;
        has_more: boolean;
      };
      currentCursor = parsed.cursor;
      entries.push(...parsed.entries.map(parseChangeEntry));
      if (!parsed.has_more) return { entries, cursor: currentCursor };
      response = await this.listFolderContinueRequest(token, currentCursor);
    }
  }

  private async uploadRequest(
    token: string,
    path: string,
    content: string,
    mode: DropboxUploadMode,
    strictConflict: boolean
  ): Promise<Response> {
    return this.runtimeFetch("files/upload", "https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({
          path,
          mode,
          autorename: false,
          mute: true,
          strict_conflict: strictConflict
        })
      },
      body: content
    }, path);
  }

  private async moveRequest(token: string, from: string, to: string): Promise<Response> {
    return this.runtimeFetch("files/move_v2", "https://api.dropboxapi.com/2/files/move_v2", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from_path: from, to_path: to, autorename: false, allow_ownership_transfer: false })
    }, `${from} -> ${to}`);
  }

  private async copyRequest(token: string, from: string, to: string): Promise<Response> {
    return this.runtimeFetch("files/copy_v2", "https://api.dropboxapi.com/2/files/copy_v2", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from_path: from,
        to_path: to,
        autorename: false,
        allow_shared_folder: false,
        allow_ownership_transfer: false
      })
    }, `${from} -> ${to}`);
  }

  private async listFolderChangeRequest(token: string, root: string): Promise<Response> {
    return this.runtimeFetch("files/list_folder", "https://api.dropboxapi.com/2/files/list_folder", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path: root, recursive: true, include_deleted: true })
    }, root);
  }

  private async listFolderContinueRequest(token: string, cursor: string): Promise<Response> {
    return this.runtimeFetch("files/list_folder/continue", "https://api.dropboxapi.com/2/files/list_folder/continue", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ cursor })
    });
  }

  private async ensureParentFolders(token: string, filePath: string): Promise<void> {
    const finalSlash = filePath.lastIndexOf("/");
    if (finalSlash <= 0) return;
    const parentPath = filePath.slice(0, finalSlash);
    const missingDescendants: string[] = [];
    let current = parentPath;

    for (;;) {
      const result = await this.createFolder(token, current);
      if (result !== "parent_missing") break;

      missingDescendants.push(current);
      const parentSlash = current.lastIndexOf("/");
      if (parentSlash <= 0) {
        throw new Error(`Dropbox parent folder recovery could not find an existing ancestor for ${parentPath}`);
      }
      current = current.slice(0, parentSlash);
    }

    for (const missingPath of missingDescendants.reverse()) {
      const result = await this.createFolder(token, missingPath);
      if (result === "parent_missing") {
        throw new Error(`Dropbox parent folder recovery lost its parent while creating ${missingPath}`);
      }
    }
  }

  private async createFolder(token: string, path: string): Promise<DropboxFolderCreateResult> {
    const response = await this.runtimeFetch("files/create_folder_v2", "https://api.dropboxapi.com/2/files/create_folder_v2", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path, autorename: false })
    }, path);
    if (response.ok) return "created";

    const text = await response.text();
    if (response.status === 409 && text.includes("conflict/folder")) return "exists";
    if (response.status === 409 && text.includes("not_found")) return "parent_missing";
    if (response.status === 409) {
      throw new DropboxConflictError(
        `Dropbox directory conflict for ${path}`,
        response.headers.get("x-dropbox-request-id"),
        text
      );
    }
    throw this.errorFromResponse(`Dropbox create_folder failed for ${path}`, response, text);
  }

  private async runtimeFetch(
    endpoint: string,
    input: RequestInfo | URL,
    init?: RequestInit,
    path?: string
  ): Promise<Response> {
    const requestIndex = ++this.requestIndex;
    try {
      return await fetch(input, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const pathContext = path ? ` for ${path}` : "";
      const operationContext = this.requestOperation ? ` during ${this.requestOperation}` : "";
      throw new Error(`Dropbox HTTP ${endpoint} request #${requestIndex}${pathContext}${operationContext} failed: ${message}`);
    }
  }

  private errorFromResponse(message: string, response: Response, responseBody: string): DropboxApiError {
    return new DropboxApiError(message, response.status, response.headers.get("x-dropbox-request-id"), responseBody);
  }
}

function parseFileMetadata(raw: RawDropboxMetadata, fallbackPath: string): DropboxFileMetadata {
  if (
    !raw.id
    || !raw.rev
    || !raw.content_hash
    || typeof raw.size !== "number"
  ) {
    throw new Error(`Dropbox file metadata incomplete for ${fallbackPath}`);
  }
  return {
    id: raw.id,
    path: raw.path_display ?? raw.path_lower ?? fallbackPath,
    rev: raw.rev,
    content_hash: raw.content_hash,
    size: raw.size,
    ...(raw.server_modified ? { server_modified: raw.server_modified } : {})
  };
}

function parseChangeEntry(raw: RawDropboxMetadata): DropboxChangeEntry {
  const tag = raw[".tag"];
  if (tag !== "file" && tag !== "folder" && tag !== "deleted") {
    throw new Error(`Unsupported Dropbox change entry tag: ${String(tag)}`);
  }
  const path = raw.path_display ?? raw.path_lower;
  if (!raw.name || !path) throw new Error("Dropbox change entry is missing name/path");
  if (tag !== "file") return { tag, name: raw.name, path };
  if (!raw.id || !raw.rev || !raw.content_hash || typeof raw.size !== "number") {
    throw new Error(`Dropbox changed file metadata incomplete for ${path}`);
  }
  return {
    tag,
    name: raw.name,
    path,
    id: raw.id,
    rev: raw.rev,
    content_hash: raw.content_hash,
    size: raw.size,
    ...(raw.server_modified ? { server_modified: raw.server_modified } : {})
  };
}
