import { afterEach, expect, it, vi } from "vitest";
import { DropboxClient } from "../src/persistence/providers/dropbox/client";
import { withProviderResilience } from "../src/persistence/provider/resilience";
import { createDropboxPersistence } from "../src/persistence/providers/dropbox/adapter";
afterEach(() => vi.restoreAllMocks());
function client(response: () => Response) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => String(input).includes("oauth2/token")
    ? Response.json({ access_token: "test", expires_in: 3600 }) : response());
  return new DropboxClient({ appKey: "key", appSecret: "secret", refreshToken: "refresh" });
}
it("reads opaque bytes through the provider adapter without text conversion", async () => {
  const raw = client(() => new Response(new Uint8Array([0, 255, 128, 1])));
  const runtime = withProviderResilience(createDropboxPersistence(raw));
  expect(runtime.objects.readBytes).toBeTypeOf("function");
  expect(await runtime.objects.readBytes!("/source", 4)).toEqual(new Uint8Array([0, 255, 128, 1]));
});
it("cancels oversized streaming bodies without trusting content-length", async () => {
  let cancelled = false;
  const raw = client(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(5)); },
    cancel() { cancelled = true; }
  }), { headers: { "content-length": "1" } }));
  await expect(raw.downloadBytes("/source", 4)).rejects.toThrow(/limit/);
  expect(cancelled).toBe(true);
});
