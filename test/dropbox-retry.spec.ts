import { describe, expect, it } from "vitest";
import { DropboxApiError, DropboxConflictError } from "../src/persistence/providers/dropbox/client";
import { mapDropboxError } from "../src/persistence/providers/dropbox/error-mapping";
import {
  ProviderConflictError,
  ProviderOperationError,
  ProviderPreconditionFailedError
} from "../src/persistence/provider/errors";

describe("Dropbox provider error mapping", () => {
  it("classifies infrastructure failures as retryable provider operations", () => {
    const rateLimited = mapDropboxError(
      new DropboxApiError("rate limited", 429, "req-rate", "rate_limit"),
      "read"
    );
    const unavailable = mapDropboxError(
      new DropboxApiError("unavailable", 503, "req-503", "service unavailable"),
      "metadata"
    );
    const writePressure = mapDropboxError(
      new DropboxConflictError("busy", "req-write", "too_many_write_operations"),
      "create"
    );

    expect(rateLimited).toBeInstanceOf(ProviderOperationError);
    expect(rateLimited).toMatchObject({ retryable: true });
    expect(unavailable).toBeInstanceOf(ProviderOperationError);
    expect(unavailable).toMatchObject({ retryable: true });
    expect(writePressure).toBeInstanceOf(ProviderOperationError);
    expect(writePressure).toMatchObject({ retryable: true });
  });

  it("keeps semantic conflicts terminal and provider-neutral", () => {
    const conflict = mapDropboxError(
      new DropboxConflictError("exists", "req-conflict", "path/conflict/file"),
      "create"
    );
    const forbidden = mapDropboxError(
      new DropboxApiError("forbidden", 403, "req-403", "insufficient_permissions"),
      "read"
    );

    expect(conflict).toBeInstanceOf(ProviderConflictError);
    expect(forbidden).toBeInstanceOf(ProviderOperationError);
    expect(forbidden).toMatchObject({ retryable: false });
  });

  it("maps conditional-write conflicts to neutral precondition failures", () => {
    const conflict = mapDropboxError(
      new DropboxConflictError("stale rev", "req-cas", "path/conflict/file"),
      "conditional-write"
    );

    expect(conflict).toBeInstanceOf(ProviderPreconditionFailedError);
  });
});
