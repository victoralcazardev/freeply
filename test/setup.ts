import { applyD1Migrations, env } from "cloudflare:test";
import { FIXTURE_SECRETS } from "./fixtures";

// .dev.vars holds a live Instagram app secret and the key that decrypts stored
// access tokens. vitest.config.ts overrides both with fixtures; if that override
// ever stops winning, stop rather than run the suite against real credentials.
for (const name of Object.keys(FIXTURE_SECRETS) as Array<keyof typeof FIXTURE_SECRETS>) {
  if (env[name] !== FIXTURE_SECRETS[name]) {
    throw new Error(
      `${name} is not the test fixture value — tests would run against real secrets. ` +
        "Check the miniflare bindings in vitest.config.ts.",
    );
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
