import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index-mutation-gate";
import type { Env } from "../src/env";
import { verifyDropboxSignature } from "../src/webhook/dropbox";

const testEnv = env as unknown as Env;

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

function webhookRequest(body: string): Promise<Request> {
  return signature(testEnv.DROPBOX_APP_SECRET, body).then((sig) => new Request("https://example.com/dropbox/webhook", {
    method: "POST",
    headers: { "x-dropbox-signature": sig },
    body
  }));
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

describe("Dropbox webhook durable handoff", () => {
  it("does not return HTTP 200 when durable change notification handoff fails", async () => {
    const body = '{"list_folder":{"accounts":["dbid:test"]}}';
    let notifyCalls = 0;
    const failingEnv = {
      ...testEnv,
      DROPBOX_CHANGE_GUARD: {
        getByName: () => ({
          fetch: async () => {
            notifyCalls += 1;
            return Response.json({ error: "durable_handoff_failed" }, { status: 503 });
          }
        })
      }
    } as unknown as Env;

    const response = await worker.fetch(await webhookRequest(body), failingEnv, createExecutionContext());
    expect(notifyCalls).toBe(1);
    expect(response.status).not.toBe(200);
  });

  it("awaits the durable handoff before acknowledging a valid webhook", async () => {
    const body = '{"list_folder":{"accounts":["dbid:test"]}}';
    let notifyCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gatedEnv = {
      ...testEnv,
      DROPBOX_CHANGE_GUARD: {
        getByName: () => ({
          fetch: async () => {
            notifyCalls += 1;
            await gate;
            return Response.json({ status: "registered", requested_generation: 1 });
          }
        })
      }
    } as unknown as Env;

    let settled = false;
    const responsePromise = worker.fetch(await webhookRequest(body), gatedEnv, createExecutionContext());
    responsePromise.finally(() => { settled = true; }).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notifyCalls).toBe(1);
    expect(settled).toBe(false);

    release();
    const response = await responsePromise;
    expect(response.status).toBe(200);
  });
});