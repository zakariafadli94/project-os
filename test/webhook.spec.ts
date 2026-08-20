import { describe, expect, it } from "vitest";
import { verifyDropboxSignature } from "../src/webhook/dropbox";

async function signature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("Dropbox webhook signature", () => {
  it("accepts the exact valid HMAC-SHA256 signature", async () => {
    const body = '{"list_folder":{"accounts":["dbid:test"]}}';
    const sig = await signature("test-app-secret", body);
    expect(await verifyDropboxSignature("test-app-secret", body, sig)).toBe(true);
  });

  it("rejects a modified body or malformed signature", async () => {
    const body = '{"list_folder":{"accounts":["dbid:test"]}}';
    const sig = await signature("test-app-secret", body);
    expect(await verifyDropboxSignature("test-app-secret", `${body}x`, sig)).toBe(false);
    expect(await verifyDropboxSignature("test-app-secret", body, "not-hex")).toBe(false);
  });
});
