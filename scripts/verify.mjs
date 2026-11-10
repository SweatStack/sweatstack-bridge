#!/usr/bin/env node
// Makes one Garmin sign-in link and a walk to import, for Garmin's partner verification. Run it once for
// each Garmin account. RUNBOOK.md, "Pass Garmin's verification", has the steps.
// `--origin https://...` overrides the address found through Cloudflare.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { unstable_readConfig } from "wrangler";
import { CloudflareProblem, findOrigin } from "./lib/cloudflare.mjs";
import { RUNBOOK_SECTION, verificationSignIn } from "./lib/verify.mjs";
import { walk } from "./lib/walk.mjs";
import { wrangler } from "./lib/wrangler.mjs";

const WALK_FILE = "verification-walk.fit";

function stop(message) {
  console.error(message);
  process.exit(1);
}

function utc(seconds) {
  return `${new Date(seconds * 1000).toISOString().slice(11, 16)} UTC`;
}

/** A link that leads nowhere is answered 400 by a bridge that's ready, and 503 by one whose settings aren't complete. */
async function checkReady(origin) {
  const response = await fetch(`${origin}/start/garmin_connect/none`, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (response === null) stop(`The bridge doesn't answer at ${origin}. Is it deployed, at this address?`);
  if (response.status === 503) stop("The bridge's settings aren't complete. Run npm run status to see which.");
  if (response.status !== 400) stop(`The address ${origin} answers ${response.status}, so the bridge isn't there. Is it deployed?`);
}

const config = unstable_readConfig({ config: "wrangler.jsonc" });
const origin = await findOrigin(config).catch((error) => {
  if (!(error instanceof CloudflareProblem)) throw error;
  stop(error.message);
});
await checkReady(origin);

const signIn = verificationSignIn({ now: Math.floor(Date.now() / 1000) });
wrangler(["d1", "execute", "DB", "--remote", "--yes", "--command", signIn.sql], { capture: true });
const walkFile = resolve(WALK_FILE);
writeFileSync(walkFile, walk(new Date()));

console.log(`Garmin's partner verification, for ${config.name}

Your app works without this verification. Until it passes, Garmin shows
your athletes that your app is unverified.

1. Open this link in a private browser window. It works once, until ${utc(signIn.expiresAt)}.
   Do not share it.

   ${origin}${signIn.path}

2. Sign in to Garmin with the account to connect. Allow all permissions.
3. When the steps say so, import this walk at https://connect.garmin.com/app/import-data:

   ${walkFile}

The steps: ${RUNBOOK_SECTION}`);
