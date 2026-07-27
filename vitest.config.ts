import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      // Bindings come from the real wrangler config, so a test runs against the
      // same D1 and Durable Object wiring that gets deployed.
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // The shipped migrations, applied per test file in test/setup.ts. If a
          // migration breaks a query, it breaks here rather than in production.
          TEST_MIGRATIONS: await readD1Migrations(path.join(root, "migrations")),

          // Fixture secrets, overriding anything wrangler picked up from
          // .dev.vars. A test run must never hold the production encryption key
          // or app secret; test/setup.ts refuses to run if these don't win.
          ENCRYPTION_KEY: "test-encryption-key",
          DASHBOARD_PASSWORD: "test-dashboard-password",
          META_APP_SECRET: "test-meta-app-secret",
          INSTAGRAM_APP_ID: "test-instagram-app-id",
          INSTAGRAM_APP_SECRET: "test-instagram-app-secret",
          META_VERIFY_TOKEN: "test-verify-token",
          OPERATOR_EMAIL: "operator@example.test",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
