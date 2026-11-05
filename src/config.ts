/** What the Worker receives from Cloudflare. A platform's own settings arrive under their own names. */
export interface Env {
  DB: D1Database;
  [setting: string]: unknown;
}

export interface Config {
  sweatstackUrl: string;
  appId: string;
  clientSecret: string;
  backfillDays: number;
}

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; problems: string[] };

const DEFAULT_BACKFILL_DAYS = 90;

/**
 * Reads the settings, reporting every problem at once. The first deploy happens before the owner has
 * their keys, so an incomplete configuration is a normal state and not an error.
 */
export function readConfig(env: Env, provider: { requiredSettings: readonly string[]; settingProblems?: () => string[] }): ConfigResult {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = setting(env, name);
    if (value === undefined) problems.push(`${name} is not set`);
    return value ?? "";
  };

  const sweatstackUrl = parseSweatStackUrl(required("SWEATSTACK_URL"), problems);
  const appId = required("SWEATSTACK_APP_ID");
  const clientSecret = required("SWEATSTACK_CLIENT_SECRET");
  provider.requiredSettings.forEach(required);
  const backfillDays = parseBackfillDays(setting(env, "BACKFILL_DAYS"), problems);
  problems.push(...(provider.settingProblems?.() ?? []));

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, config: { sweatstackUrl, appId, clientSecret, backfillDays } };
}

function setting(env: Env, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function parseSweatStackUrl(value: string, problems: string[]): string {
  if (value === "") return value; // already reported as not set
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    problems.push("SWEATSTACK_URL is not a URL");
    return value;
  }
  // A bearer token goes to this address, so it can't be plain http outside a developer's own machine.
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    problems.push("SWEATSTACK_URL must use https");
  }
  return url.origin;
}

function parseBackfillDays(value: string | undefined, problems: string[]): number {
  if (value === undefined) return DEFAULT_BACKFILL_DAYS;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1) {
    problems.push("BACKFILL_DAYS must be a whole number above 0");
    return DEFAULT_BACKFILL_DAYS;
  }
  return days;
}
