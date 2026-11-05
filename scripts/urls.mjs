#!/usr/bin/env node
// Prints every URL to paste, and checks the bridge answers on it. The webhook URLs hold a secret, so
// keep the output private. `--origin https://...` overrides the address found through Cloudflare.
import { unstable_readConfig } from "wrangler";
import { customDomain, urlsToPaste } from "./lib/urls.mjs";
import { wrangler } from "./lib/wrangler.mjs";

function stop(message) {
  console.error(message);
  process.exit(1);
}

function originFlag() {
  const at = process.argv.indexOf("--origin");
  if (at === -1) return null;
  const value = process.argv[at + 1];
  if (!value?.startsWith("https://")) stop("--origin takes an address starting with https://");
  return value.replace(/\/+$/, "");
}

/** The account's workers.dev address, which only Cloudflare knows. */
async function workersDevOrigin(config) {
  const accounts = JSON.parse(wrangler(["whoami", "--json"], { capture: true }).stdout).accounts ?? [];
  if (!config.account_id && accounts.length !== 1) {
    stop("This login has more than one Cloudflare account. Set account_id in wrangler.jsonc, or use --origin https://...");
  }
  const accountId = config.account_id ?? accounts[0].id;
  const { token } = JSON.parse(wrangler(["auth", "token", "--json"], { capture: true }).stdout);
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) stop(`Cloudflare didn't give the workers.dev address (${response.status}). Use --origin https://...`);
  const { result } = await response.json();
  return `https://${config.name}.${result.subdomain}.workers.dev`;
}

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
const origin = originFlag() ?? customDomain(config.routes) ?? (await workersDevOrigin(config));

console.log(`Your bridge: ${origin}\nThese URLs hold a secret. Keep them private, and don't paste this output anywhere else.`);
for (const { where, urls } of urlsToPaste(origin, await webhookSecret())) {
  console.log(`\n${where}`);
  for (const entry of urls) {
    console.log(`\n  ${entry.setting}\n  ${entry.url}`);
    if (entry.check) console.log(`  ${await answer(entry)}`);
  }
}
