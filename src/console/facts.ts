import packageJson from "../../package.json";
import { readConfig, setting } from "../config";
import { Database, SEEN, type Activity } from "../db";
import type { Deps } from "../deps";
import { allProviders } from "../providers";
import type { Capability, PlatformGuide, Provider } from "../providers/types";
import { checkCredentials, type CredentialsCheck } from "../sweatstack";
import { latestRelease } from "./releases";
import { loadWalk, walkSteps, type Walk } from "./verification";

/**
 * Every fact the console shows, read in one place. The pages are pure functions of these.
 * It works with any configuration, including none: each setting is read on its own.
 */
export interface Facts {
  now: number;
  /** Where the owner reached the bridge: every URL to paste starts here. */
  origin: string;
  version: string;
  /** The newest release: null when there's none, undefined when GitHub couldn't say. */
  latestRelease: string | null | undefined;
  /** What's wrong with the settings, by name. Never a secret's value. */
  settingProblems: readonly string[];
  /** SweatStack's address and the app's Client ID, for links to its tabs. Null until both are set. */
  sweatstack: { url: string; clientId: string } | null;
  /** Null while SweatStack's settings are incomplete, so there's nothing to check. */
  credentials: CredentialsCheck | null;
  platform: PlatformFacts;
  activity: Activity;
  /** The verification walk, if the platform has one and the owner started it, with where it is. */
  walk: { saved: Walk; number: number; of: number } | null;
}

export interface PlatformFacts {
  /** The path segment of its routes. */
  name: string;
  guide: PlatformGuide;
  offers: ReadonlySet<Capability>;
  /** The platform's settings that aren't set, by name. */
  missingSettings: readonly string[];
  /** In every webhook URL. Null only before the first migration. */
  webhookSecret: string | null;
  /** When a sign-in last completed: the platform accepted the keys and the redirect URL. */
  lastConsent: number | null;
  /** When each webhook last accepted a push, by its path segment. */
  lastPush: ReadonlyMap<string, number>;
  /** When SweatStack registered with the bridge: it's pointed here. */
  registeredAt: number | null;
}

/** The bridge guides the owner through one platform: the one it has. A second would get its own steps. */
export function consolePlatform(deps: Deps): Provider {
  const [provider] = allProviders(deps);
  if (provider === undefined) throw new Error("The bridge has no platform");
  return provider;
}

export async function gatherFacts(deps: Deps, origin: string): Promise<Facts> {
  const db = new Database(deps.env.DB);
  const provider = consolePlatform(deps);

  const full = readConfig(deps.env, provider);
  // SweatStack's settings alone, which are enough to check its credentials.
  const sweatstackOnly = readConfig(deps.env, { requiredSettings: [] });
  const clientId = setting(deps.env, "SWEATSTACK_CLIENT_ID") ?? setting(deps.env, "SWEATSTACK_APP_ID");

  const [credentials, release, seen, client, webhookSecret, activity, saved] = await Promise.all([
    sweatstackOnly.ok ? checkCredentials({ config: sweatstackOnly.config, db, deps }) : null,
    latestRelease(db, deps),
    db.seen(),
    db.client(provider.name),
    db.meta("webhook_secret"),
    db.activity(provider.name),
    loadWalk(db),
  ]);
  const steps = provider.guide.verification === undefined ? [] : walkSteps(provider.guide.verification, provider.offeredCapabilities());

  const pushPrefix = SEEN.push(provider.name, "");
  return {
    now: deps.now(),
    origin,
    version: packageJson.version,
    latestRelease: release,
    settingProblems: full.ok ? [] : full.problems,
    sweatstack: sweatstackOnly.ok && clientId !== undefined ? { url: sweatstackOnly.config.sweatstackUrl, clientId } : null,
    credentials,
    platform: {
      name: provider.name,
      guide: provider.guide,
      offers: provider.offeredCapabilities(),
      missingSettings: provider.requiredSettings.filter((name) => setting(deps.env, name) === undefined),
      webhookSecret,
      lastConsent: seen.get(SEEN.consent(provider.name)) ?? null,
      lastPush: new Map([...seen].filter(([key]) => key.startsWith(pushPrefix)).map(([key, at]) => [key.slice(pushPrefix.length), at])),
      registeredAt: client?.registered_at ?? null,
    },
    activity,
    walk: saved === null || steps.length === 0 ? null : { saved, number: steps.findIndex((step) => step.id === saved.step) + 1, of: steps.length },
  };
}
