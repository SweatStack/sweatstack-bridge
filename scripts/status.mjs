#!/usr/bin/env node
// How this bridge is doing, read through your Cloudflare login. It prints no secrets, so it's safe to share.
// `--origin https://...` overrides the address found through Cloudflare.
import { readFileSync } from "node:fs";
import { unstable_readConfig } from "wrangler";
import { findOrigin } from "./lib/cloudflare.mjs";
import { missingSettings, STATUS_QUERIES, statusReport } from "./lib/status.mjs";
import { offersWellness } from "./lib/urls.mjs";
import { latestTag } from "./lib/versions.mjs";
import { wrangler } from "./lib/wrangler.mjs";

const RELEASES_URL = "https://api.github.com/repos/SweatStack/sweatstack-bridge/releases?per_page=100";
const TIMEOUT_MS = 10_000;

/** A failure here is one line of the report, never the end of it. */
async function get(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
}

/** The newest release, null if there are none, undefined if GitHub can't say right now. */
async function latestRelease() {
  const response = await get(RELEASES_URL, { headers: { "User-Agent": "sweatstack-bridge", Accept: "application/vnd.github+json" } });
  if (!response?.ok) return undefined;
  const releases = await response.json();
  return latestTag(releases.filter((release) => !release.draft && !release.prerelease).map((release) => release.tag_name));
}

function requiredSecrets() {
  return [...readFileSync(".dev.vars.example", "utf8").matchAll(/^([A-Z_]+)=/gm)].map(([, name]) => name);
}

function secretNames() {
  const result = wrangler(["secret", "list", "--format", "json"], { capture: true, check: false });
  return result.status === 0 ? JSON.parse(result.stdout).map(({ name }) => name) : null;
}

function readDatabase() {
  const names = Object.keys(STATUS_QUERIES);
  const command = Object.values(STATUS_QUERIES).join("; ");
  const result = wrangler(["d1", "execute", "DB", "--remote", "--json", "--command", command], { capture: true, check: false });
  if (result.status !== 0) {
    const noDatabase = /Couldn't find a D1 DB/.test(result.stdout + result.stderr);
    return { database: null, databaseProblem: noDatabase ? "none yet: the first deploy makes it" : "couldn't be read. Are you logged in? npx wrangler login" };
  }
  const answers = JSON.parse(result.stdout);
  return { database: Object.fromEntries(names.map((name, at) => [name, answers[at].results])), databaseProblem: null };
}

const config = unstable_readConfig({ config: "wrangler.jsonc" });
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

let origin = null;
let originProblem = null;
try {
  origin = await findOrigin(config);
} catch (error) {
  originProblem = error.message;
}

const sweatstackUrl = config.vars?.SWEATSTACK_URL;
const [latest, discovery, keys] = await Promise.all([
  latestRelease(),
  origin === null ? null : get(`${origin}/oidc/garmin_connect/.well-known/openid-configuration`),
  sweatstackUrl ? get(`${sweatstackUrl}/.well-known/jwks.json`) : null,
]);
const sweatstackKeys = keys?.ok === true && Array.isArray((await keys.json().catch(() => null))?.keys);

console.log(
  statusReport({
    name: config.name,
    version,
    latest,
    origin,
    originProblem,
    answer: discovery?.status ?? null,
    settings: missingSettings({ requiredSecrets: requiredSecrets(), secretNames: secretNames(), vars: config.vars }),
    sweatstackUrl,
    sweatstackKeys,
    wellnessOffered: offersWellness(config.vars?.GARMIN_APP_OFFERS),
    ...readDatabase(),
  }),
);
