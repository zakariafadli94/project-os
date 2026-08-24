export interface DropboxTransport {
  upload(path: string, content: string, mode: "add" | "overwrite"): Promise<void>;
  download(path: string): Promise<string | null>;
  move(from: string, to: string): Promise<void>;
  delete?(path: string): Promise<void>;
  listFolder?(path: string): Promise<DropboxEntry[]>;
}

export interface DropboxEntry {
  tag: "file" | "folder" | "deleted";
  name: string;
  path_lower?: string;
  path_display?: string;
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

export interface DropboxCredentials {
  appKey: string;
  appSecret: string;
  refreshToken: string;
}

export class DropboxClient implements DropboxTransport {
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly credentials: DropboxCredentials) {}

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt - 60_000 > now) return this.cachedToken.value;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.credentials.refreshToken
    });
    const basic = btoa(`${this.credentials.appKey}:${this.credentials.appSecret}`);
    const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
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
    let response = await this.uploadRequest(token, path, content, mode);
    if (response.ok) return;

    let text = await response.text();
    if (response.status === 409 && text.includes("not_found")) {
      await this.ensureParentFolders(token, path);
      response = await this.uploadRequest(token, path, content, mode);
      if (response.ok) return;
      text = await response.text();
    }

    if (response.status === 409) {
      throw new DropboxConflictError(`Dropbox upload conflict for ${path}`, response.headers.get("x-dropbox-request-id"), text);
    }
    throw this.errorFromResponse(`Dropbox upload failed for ${path}`, response, text);
  }

  async download(path: string): Promise<string | null> {
    const token = await this.accessToken();
    const response = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({ path })
      }
    });
    if (response.ok) return response.text();
    const text = await response.text();
    if (response.status === 409 && text.includes("not_found")) return null;
    throw this.errorFromResponse(`Dropbox download failed for ${path}`, response, text);
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

  async delete(path: string): Promise<void> {
    const token = await this.accessToken();
    const response = await fetch("https://api.dropboxapi.com/2/files/delete_v2", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path })
    });
    if (response.ok) return;
    const text = await response.text();
    if (response.status === 409 && text.includes("not_found")) return;
    if (response.status === 409) {
      throw new DropboxConflictError(`Dropbox delete conflict for ${path}`, response.headers.get("x-dropbox-request-id"), text);
    }
    throw this.errorFromResponse(`Dropbox delete failed for ${path}`, response, text);
  }

  async listFolder(path: string): Promise<DropboxEntry[]> {
    const token = await this.accessToken();
    const entries: DropboxEntry[] = [];
    let response = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path, recursive: false, include_deleted: false })
    });

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
      response = await fetch("https://api.dropboxapi.com/2/files/list_folder/continue", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ cursor: parsed.cursor })
      });
    }
  }

  private async uploadRequest(token: string, path: string, content: string, mode: "add" | "overwrite"): Promise<Response> {
    return fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({
          path,
          mode,
          autorename: false,
          mute: true,
          strict_conflict: mode === "add"
        })
      },
      body: content
    });
  }

  private async moveRequest(token: string, from: string, to: string): Promise<Response> {
    return fetch("https://api.dropboxapi.com/2/files/move_v2", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from_path: from, to_path: to, autorename: false, allow_ownership_transfer: false })
    });
  }

  private async ensureParentFolders(token: string, filePath: string): Promise<void> {
    const finalSlash = filePath.lastIndexOf("/");
    if (finalSlash <= 0) return;
    const parentPath = filePath.slice(0, finalSlash);
    const parts = parentPath.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current += `/${part}`;
      const response = await fetch("https://api.dropboxapi.com/2/files/create_folder_v2", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ path: current, autorename: false })
      });
      if (response.ok) continue;
      const text = await response.text();
      if (response.status === 409 && text.includes("conflict")) continue;
      throw this.errorFromResponse(`Dropbox create_folder failed for ${current}`, response, text);
    }
  }

  private errorFromResponse(message: string, response: Response, responseBody: string): DropboxApiError {
    return new DropboxApiError(message, response.status, response.headers.get("x-dropbox-request-id"), responseBody);
  }
}
