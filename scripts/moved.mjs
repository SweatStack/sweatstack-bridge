#!/usr/bin/env node
// `npm run status` and `npm run urls` moved to the bridge's console. This says where, for one release.
import { unstable_readConfig } from "wrangler";
import { findOrigin } from "./lib/cloudflare.mjs";

const command = process.argv[2] ?? "this command";
const origin = await findOrigin(unstable_readConfig({ config: "wrangler.jsonc" })).catch(() => null);
console.log(
  `npm run ${command} has moved to your bridge's console, in the browser:\n\n  ${origin ?? "https://<your bridge's address>"}/console\n\n` +
    "Sign in there with the bridge's SweatStack client secret.",
);
