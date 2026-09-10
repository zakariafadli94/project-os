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
          PROJECT_OS_SCHEMA_WRITER_STAGE: "v1_only",
          PROJECT_OS_SEARCH_READ_MODE: "on",
          PROJECT_OS_SEARCH_SYNC_MODE: "on",
          PROJECT_OS_ADMISSION_PROJECT_MODES: JSON.stringify({
            "PRJ-9981": "strict",
            "PRJ-9982": "strict",
            "PRJ-9983": "strict",
            "PRJ-9984": "strict",
            "PRJ-9986": "strict",
            "PRJ-9987": "strict"
          }),
          MUTATION_CONTEXT_SIGNING_KEY: "synthetic-context-secret-for-vitest-only"
        }
      }
    })
  ],
  test: {
    include: ["test/**/*.spec.ts"],
    exclude: ["test/search-sync-off.spec.ts"],
    // Cloudflare test bindings include durable state and the Dropbox adapter
    // installs a process-wide fetch interceptor. File-level parallelism lets
    // otherwise isolated fixtures race over those shared test-only resources.
    fileParallelism: false
  }
});
