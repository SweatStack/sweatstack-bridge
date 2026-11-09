#!/usr/bin/env node
// Prints every URL to paste, and checks the bridge answers on it. The webhook URLs hold a secret, so
// keep the output private. `--origin https://...` overrides the address found through Cloudflare.
import { unstable_readConfig } from "wrangler";
import { CloudflareProblem, findOrigin } from "./lib/cloudflare.mjs";
import { offersWellness, urlsToPaste } from "./lib/urls.mjs";
import { wrangler } from "./lib/wrangler.mjs";

async function webhookSecret() {
  const query = "SELECT value FROM meta WHERE key = 'webhook_secret'";
  const { stdout } = wrangler(["d1", "execute", "DB", "--remote", "--json", "--command", query], { capture: true });
  return JSON.parse(stdout)[0].results[0].value;
}

/** What the bridge says on this URL. An empty ping is safe: it names nobody, so nothing is queued. */
async function answer({ url, check }) {
  try {
    const response =
      check === "webhook"
        ? await fetch(url, { method: "POST", body: "{}" })
        : await fetch(`${url}/.well-known/openid-configuration`);
    if (response.ok) return "The bridge answers.";
    return `The bridge answers ${response.status}: normal until its settings are complete, otherwise check the address.`;
  } catch (error) {
    return `The bridge doesn't answer (${error.cause?.code ?? error.message}). Is it deployed, at this address?`;
  }
}

const config = unstable_readConfig({ config: "wrangler.jsonc" });
const origin = await findOrigin(config).catch((error) => {
  if (!(error instanceof CloudflareProblem)) throw error;
  console.error(error.message);
  process.exit(1);
});

console.log(`Your bridge: ${origin}\nThese URLs hold a secret. Keep them private, and don't paste this output anywhere else.`);
const offers = { wellness: offersWellness(config.vars?.GARMIN_APP_OFFERS) };
for (const { where, urls } of urlsToPaste(origin, await webhookSecret(), offers)) {
  console.log(`\n${where}`);
  for (const entry of urls) {
    console.log(`\n  ${entry.setting}\n  ${entry.url}`);
    if (entry.check) console.log(`  ${await answer(entry)}`);
  }
}
