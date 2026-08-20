import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          DROPBOX_APP_KEY: "test-app-key",
          DROPBOX_APP_SECRET: "test-app-secret",
          DROPBOX_REFRESH_TOKEN: "test-refresh-token",
          INGRESS_TOKEN: "test-ingress-token"
        }
      }
    })
  ],
  test: {
    include: ["test/**/*.spec.ts"]
  }
});
