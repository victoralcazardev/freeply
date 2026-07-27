import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as WorkerEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** Injected by vitest.config.ts and applied in test/setup.ts. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
