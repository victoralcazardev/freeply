/**
 * Refuse to deploy Freeply if it is claiming the workspace hostname.
 *
 * cashbuilds.cannappy.org belongs to the `cashbuilds` worker. Both workers listed
 * it once, and Cloudflare gives a contested custom domain to whichever deployed
 * last — so on 2026-08-12 a routine `npm run deploy` here at 14:37 took the
 * hostname back from a cutover completed at 14:28. Nothing errored on either
 * side. The workspace simply started serving this worker's older handlers, and
 * the only way to notice was to read a response body and recognise the shape.
 *
 * The route is now removed from wrangler.jsonc, but that file carries deliberately
 * local edits (database_id, OPERATOR_EMAIL) that are never committed — so the
 * removal is one `git checkout` away from coming back, silently, with the same
 * result. This makes that failure loud at the only moment it matters.
 *
 * Runs from the `predeploy` script, so it cannot be forgotten.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN = "cashbuilds.cannappy.org";
const config = join(dirname(fileURLToPath(import.meta.url)), "..", "wrangler.jsonc");
const text = readFileSync(config, "utf8");

// Only the routes array matters. The hostname appears in prose comments here
// explaining why it is absent, and tripping on those would train people to
// bypass the check — which is worse than not having it.
const routes = /"routes"\s*:\s*\[([\s\S]*?)\]/.exec(text);
const claimed = routes ? routes[1].includes(FORBIDDEN) : false;

if (claimed) {
  console.error(
    `\nRefusing to deploy: wrangler.jsonc claims ${FORBIDDEN} in its routes.\n\n` +
      `That hostname belongs to the cashbuilds worker\n` +
      `(~/Desktop/Projects/cash-builds/worker). Deploying with it listed takes the\n` +
      `workspace back from that worker silently — no error, no warning, the dashboard\n` +
      `just reverts to Freeply's handlers.\n\n` +
      `Remove it from the routes array and deploy again. Freeply keeps\n` +
      `freeply.cannappy.org, which is the hostname tracked links in real DMs carry.\n`,
  );
  process.exit(1);
}

console.log(`routes ok — ${FORBIDDEN} not claimed here`);
