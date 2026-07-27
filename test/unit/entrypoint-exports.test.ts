import { describe, expect, it } from "vitest";
import * as entrypoint from "../../src/index";

/**
 * workerd refuses to start a Worker whose entrypoint module has a named export
 * that isn't a function or an ExportedHandler:
 *
 *   service core:user:freeply: Uncaught TypeError: Incorrect type for map entry
 *   'ICE_BREAKER_PREFIX': the provided value is not of type 'function or
 *   ExportedHandler'.
 *
 * A `export const` string in src/index.ts shipped once and made every deploy fail
 * while the whole suite stayed green — vitest imports the module rather than
 * mounting it as an entrypoint, and `wrangler deploy --dry-run` doesn't start
 * workerd either. Nothing else here catches it, so this does. Constants belong in
 * a module the entrypoint imports.
 */
describe("src/index exports", () => {
  it("exports only functions, which is all workerd will mount", () => {
    const offenders = Object.entries(entrypoint)
      .filter(([name]) => name !== "default")
      .filter(([, value]) => typeof value !== "function")
      .map(([name, value]) => `${name} is a ${typeof value}`);

    expect(offenders).toEqual([]);
  });

  it("still has a default export for Cloudflare to call", () => {
    expect(entrypoint.default).toBeTypeOf("object");
    expect(entrypoint.default.fetch).toBeTypeOf("function");
  });
});
