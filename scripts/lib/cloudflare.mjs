import { wrangler } from "./wrangler.mjs";

/** Something the owner has to sort out on Cloudflare. The message says what. */
export class CloudflareProblem extends Error {
  name = "CloudflareProblem";
}

/** The custom domain in the Worker's configuration, if it has one. */
export function customDomain(routes = []) {
  const route = routes.find((candidate) => typeof candidate === "object" && candidate.custom_domain === true);
  return route ? `https://${route.pattern}` : null;
}

/** The account's workers.dev address, which only Cloudflare knows. */
async function workersDevOrigin(config) {
  const whoami = wrangler(["whoami", "--json"], { capture: true, check: false });
  if (whoami.status !== 0) {
    // Not always a missing login: a CLOUDFLARE_API_TOKEN in the environment or a .env file takes
    // precedence over `wrangler login`, and a bad one fails here. Show what wrangler said.
    throw new CloudflareProblem(
      `wrangler couldn't tell which Cloudflare account to use:\n${whoami.stderr}${whoami.stdout}\n` +
        "If CLOUDFLARE_API_TOKEN is set (in your shell or a .env file), it overrides npx wrangler login: fix or unset it.",
    );
  }
  const account = JSON.parse(whoami.stdout);
  if (!account.loggedIn) throw new CloudflareProblem("Run npx wrangler login first.");
  const accounts = account.accounts ?? [];
  if (!config.account_id && accounts.length !== 1) {
    throw new CloudflareProblem("This login has more than one Cloudflare account. Set account_id in wrangler.jsonc, or use --origin https://...");
  }
  const accountId = config.account_id ?? accounts[0].id;
  const { token } = JSON.parse(wrangler(["auth", "token", "--json"], { capture: true }).stdout);
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new CloudflareProblem(`Cloudflare didn't give the workers.dev address (${response.status}). Use --origin https://...`);
  const { result } = await response.json();
  return `https://${config.name}.${result.subdomain}.workers.dev`;
}

/** The bridge's address: the owner's say-so, then its custom domain, then its workers.dev address. */
export async function findOrigin(config, argv = process.argv) {
  const at = argv.indexOf("--origin");
  if (at !== -1) {
    const value = argv[at + 1];
    if (!value?.startsWith("https://")) throw new CloudflareProblem("--origin takes an address starting with https://");
    return value.replace(/\/+$/, "");
  }
  return customDomain(config.routes) ?? workersDevOrigin(config);
}
