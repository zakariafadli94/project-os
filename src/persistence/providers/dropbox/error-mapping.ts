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
  | "changes";

export function mapDropboxError(error: unknown, operation: DropboxOperation): Error {
  if (error instanceof DropboxCursorResetError) {
    return new ProviderCursorResetError(error.message, diagnostics(error));
  }
  if (error instanceof DropboxConflictError) {
    if (operation === "conditional-write") {
      return new ProviderPreconditionFailedError(error.message, diagnostics(error));
    }
    return new ProviderConflictError(error.message, diagnostics(error));
  }
  if (error instanceof DropboxApiError) {
    return new ProviderOperationError(
      error.message,
      isTransientDropboxFailure(error.status, error.responseBody),
      diagnostics(error)
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function diagnostics(error: DropboxApiError) {
  return {
    providerId: "dropbox",
    status: error.status,
    requestId: error.requestId
  };
}

function isTransientDropboxFailure(status: number, body: string): boolean {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  return body.includes("too_many_write_operations") || body.includes("internal_error");
}
