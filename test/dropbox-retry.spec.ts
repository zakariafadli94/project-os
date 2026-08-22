import { describe, expect, it, vi } from "vitest";
import { isTransientDropboxFailure, retryDropboxWrite } from "../src/dropbox/retry";

describe("Dropbox transient retry policy", () => {
  it("classifies only infrastructure-style failures as transient", () => {
    expect(isTransientDropboxFailure(429, "rate_limit")).toBe(true);
    expect(isTransientDropboxFailure(503, "service unavailable")).toBe(true);
    expect(isTransientDropboxFailure(409, "too_many_write_operations")).toBe(true);
    expect(isTransientDropboxFailure(409, "internal_error")).toBe(true);
    expect(isTransientDropboxFailure(409, "path/conflict/file")).toBe(false);
    expect(isTransientDropboxFailure(403, "insufficient_permissions")).toBe(false);
  });

  it("retries transient failures and returns the first success", async () => {
    const sleep = vi.fn(async (_delayMs: number) => undefined);
    const operation = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409, body: "too_many_write_operations" })
      .mockResolvedValueOnce({ ok: false, status: 503, body: "busy" })
      .mockResolvedValueOnce({ ok: true, status: 200, body: "ok" });

    const result = await retryDropboxWrite(operation, {
      sleep,
      random: () => 0,
      baseDelayMs: 100,
      maxAttempts: 5
    });

    expect(result.ok).toBe(true);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([100, 200]);
  });

  it("does not retry semantic conflicts", async () => {
    const sleep = vi.fn(async (_delayMs: number) => undefined);
    const operation = vi.fn().mockResolvedValue({ ok: false, status: 409, body: "path/conflict/file" });

    const result = await retryDropboxWrite(operation, {
      sleep,
      random: () => 0,
      baseDelayMs: 100,
      maxAttempts: 5
    });

    expect(result.ok).toBe(false);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops after the configured maximum attempts", async () => {
    const sleep = vi.fn(async (_delayMs: number) => undefined);
    const operation = vi.fn().mockResolvedValue({ ok: false, status: 429, body: "rate_limit" });

    const result = await retryDropboxWrite(operation, {
      sleep,
      random: () => 0,
      baseDelayMs: 50,
      maxAttempts: 5
    });

    expect(result.ok).toBe(false);
    expect(operation).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
  });
});
