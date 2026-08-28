import {
  DropboxApiError,
  DropboxConflictError,
  DropboxCursorResetError
} from "./client";
import {
  ProviderConflictError,
  ProviderCursorResetError,
  ProviderOperationError,
  ProviderPreconditionFailedError
} from "../../provider/errors";

export type DropboxOperation =
  | "create"
  | "upsert"
  | "conditional-write"
  | "read"
  | "metadata"
  | "list"
  | "move"
  | "copy"
  | "delete"
  | "changes"
  | "ensure-directory";

export function mapDropboxError(error: unknown, operation: DropboxOperation): Error {
  if (error instanceof DropboxCursorResetError) {
    return new ProviderCursorResetError(error.message, diagnostics(error, operation));
  }
  if (error instanceof DropboxConflictError) {
    if (isTransientDropboxFailure(error.status, error.responseBody)) {
      return new ProviderOperationError(error.message, true, diagnostics(error, operation));
    }
    if (operation === "conditional-write") {
      return new ProviderPreconditionFailedError(error.message, diagnostics(error, operation));
    }
    return new ProviderConflictError(error.message, diagnostics(error, operation));
  }
  if (error instanceof DropboxApiError) {
    return new ProviderOperationError(
      error.message,
      isTransientDropboxFailure(error.status, error.responseBody),
      diagnostics(error, operation)
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function diagnostics(error: DropboxApiError, operation: DropboxOperation) {
  const code = normalizedDropboxCode(error.responseBody);
  return {
    providerId: "dropbox",
    status: error.status,
    requestId: error.requestId,
    ...(code ? { code } : {}),
    operation
  };
}

function normalizedDropboxCode(body: string): string | undefined {
  let summary = body.trim();
  try {
    const parsed = JSON.parse(body) as { error_summary?: unknown };
    if (typeof parsed.error_summary === "string") summary = parsed.error_summary.trim();
  } catch {
    // Fall back to the first safe token of the raw body; never expose the body itself.
  }
  return /^([A-Za-z0-9_-]+)/.exec(summary)?.[1]?.toLowerCase();
}

function isTransientDropboxFailure(status: number, body: string): boolean {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  return body.includes("too_many_write_operations") || body.includes("internal_error");
}
