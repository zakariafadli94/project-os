import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const testCompat = (path: string) => fileURLToPath(new URL(`./test/compat/src/dropbox/${path}.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "../src/dropbox/client", replacement: testCompat("client") },
      { find: "../src/dropbox/layout", replacement: testCompat("layout") },
      { find: "../src/dropbox/repository", replacement: testCompat("repository") }
    ]
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          DROPBOX_APP_KEY: "test-app-key",
          DROPBOX_APP_SECRET: "test-app-secret",
          DROPBOX_REFRESH_TOKEN: "test-refresh-token",
          INGRESS_TOKEN: "test-ingress-token",
          PROJECT_OS_SCHEMA_WRITER_STAGE: "v1_only"
        }
      }
    })
  ],
  test: {
    include: ["test/**/*.spec.ts"]
  }
});
