import type { JobKind } from "../db";
import type { NotificationSetting } from "../providers/types";
import type { Facts } from "./facts";
import { isNewer } from "./releases";

/**
 * What the console says about setup and about what's wrong, as pure functions of the facts.
 * A step is proven by something the bridge saw happen, never by the owner saying so.
 */

/** When the step was proven, or null while it isn't yet. */
export type Proof = { at: number } | null;

export interface Setup {
  app: Proof;
  notifications: Proof;
  /** The platform's own check, which the bridge can't see yet. */
  verification: Proof;
  sweatstack: Proof;
  /** The steps left among the three that count: the verification is optional. */
  left: number;
}

export function setup(facts: Facts): Setup {
  const { platform } = facts;
  const app = platform.lastConsent === null ? null : { at: platform.lastConsent };
  const sweatstack = platform.registeredAt === null ? null : { at: platform.registeredAt };
  const notifications = notificationsProof(facts);
  return {
    app,
    notifications,
    verification: null,
    sweatstack,
    left: [app, notifications, sweatstack].filter((proof) => proof === null).length,
  };
}

/** Proven once every setting that sends without anyone acting has sent: the latest of those pushes. */
function notificationsProof(facts: Facts): Proof {
  const proving = notificationRows(facts).filter((row) => row.setting.quietUntil === undefined);
  if (proving.length === 0 || proving.some((row) => row.lastPush === null)) return null;
  return { at: Math.max(...proving.map((row) => row.lastPush as number)) };
}

export interface NotificationRow {
  setting: NotificationSetting;
  url: string;
  lastPush: number | null;
}

/** The settings this app turns on, each with its URL and when it last sent. Null URLs before the first migration. */
export function notificationRows(facts: Facts): NotificationRow[] {
  const { platform, origin } = facts;
  return platform.guide.notifications.settings
    .filter((setting) => setting.forCapability === undefined || platform.offers.has(setting.forCapability))
    .map((setting) => ({
      setting,
      url: `${origin}/${platform.name}/${platform.webhookSecret ?? ""}/${setting.webhook}`,
      lastPush: platform.lastPush.get(setting.webhook) ?? null,
    }));
}

/** The values the owner pastes, apart from the notification URLs. */
export function pasteValues(facts: Facts) {
  const { origin, platform } = facts;
  return {
    redirectUrl: `${origin}/callback/${platform.name}`,
    issuer: `${origin}/oidc/${platform.name}`,
  };
}

/** SweatStack's tabs that a fix points to. */
export type SweatStackTab = "consent" | "data-sources" | "oauth";

/** A tab of the app in SweatStack, or null until SweatStack's address and the Client ID are both set. */
export function sweatstackTab(facts: Facts, tab: SweatStackTab): string | null {
  return facts.sweatstack === null ? null : `${facts.sweatstack.url}/applications/${encodeURIComponent(facts.sweatstack.clientId)}/${tab}`;
}

/**
 * The Worker's settings in Cloudflare, where secrets are added. `:account` lets Cloudflare fill in the account,
 * so the link holds nothing about it. The Worker's name is only known on its `workers.dev` address: on a
 * custom domain, the link goes to the list of Workers.
 */
export function cloudflareSettings(origin: string): string {
  const { hostname } = new URL(origin);
  const worker = hostname.endsWith(".workers.dev") ? hostname.split(".")[0] : undefined;
  return worker === undefined
    ? "https://dash.cloudflare.com/?to=/:account/workers-and-pages"
    : `https://dash.cloudflare.com/?to=/:account/workers/services/view/${worker}/production/settings`;
}

/** Failures with one known fix. Retrying can't help with any of them: they need the owner. */
function fixFor(kind: JobKind, reason: string, platformName: string): { text: string; tab: SweatStackTab } | null {
  const tickWrite = (what: string) => ({
    text: `SweatStack refused them: your app doesn't ask to write ${what.toLowerCase()}. Tick write for ${what} under Data your app uses, on the Consent screen tab.`,
    tab: "consent" as const,
  });
  switch (`${kind}:${reason}`) {
    case "activity_file:sweatstack_400":
    case "activity_file:sweatstack_403":
      return tickWrite("Activities");
    case "wellness:sweatstack_400":
    case "wellness:sweatstack_403":
      return tickWrite("Wellness");
    case "declare:sweatstack_403":
      return { text: `Check that ${platformName} is set to Self-hosted on your app's Data sources tab, with this bridge's issuer.`, tab: "data-sources" };
    case "declare:sweatstack_409":
      return { text: `SweatStack isn't using this bridge yet. Set ${platformName} to Self-hosted on your app's Data sources tab: step 4.`, tab: "data-sources" };
    default:
      return null;
  }
}

/** What blocks everything, in the order to fix it (C4). */
export type Banner =
  | { kind: "settings"; problems: readonly string[] }
  | { kind: "signing_key" }
  | { kind: "credentials"; status: number | null }
  | { kind: "failure"; jobKind: JobKind; reason: string; count: number; latest: number; fix: string; tab: SweatStackTab }
  | { kind: "release"; latest: string };

export function banners(facts: Facts): Banner[] {
  const found: Banner[] = [];
  if (facts.settingProblems.length > 0) found.push({ kind: "settings", problems: facts.settingProblems });
  if (!facts.activity.signingKey) found.push({ kind: "signing_key" });
  if (facts.credentials !== null && !facts.credentials.accepted) found.push({ kind: "credentials", status: facts.credentials.status });
  for (const failure of facts.activity.failures) {
    const fix = fixFor(failure.kind, failure.reason, facts.platform.guide.name);
    if (fix !== null) found.push({ kind: "failure", jobKind: failure.kind, reason: failure.reason, count: failure.count, latest: failure.latest, fix: fix.text, tab: fix.tab });
  }
  if (typeof facts.latestRelease === "string" && isNewer(facts.latestRelease, facts.version)) {
    found.push({ kind: "release", latest: facts.latestRelease });
  }
  return found;
}
