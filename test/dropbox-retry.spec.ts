import { afterEach, describe, expect, it, vi } from "vitest";
import { DropboxApiError, DropboxClient, DropboxConflictError } from "../src/persistence/providers/dropbox/client";
import { mapDropboxError } from "../src/persistence/providers/dropbox/error-mapping";
import {
  ProviderConflictError,
  ProviderOperationError,
  ProviderPreconditionFailedError
} from "../src/persistence/provider/errors";

afterEach(() => vi.useRealTimers());

describe("Dropbox provider error mapping", () => {
  it("preserves Retry-After seconds and HTTP-date values but ignores invalid hints", () => {
    const client = new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "token" });
    const toMappedError = (retryAfter: string) => mapDropboxError(
      (client as any).errorFromResponse("busy", new Response("busy", { status: 503, headers: { "retry-after": retryAfter } }), "busy"),
      "read"
    );

    expect(toMappedError("90")).toMatchObject({ diagnostics: { retryAfterMs: 90_000 } });
    expect(toMappedError("999999999")).toMatchObject({ diagnostics: { retryAfterMs: 86_400_000 } });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T10:00:00.000Z"));
    expect(toMappedError("Thu, 24 Sep 2026 10:02:00 GMT")).toMatchObject({ diagnostics: { retryAfterMs: 120_000 } });
    expect(toMappedError("not-a-date")).not.toHaveProperty("diagnostics.retryAfterMs");
    vi.useRealTimers();
  });

  it("preserves Retry-After on a transient Dropbox write-pressure conflict", () => {
    const pressure = Object.assign(
      new DropboxConflictError("busy", "req-write", "too_many_write_operations"),
      { retryAfterMs: 90_000 }
    );
    expect(mapDropboxError(pressure, "create")).toMatchObject({
      retryable: true,
      diagnostics: { status: 409, retryAfterMs: 90_000 }
    });
  });

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
